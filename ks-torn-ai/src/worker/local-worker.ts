import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ConsumedWriteApproval, WriteApprovalStore } from './approval.js';
import type { WorkerAction, WorkerActionResult, WorkerJob, WorkerJobResult } from './contracts.js';
import {
  parseWorkerJob,
  validateWorkerJob,
  workerJobContainsWrite,
  workerJobRunsTests,
} from './contracts.js';
import { inspectPatch } from './patch-policy.js';
import { isPathAllowed, normalizeRelativeWorkerPath } from './path-policy.js';
import { runProcess, type ProcessRunResult } from './process-runner.js';
import {
  KS_LESLIE_TEST_PROFILES,
  requireAvailableTestProfile,
  type TestProfile,
} from './test-profiles.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_ACTION_OUTPUT = 1_000_000;
const SAFE_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

export interface LocalWorkerRuntime {
  approvalStore?: WriteApprovalStore;
  testProfiles?: readonly TestProfile[];
  workspaceBaseDir?: string;
  now?: () => Date;
}

interface PreparedWorkspace {
  root: string;
  holder: string;
  branch?: string;
}

interface ActionExecution {
  summary: string;
  output?: string;
  exitCode?: number;
}

export class WorkerJobRejectedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super('Worker job rejected: ' + reasons.join('; '));
    this.name = 'WorkerJobRejectedError';
    this.reasons = reasons;
  }
}

class WorkerScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerScopeViolationError';
  }
}

export function createSanitizedWorkerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  environment.CI = '1';
  environment.NO_UPDATE_NOTIFIER = '1';
  environment.TZ = 'UTC';
  environment.npm_config_audit = 'false';
  environment.npm_config_fund = 'false';
  environment.npm_config_update_notifier = 'false';
  return environment;
}

function normalizedFilesystemPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function safeExistingPath(root: string, workerPath: string): Promise<string> {
  const normalized = normalizeRelativeWorkerPath(workerPath);
  if (normalized === null) {
    throw new Error('Invalid worker path: ' + workerPath);
  }
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, normalized));
  const normalizedRoot = normalizedFilesystemPath(canonicalRoot);
  const normalizedTarget = normalizedFilesystemPath(target);
  if (!isWithinRoot(normalizedRoot, normalizedTarget)) {
    throw new Error('Resolved path escapes repository root: ' + workerPath);
  }
  return target;
}

async function git(
  root: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<ProcessRunResult> {
  return await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs,
    maxOutputBytes: MAX_ACTION_OUTPUT,
    env: createSanitizedWorkerEnvironment(),
  });
}

function requireSuccess(result: ProcessRunResult, operation: string): string {
  if (result.timedOut) {
    throw new Error(operation + ' timed out');
  }
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || 'exit ' + String(result.exitCode);
    throw new Error(operation + ' failed: ' + detail);
  }
  return result.stdout.trim();
}

async function repositoryRoot(root: string): Promise<string> {
  const requested = await realpath(root);
  const top = requireSuccess(
    await git(requested, ['rev-parse', '--show-toplevel']),
    'git rev-parse --show-toplevel',
  );
  const actual = await realpath(top);
  if (normalizedFilesystemPath(actual) !== normalizedFilesystemPath(requested)) {
    throw new Error('Worker repositoryRoot must be the Git top-level directory: ' + actual);
  }
  return actual;
}

async function currentHead(root: string): Promise<string> {
  return requireSuccess(await git(root, ['rev-parse', 'HEAD']), 'read Git HEAD');
}

export async function readLocalRepositoryHead(root: string): Promise<string> {
  return await currentHead(await repositoryRoot(root));
}

async function currentBranch(root: string): Promise<string> {
  return requireSuccess(await git(root, ['branch', '--show-current']), 'read Git branch');
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  if (ref.length === 0 || ref.startsWith('-') || containsControlCharacter(ref)) {
    throw new Error('Git ref is empty or invalid');
  }
  return requireSuccess(
    await git(root, ['rev-parse', '--verify', ref + '^{commit}']),
    'resolve Git ref ' + ref,
  );
}

async function porcelainStatus(root: string): Promise<string> {
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.timedOut) {
    throw new Error('read Git status timed out');
  }
  if (result.exitCode !== 0) {
    requireSuccess(result, 'read Git status');
  }
  return result.stdout;
}

