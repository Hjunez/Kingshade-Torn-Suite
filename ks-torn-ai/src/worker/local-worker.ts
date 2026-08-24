import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  WorkerAction,
  WorkerActionResult,
  WorkerJob,
  WorkerJobResult,
} from './contracts.js';
import { validateWorkerJob, workerJobContainsWrite } from './contracts.js';
import { inspectPatch } from './patch-policy.js';
import { isPathAllowed, normalizeRelativeWorkerPath } from './path-policy.js';
import { runProcess, type ProcessRunResult } from './process-runner.js';
import {
  KS_LESLIE_TEST_PROFILES,
  resolveTestProfile,
  type TestProfile,
} from './test-profiles.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_ACTION_OUTPUT = 1_000_000;

export interface LocalWorkerRuntime {
  patches?: ReadonlyMap<string, string>;
  testProfiles?: readonly TestProfile[];
  workspaceBaseDir?: string;
  now?: () => Date;
}

export class WorkerJobRejectedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Worker job rejected: ${reasons.join('; ')}`);
    this.name = 'WorkerJobRejectedError';
    this.reasons = reasons;
  }
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
    throw new Error(`Invalid worker path: ${workerPath}`);
  }
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, normalized));
  const normalizedRoot = normalizedFilesystemPath(canonicalRoot);
  const normalizedTarget = normalizedFilesystemPath(target);
  if (!isWithinRoot(normalizedRoot, normalizedTarget)) {
    throw new Error(`Resolved path escapes repository root: ${workerPath}`);
  }
  return target;
}

async function git(root: string, args: readonly string[], timeoutMs = 60_000): Promise<ProcessRunResult> {
  return await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs,
    maxOutputBytes: MAX_ACTION_OUTPUT,
  });
}

function requireSuccess(result: ProcessRunResult, operation: string): string {
  if (result.timedOut) {
    throw new Error(`${operation} timed out`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    throw new Error(`${operation} failed: ${detail}`);
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
    throw new Error(`Worker repositoryRoot must be the Git top-level directory: ${actual}`);
  }
  return actual;
}

async function currentHead(root: string): Promise<string> {
  return requireSuccess(await git(root, ['rev-parse', 'HEAD']), 'read Git HEAD');
}

async function currentBranch(root: string): Promise<string> {
  return requireSuccess(await git(root, ['branch', '--show-current']), 'read Git branch');
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  if (ref.length === 0 || ref.includes('\0') || ref.startsWith('-')) {
    throw new Error('Git ref is empty or invalid');
  }
  return requireSuccess(
    await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]),
    `resolve Git ref ${ref}`,
  );
}

async function porcelainStatus(root: string): Promise<string> {
  const result = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (result.timedOut) {
    throw new Error('read Git status timed out');
  }
  if (result.exitCode !== 0) {
    requireSuccess(result, 'read Git status');
  }
  return result.stdout.trimEnd();
}

function changedPathsFromPorcelain(status: string): readonly string[] {
  if (status.length === 0) {
    return [];
  }
  const paths = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }
    const raw = line.slice(3).trim();
    const arrowIndex = raw.indexOf(' -> ');
    const path = arrowIndex >= 0 ? raw.slice(arrowIndex + 4) : raw;
    const normalized = normalizeRelativeWorkerPath(path.replace(/^"|"$/g, ''));
    if (normalized !== null) {
      paths.add(normalized);
    }
  }
  return [...paths].sort();
}

function safeJobLabel(jobId: string): string {
  const compact = jobId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return compact.length === 0 ? 'job' : compact;
}

async function prepareControlledWorktree(
  repository: string,
  job: WorkerJob,
  workspaceBaseDir?: string,
): Promise<string> {
  const branch = job.scope.branch;
  if (branch === undefined) {
    throw new Error('controlled_write job has no branch');
  }

  const baseline = await resolveCommit(repository, job.scope.baselineRef);
  if (baseline.toLowerCase() !== job.scope.baselineRef.toLowerCase()) {
    throw new Error(`baseline ref did not resolve exactly to requested SHA: ${baseline}`);
  }

  requireSuccess(
    await git(repository, ['check-ref-format', '--branch', branch]),
    'validate Worker branch',
  );

  const exists = await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.exitCode === 0) {
    throw new Error(`Worker branch already exists: ${branch}`);
  }
  if (exists.exitCode !== 1) {
    requireSuccess(exists, 'check Worker branch existence');
  }

  const baseDir = resolve(workspaceBaseDir ?? join(tmpdir(), 'ks-leslie-worktrees'));
  await mkdir(baseDir, { recursive: true });
  const holder = await mkdtemp(join(baseDir, `${safeJobLabel(job.jobId)}-`));
  const workspace = join(holder, 'repo');

  try {
    requireSuccess(
      await git(repository, ['worktree', 'add', '-b', branch, workspace, job.scope.baselineRef], 120_000),
      'create isolated Worker worktree',
    );
    const actual = await repositoryRoot(workspace);
    const head = await currentHead(actual);
    if (head.toLowerCase() !== job.scope.baselineRef.toLowerCase()) {
      throw new Error(`isolated worktree started at unexpected HEAD: ${head}`);
    }
    return actual;
  } catch (error: unknown) {
    await git(repository, ['worktree', 'remove', '--force', workspace]);
    await git(repository, ['branch', '-D', branch]);
    await rm(holder, { recursive: true, force: true });
    throw error;
  }
}

function outputForResult(result: ProcessRunResult): string {
  const pieces: string[] = [];
  if (result.stdout.length > 0) {
    pieces.push(result.stdout.trimEnd());
  }
  if (result.stderr.length > 0) {
    pieces.push(`[stderr]\n${result.stderr.trimEnd()}`);
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
    throw new Error(`file exceeds Worker read limit: ${action.path}`);
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
  if (!Number.isSafeInteger(action.limit) || action.limit < 1 || action.limit > 200) {
    throw new Error('git_history limit must be between 1 and 200');
  }
  const paths = action.paths ?? ['.'];
  return requireSuccess(
    await git(root, [
      'log',
      `--max-count=${String(action.limit)}`,
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
  action: Extract<WorkerAction, { kind: 'compare_refs' }>,
): Promise<string> {
  const base = await resolveCommit(root, action.baseRef);
  const head = await resolveCommit(root, action.headRef);
  return requireSuccess(
    await git(root, ['diff', '--stat', '--find-renames', base, head, '--']),
    'compare Git refs',
  );
}

async function runTestProfile(
  root: string,
  action: Extract<WorkerAction, { kind: 'run_test_profile' }>,
  profiles: readonly TestProfile[],
): Promise<{ output: string; exitCode: number }> {
  const profile = resolveTestProfile(profiles, action.profileId);
  if (profile === null) {
    throw new Error(`unknown test profile: ${action.profileId}`);
  }

  const outputs: string[] = [];
  for (const [index, step] of profile.steps.entries()) {
    const normalizedWorkingDirectory = normalizeRelativeWorkerPath(step.workingDirectory);
    if (normalizedWorkingDirectory === null) {
      throw new Error(`test profile contains invalid working directory: ${step.workingDirectory}`);
    }
    const cwd = await safeExistingPath(root, normalizedWorkingDirectory);
    const result = await runProcess({
      executable: step.executable,
      args: step.args,
      cwd,
      timeoutMs: step.timeoutMs,
      maxOutputBytes: MAX_ACTION_OUTPUT,
    });
    outputs.push(`step ${String(index + 1)}: ${step.executable} ${step.args.join(' ')}`);
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
  await git(root, ['reset', '--hard', baselineRef]);
  await git(root, ['clean', '-fd']);
}

async function applyPatch(
  root: string,
  job: WorkerJob,
  action: Extract<WorkerAction, { kind: 'apply_patch' }>,
  patches: ReadonlyMap<string, string>,
): Promise<string> {
  const patch = patches.get(action.patchId);
  if (patch === undefined) {
    throw new Error(`Worker patch is unavailable: ${action.patchId}`);
  }

  const inspection = inspectPatch(patch, job.scope.allowedPaths);
  if (inspection.errors.length > 0) {
    throw new Error(`patch rejected: ${inspection.errors.join('; ')}`);
  }

  const head = await currentHead(root);
  if (
    head.toLowerCase() !== action.expectedBaseSha.toLowerCase() ||
    head.toLowerCase() !== job.scope.baselineRef.toLowerCase()
  ) {
    throw new Error(`stale patch baseline: HEAD is ${head}`);
  }

  const branch = await currentBranch(root);
  if (branch !== job.scope.branch) {
    throw new Error(`patch attempted on unexpected branch: ${branch}`);
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

    const changedPaths = changedPathsFromPorcelain(await porcelainStatus(root));
    const unexpected = changedPaths.filter((path) => !isPathAllowed(path, job.scope.allowedPaths));
    if (unexpected.length > 0) {
      await rollbackWorkerWorktree(root, job.scope.baselineRef);
      throw new Error(`post-apply scope violation: ${unexpected.join(', ')}`);
    }

    return `Applied patch ${action.patchId} to ${inspection.changedPaths.length} scoped path(s).`;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function executeAction(
  root: string,
  job: WorkerJob,
  action: WorkerAction,
  runtime: LocalWorkerRuntime,
): Promise<{ summary: string; output?: string; exitCode?: number }> {
  switch (action.kind) {
    case 'inspect_file': {
      const output = await inspectFile(root, action);
      return { summary: `Read ${action.path}.`, output };
    }
    case 'search_text': {
      const result = await searchText(root, action);
      return {
        summary: result.matched ? 'Search completed with matches.' : 'Search completed with no matches.',
        output: result.output,
      };
    }
    case 'git_history': {
      const output = await gitHistory(root, action);
      return { summary: 'Git history inspected.', output };
    }
    case 'compare_refs': {
      const output = await compareRefs(root, action);
      return { summary: `Compared ${action.baseRef} to ${action.headRef}.`, output };
    }
    case 'run_test_profile': {
      const result = await runTestProfile(
        root,
        action,
        runtime.testProfiles ?? KS_LESLIE_TEST_PROFILES,
      );
      return {
        summary:
          result.exitCode === 0
            ? `Test profile ${action.profileId} passed.`
            : `Test profile ${action.profileId} failed.`,
        output: result.output,
        exitCode: result.exitCode,
      };
    }
    case 'apply_patch': {
      const summary = await applyPatch(root, job, action, runtime.patches ?? new Map());
      return { summary };
    }
  }
}

export async function executeLocalWorkerJob(
  job: WorkerJob,
  runtime: LocalWorkerRuntime = {},
): Promise<WorkerJobResult> {
  const validationErrors = validateWorkerJob(job);
  if (validationErrors.length > 0) {
    throw new WorkerJobRejectedError(validationErrors);
  }

  const sourceRoot = await repositoryRoot(job.scope.repositoryRoot);
  const headShaBefore = await currentHead(sourceRoot);
  const hasWrite = workerJobContainsWrite(job);
  const workspaceRoot = hasWrite
    ? await prepareControlledWorktree(sourceRoot, job, runtime.workspaceBaseDir)
    : sourceRoot;

  const now = runtime.now ?? (() => new Date());
  const actions: WorkerActionResult[] = [];

  for (const [actionIndex, action] of job.actions.entries()) {
    const startedAt = now().toISOString();
    try {
      const result = await executeAction(workspaceRoot, job, action, runtime);
      const failed = result.exitCode !== undefined && result.exitCode !== 0;
      actions.push({
        actionIndex,
        kind: action.kind,
        status: failed ? 'failed' : 'passed',
        startedAt,
        finishedAt: now().toISOString(),
        summary: result.summary,
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
      });
      break;
    }
  }

  const headShaAfter = await currentHead(workspaceRoot);
  const changedPaths = changedPathsFromPorcelain(await porcelainStatus(workspaceRoot));

  return {
    jobId: job.jobId,
    baselineRef: job.scope.baselineRef,
    ...(job.scope.branch === undefined ? {} : { workspaceBranch: job.scope.branch }),
    ...(hasWrite ? { workspacePath: workspaceRoot } : {}),
    headShaBefore,
    headShaAfter,
    changedPaths,
    actions,
  };
}