function addStatusPath(paths: Set<string>, raw: string): void {
  const normalized = normalizeRelativeWorkerPath(raw);
  if (normalized === null) {
    throw new Error('Git status returned an unsafe path');
  }
  paths.add(normalized);
}

function changedPathsFromPorcelain(status: string): readonly string[] {
  if (status.length === 0) {
    return [];
  }
  const entries = status.split('\0').filter((entry) => entry.length > 0);
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) {
      throw new Error('Git status returned malformed porcelain output');
    }
    const code = entry.slice(0, 2);
    addStatusPath(paths, entry.slice(3));
    if (/[RC]/.test(code)) {
      const original = entries[index + 1];
      if (original === undefined) {
        throw new Error('Git status returned an incomplete rename record');
      }
      addStatusPath(paths, original);
      index += 1;
    }
  }
  return [...paths].sort();
}

async function committedChangedPaths(
  root: string,
  baselineRef: string,
  headRef: string,
): Promise<readonly string[]> {
  if (baselineRef.toLowerCase() === headRef.toLowerCase()) {
    return [];
  }
  const output = requireSuccess(
    await git(root, ['diff', '--name-only', '-z', baselineRef, headRef, '--']),
    'read committed candidate paths',
  );
  const paths = new Set<string>();
  for (const raw of output.split('\0').filter((path) => path.length > 0)) {
    addStatusPath(paths, raw);
  }
  return [...paths].sort();
}

function safeJobLabel(jobId: string): string {
  const compact = jobId
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return compact.length === 0 ? 'job' : compact;
}

function requireExternalWorkspaceBase(repository: string, workspaceBaseDir?: string): string {
  const baseDir = resolve(workspaceBaseDir ?? join(tmpdir(), 'ks-leslie-worktrees'));
  if (isWithinRoot(normalizedFilesystemPath(repository), normalizedFilesystemPath(baseDir))) {
    throw new Error('Worker workspace base must be outside the source repository');
  }
  return baseDir;
}

async function createWorkspaceHolder(
  repository: string,
  jobId: string,
  workspaceBaseDir?: string,
): Promise<{ holder: string; workspace: string }> {
  const baseDir = requireExternalWorkspaceBase(repository, workspaceBaseDir);
  await mkdir(baseDir, { recursive: true });
  const holder = await mkdtemp(join(baseDir, safeJobLabel(jobId) + '-'));
  return { holder, workspace: join(holder, 'repo') };
}

async function prepareControlledWorktree(
  repository: string,
  job: WorkerJob,
  workspaceBaseDir?: string,
): Promise<PreparedWorkspace> {
  const branch = job.scope.branch;
  if (branch === undefined) {
    throw new Error('controlled_write job has no branch');
  }
  const baseline = await resolveCommit(repository, job.scope.baselineRef);
  if (baseline.toLowerCase() !== job.scope.baselineRef.toLowerCase()) {
    throw new Error('baseline ref did not resolve exactly to requested SHA: ' + baseline);
  }
  requireSuccess(
    await git(repository, ['check-ref-format', '--branch', branch]),
    'validate Worker branch',
  );
  const exists = await git(repository, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
  if (exists.exitCode === 0) {
    throw new Error('Worker branch already exists: ' + branch);
  }
  if (exists.exitCode !== 1) {
    requireSuccess(exists, 'check Worker branch existence');
  }

  const { holder, workspace } = await createWorkspaceHolder(
    repository,
    job.jobId,
    workspaceBaseDir,
  );
  try {
    requireSuccess(
      await git(
        repository,
        ['worktree', 'add', '-b', branch, workspace, job.scope.baselineRef],
        120_000,
      ),
      'create isolated Worker worktree',
    );
    const actual = await repositoryRoot(workspace);
    const head = await currentHead(actual);
    if (head.toLowerCase() !== job.scope.baselineRef.toLowerCase()) {
      throw new Error('isolated worktree started at unexpected HEAD: ' + head);
    }
    return { root: actual, holder, branch };
  } catch (error: unknown) {
    await git(repository, ['worktree', 'remove', '--force', workspace]);
    await git(repository, ['branch', '-D', branch]);
    await rm(holder, { recursive: true, force: true });
    throw error;
  }
}

async function prepareTestWorktree(
  repository: string,
  job: WorkerJob,
  baselineSha: string,
  workspaceBaseDir?: string,
): Promise<PreparedWorkspace> {
  const { holder, workspace } = await createWorkspaceHolder(
    repository,
    job.jobId,
    workspaceBaseDir,
  );
  try {
    requireSuccess(
      await git(repository, ['worktree', 'add', '--detach', workspace, baselineSha], 120_000),
      'create isolated test worktree',
    );
    return { root: await repositoryRoot(workspace), holder };
  } catch (error: unknown) {
    await git(repository, ['worktree', 'remove', '--force', workspace]);
    await rm(holder, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupWorkspace(
  repository: string,
  workspace: PreparedWorkspace,
): Promise<readonly string[]> {
  const errors: string[] = [];
  const removeResult = await git(
    repository,
    ['worktree', 'remove', '--force', workspace.root],
    120_000,
  );
  if (removeResult.exitCode !== 0) {
    errors.push(
      removeResult.stderr.trim() ||
        removeResult.stdout.trim() ||
        'failed to remove isolated worktree',
    );
  }
  if (workspace.branch !== undefined) {
    const branchResult = await git(repository, ['branch', '-D', workspace.branch]);
    if (branchResult.exitCode !== 0) {
      errors.push(
        branchResult.stderr.trim() ||
          branchResult.stdout.trim() ||
          'failed to remove isolated branch',
      );
    }
  }
  try {
    await rm(workspace.holder, { recursive: true, force: true });
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function outputForResult(result: ProcessRunResult): string {
  const pieces: string[] = [];
  if (result.stdout.length > 0) {
    pieces.push(result.stdout.trimEnd());
  }
  if (result.stderr.length > 0) {
    pieces.push('[stderr]\n' + result.stderr.trimEnd());
  }
  if (result.outputTruncated) {
    pieces.push('[output truncated by Worker]');
  }
  return pieces.join('\n');
}

async function inspectFile(
  root: string,
  action: Extract<WorkerAction, { kind: 'inspect_file' }>,
): Promise<string> {
  const path = await safeExistingPath(root, action.path);
  const content = await readFile(path);
  if (content.byteLength > MAX_FILE_BYTES) {
    throw new Error('file exceeds Worker read limit: ' + action.path);
  }
  return content.toString('utf8');
}

async function searchText(
  root: string,
  action: Extract<WorkerAction, { kind: 'search_text' }>,
): Promise<{ output: string; matched: boolean }> {
  const paths = action.paths ?? ['.'];
  const result = await git(root, ['grep', '-n', '-F', '-e', action.query, '--', ...paths]);
  if (result.timedOut) {
    throw new Error('Git text search timed out');
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    requireSuccess(result, 'Git text search');
  }
  return { output: outputForResult(result), matched: result.exitCode === 0 };
}

async function gitHistory(
  root: string,
  action: Extract<WorkerAction, { kind: 'git_history' }>,
): Promise<string> {
  const paths = action.paths ?? ['.'];
  return requireSuccess(
    await git(root, [
      'log',
      '--max-count=' + String(action.limit),
      '--date=iso-strict',
      '--format=%H%x09%aI%x09%s',
      '--',
      ...paths,
    ]),
    'read Git history',
  );
}

async function compareRefs(
  root: string,
  job: WorkerJob,
  action: Extract<WorkerAction, { kind: 'compare_refs' }>,
): Promise<string> {
  const base = await resolveCommit(root, action.baseRef);
  const head = await resolveCommit(root, action.headRef);
  return requireSuccess(
    await git(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--stat',
      '--find-renames',
      base,
      head,
      '--',
      ...job.scope.allowedPaths,
    ]),
    'compare Git refs',
  );
}

async function runTestProfile(
  root: string,
  action: Extract<WorkerAction, { kind: 'run_test_profile' }>,
  profiles: readonly TestProfile[],
): Promise<{ output: string; exitCode: number }> {
  const profile = requireAvailableTestProfile(profiles, action.profileId);
  const outputs: string[] = [];
  for (const [index, step] of profile.steps.entries()) {
    const normalizedWorkingDirectory = normalizeRelativeWorkerPath(step.workingDirectory);
    if (normalizedWorkingDirectory === null) {
      throw new Error('test profile contains invalid working directory: ' + step.workingDirectory);
    }
    const cwd = await safeExistingPath(root, normalizedWorkingDirectory);
    const result = await runProcess({
      executable: step.executable,
      args: step.args,
      cwd,
      timeoutMs: step.timeoutMs,
      maxOutputBytes: MAX_ACTION_OUTPUT,
      env: createSanitizedWorkerEnvironment(),
    });
    outputs.push('step ' + String(index + 1) + ': ' + step.executable + ' ' + step.args.join(' '));
    const stepOutput = outputForResult(result);
    if (stepOutput.length > 0) {
      outputs.push(stepOutput);
    }
    if (result.timedOut || result.exitCode !== 0) {
      return { output: outputs.join('\n'), exitCode: result.exitCode ?? 124 };
    }
  }
  return { output: outputs.join('\n'), exitCode: 0 };
}

async function rollbackWorkerWorktree(root: string, baselineRef: string): Promise<void> {
  requireSuccess(await git(root, ['reset', '--hard', baselineRef]), 'reset rejected Worker change');
  requireSuccess(await git(root, ['clean', '-fd']), 'clean rejected Worker change');
}

async function requireScopedWorkspace(root: string, job: WorkerJob): Promise<readonly string[]> {
  const changedPaths = changedPathsFromPorcelain(await porcelainStatus(root));
  const unexpected = changedPaths.filter((path) => !isPathAllowed(path, job.scope.allowedPaths));
  if (unexpected.length > 0) {
    await rollbackWorkerWorktree(root, job.scope.baselineRef);
    throw new WorkerScopeViolationError('post-operation scope violation: ' + unexpected.join(', '));
  }
  return changedPaths;
}

interface CandidateTreeSnapshot {
  changedPaths: readonly string[];
  treeSha: string;
}

async function stageCandidateTree(root: string, job: WorkerJob): Promise<CandidateTreeSnapshot> {
  const changedPaths = await requireScopedWorkspace(root, job);
  requireSuccess(
    await git(root, ['add', '--all', '--', ...job.scope.allowedPaths]),
    'stage approved candidate tree',
  );
  const treeSha = requireSuccess(
    await git(root, ['write-tree']),
    'snapshot approved candidate tree',
  );
  if (!/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw new Error('approved candidate tree did not produce an exact Git tree SHA');
  }
  return { changedPaths, treeSha: treeSha.toLowerCase() };
}

async function requireApprovedCandidateTree(
  root: string,
  job: WorkerJob,
  approvedTreeSha: string | undefined,
): Promise<readonly string[]> {
  if (approvedTreeSha === undefined) {
    throw new Error('approved candidate tree snapshot is unavailable');
  }
  const [head, branch] = await Promise.all([currentHead(root), currentBranch(root)]);
  if (head.toLowerCase() !== job.scope.baselineRef.toLowerCase() || branch !== job.scope.branch) {
    await rollbackWorkerWorktree(root, job.scope.baselineRef);
    throw new WorkerScopeViolationError('test profile changed the approved candidate Git state');
  }
  const snapshot = await stageCandidateTree(root, job);
  if (snapshot.treeSha !== approvedTreeSha) {
    await rollbackWorkerWorktree(root, job.scope.baselineRef);
    throw new WorkerScopeViolationError('test profile changed approved candidate content');
  }
  return snapshot.changedPaths;
}

async function applyPatch(
  root: string,
  job: WorkerJob,
  action: Extract<WorkerAction, { kind: 'apply_patch' }>,
  approval: ConsumedWriteApproval,
): Promise<string> {
  const patch = approval.patch;
  const inspection = inspectPatch(patch, job.scope.allowedPaths);
  if (inspection.errors.length > 0) {
    throw new Error('patch rejected: ' + inspection.errors.join('; '));
  }
  const head = await currentHead(root);
  if (
    head.toLowerCase() !== action.expectedBaseSha.toLowerCase() ||
    head.toLowerCase() !== job.scope.baselineRef.toLowerCase()
  ) {
    throw new Error('stale patch baseline: HEAD is ' + head);
  }
  const branch = await currentBranch(root);
  if (branch !== job.scope.branch) {
    throw new Error('patch attempted on unexpected branch: ' + branch);
  }

  const temp = await mkdtemp(join(tmpdir(), 'ks-leslie-patch-'));
  const patchFile = join(temp, 'change.patch');
  try {
    await writeFile(patchFile, patch, 'utf8');
    requireSuccess(
      await git(root, ['apply', '--check', '--whitespace=error-all', patchFile]),
      'validate Git patch',
    );
    requireSuccess(
      await git(root, ['apply', '--whitespace=error-all', patchFile]),
      'apply Git patch',
    );
    await requireScopedWorkspace(root, job);
    return (
      'Applied approved patch ' +
      action.patchId +
      ' to ' +
      String(inspection.changedPaths.length) +
      ' scoped path(s).'
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function finalizeCandidate(
  root: string,
  job: WorkerJob,
  priorResults: readonly WorkerActionResult[],
  approvedTreeSha: string | undefined,
): Promise<string> {
  const patchResultIndex = priorResults.findIndex(
    (result) => result.kind === 'apply_patch' && result.status === 'passed',
  );
  const postPatchTestPassed = priorResults.some(
    (result, index) =>
      index > patchResultIndex && result.kind === 'run_test_profile' && result.status === 'passed',
  );
  if (patchResultIndex < 0 || !postPatchTestPassed) {
    throw new Error('candidate finalization requires a passed patch and post-patch test profile');
  }
  const changedPaths = await requireApprovedCandidateTree(root, job, approvedTreeSha);
  const patchId = job.actions.find((action) => action.kind === 'apply_patch')?.patchId;
  const message = 'KS Leslie candidate ' + (patchId ?? job.jobId);
  requireSuccess(
    await git(root, [
      '-c',
      'user.name=KS Leslie Worker',
      '-c',
      'user.email=ks-leslie-worker@example.invalid',
      'commit',
      '--no-gpg-sign',
      '--no-verify',
      '-m',
      message,
      '--',
      ...changedPaths,
    ]),
    'commit candidate changes',
  );
  const remaining = changedPathsFromPorcelain(await porcelainStatus(root));
  if (remaining.length > 0) {
    throw new Error('candidate finalization left uncommitted paths: ' + remaining.join(', '));
  }
  return 'Finalized candidate commit ' + (await currentHead(root)) + '.';
}

async function executeAction(
  root: string,
  job: WorkerJob,
  action: WorkerAction,
  runtime: LocalWorkerRuntime,
  approval: ConsumedWriteApproval | undefined,
  priorResults: readonly WorkerActionResult[],
  approvedTreeSha: string | undefined,
): Promise<ActionExecution> {
  switch (action.kind) {
    case 'inspect_file':
      return { summary: 'Read ' + action.path + '.', output: await inspectFile(root, action) };
    case 'search_text': {
      const result = await searchText(root, action);
      return {
        summary: result.matched
          ? 'Search completed with matches.'
          : 'Search completed with no matches.',
        output: result.output,
      };
    }
    case 'git_history':
      return { summary: 'Git history inspected.', output: await gitHistory(root, action) };
    case 'compare_refs':
      return {
        summary: 'Compared ' + action.baseRef + ' to ' + action.headRef + '.',
        output: await compareRefs(root, job, action),
      };
    case 'run_test_profile': {
      const result = await runTestProfile(
        root,
        action,
        runtime.testProfiles ?? KS_LESLIE_TEST_PROFILES,
      );
      return {
        summary:
          result.exitCode === 0
            ? 'Test profile ' + action.profileId + ' passed.'
            : 'Test profile ' + action.profileId + ' failed.',
        output: result.output,
        exitCode: result.exitCode,
      };
    }
    case 'apply_patch': {
      if (approval === undefined) {
        throw new Error('approved patch payload is unavailable');
      }
      return { summary: await applyPatch(root, job, action, approval) };
    }
    case 'finalize_candidate':
      return { summary: await finalizeCandidate(root, job, priorResults, approvedTreeSha) };
  }
}

function actionMetadata(action: WorkerAction): Pick<WorkerActionResult, 'profileId' | 'patchId'> {
  if (action.kind === 'run_test_profile') {
    return { profileId: action.profileId };
  }
  if (action.kind === 'apply_patch') {
    return { patchId: action.patchId };
  }
  return {};
}

export async function executeLocalWorkerJob(
  input: unknown,
  runtime: LocalWorkerRuntime = {},
): Promise<WorkerJobResult> {
  const job = parseWorkerJob(input);
  const validationErrors = validateWorkerJob(job);
  if (validationErrors.length > 0) {
    throw new WorkerJobRejectedError(validationErrors);
  }

  const sourceRoot = await repositoryRoot(job.scope.repositoryRoot);
  const sourceHeadSha = await currentHead(sourceRoot);
  const hasWrite = workerJobContainsWrite(job);
  const runsTests = workerJobRunsTests(job);
  let approval: ConsumedWriteApproval | undefined;
  if (hasWrite) {
    if (runtime.approvalStore === undefined || job.approvalToken === undefined) {
      throw new WorkerJobRejectedError(['write approval verifier is unavailable']);
    }
    approval = runtime.approvalStore.consumeForJob(job.approvalToken, job);
    if (sourceHeadSha.toLowerCase() !== job.scope.baselineRef.toLowerCase()) {
      throw new WorkerJobRejectedError([
        'stale baseline: approved ' + job.scope.baselineRef + ', current ' + sourceHeadSha,
      ]);
    }
  }

  let workspace: PreparedWorkspace | undefined;
  if (hasWrite) {
    workspace = await prepareControlledWorktree(sourceRoot, job, runtime.workspaceBaseDir);
  } else if (runsTests) {
    const baseline = await resolveCommit(sourceRoot, job.scope.baselineRef);
    if (baseline.toLowerCase() !== sourceHeadSha.toLowerCase()) {
      throw new WorkerJobRejectedError([
        'test profile baseline is stale: resolved ' + baseline + ', current ' + sourceHeadSha,
      ]);
    }
    workspace = await prepareTestWorktree(sourceRoot, job, baseline, runtime.workspaceBaseDir);
  }

  const workspaceRoot = workspace?.root ?? sourceRoot;
  const headShaBefore = await currentHead(workspaceRoot);
  const now = runtime.now ?? (() => new Date());
  const actions: WorkerActionResult[] = [];
  let cleanupControlledWorkspace = false;
  let approvedTreeSha: string | undefined;

  for (const [actionIndex, action] of job.actions.entries()) {
    const startedAt = now().toISOString();
    try {
      const result = await executeAction(
        workspaceRoot,
        job,
        action,
        runtime,
        approval,
        actions,
        approvedTreeSha,
      );
      if (hasWrite && action.kind === 'apply_patch') {
        const snapshot = await stageCandidateTree(workspaceRoot, job);
        if (snapshot.changedPaths.length === 0) {
          throw new Error('approved patch produced no scoped changes');
        }
        approvedTreeSha = snapshot.treeSha;
      }
      if (hasWrite && action.kind === 'run_test_profile') {
        await requireApprovedCandidateTree(workspaceRoot, job, approvedTreeSha);
      }
      const failed = result.exitCode !== undefined && result.exitCode !== 0;
      actions.push({
        actionIndex,
        kind: action.kind,
        status: failed ? 'failed' : 'passed',
        startedAt,
        finishedAt: now().toISOString(),
        summary: result.summary,
        ...actionMetadata(action),
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.output === undefined ? {} : { output: result.output }),
      });
      if (failed) {
        break;
      }
    } catch (error: unknown) {
      actions.push({
        actionIndex,
        kind: action.kind,
        status: 'error',
        startedAt,
        finishedAt: now().toISOString(),
        summary: error instanceof Error ? error.message : String(error),
        ...actionMetadata(action),
      });
      if (action.kind === 'apply_patch' || error instanceof WorkerScopeViolationError) {
        cleanupControlledWorkspace = hasWrite;
      }
      break;
    }
  }

  const headShaAfter = await currentHead(workspaceRoot);
  const workingPaths = changedPathsFromPorcelain(await porcelainStatus(workspaceRoot));
  const committedPaths = await committedChangedPaths(
    workspaceRoot,
    job.scope.baselineRef,
    headShaAfter,
  );
  const changedPaths = hasWrite ? [...new Set([...workingPaths, ...committedPaths])].sort() : [];

  let workspaceRetained = hasWrite && workspace !== undefined;
  if (workspace !== undefined && (!hasWrite || cleanupControlledWorkspace)) {
    const cleanupErrors = await cleanupWorkspace(sourceRoot, workspace);
    workspaceRetained = cleanupErrors.length > 0;
    if (cleanupErrors.length > 0) {
      const last = actions.at(-1);
      if (last !== undefined) {
        last.status = 'error';
        last.summary += '; workspace cleanup failed: ' + cleanupErrors.join('; ');
      }
    }
  }

  return {
    jobId: job.jobId,
    projectId: job.scope.projectId,
    baselineRef: job.scope.baselineRef,
    ...(job.scope.branch === undefined ? {} : { workspaceBranch: job.scope.branch }),
    ...(workspaceRetained && workspace !== undefined ? { workspacePath: workspace.root } : {}),
    workspaceRetained,
    isolatedExecution: workspace !== undefined,
    sourceHeadSha,
    headShaBefore,
    headShaAfter,
    changedPaths,
    actions,
  };
}
