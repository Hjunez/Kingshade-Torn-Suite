import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugOrchestratorDependencies,
  type SyntheticDebugTaskDRequest,
  type SyntheticDebugTaskFRequest,
  type SyntheticDebugTaskGRequest,
} from '../src/debug/orchestrator.js';
import type {
  SyntheticDebugImplementationPlanRecord,
  SyntheticDebugIntakeRecord,
  SyntheticDebugRootCauseRecord,
  TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';
import type { SyntheticDebugWorkerFailureCode } from '../src/debug/worker-execution.js';
import { WorkerAgentService } from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import type { WorkerJob, WorkerJobResult } from '../src/worker/contracts.js';
import { executeLocalWorkerJob } from '../src/worker/local-worker.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';
import { runProcess } from '../src/worker/process-runner.js';
import type { TestProfile } from '../src/worker/test-profiles.js';

const FIXTURE_PATH = 'fixture.txt';
const SUITE_PROFILE_ID = 'suite-layout';
const APPROVAL_TOKEN = '7'.repeat(64);
const API_SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
const NOW = new Date('2026-08-24T12:00:00.000Z');
const FIXED_PATCH = [
  'diff --git a/fixture.txt b/fixture.txt',
  '--- a/fixture.txt',
  '+++ b/fixture.txt',
  '@@ -1 +1 @@',
  '-alpha',
  '+beta',
  '',
].join('\n');

const cleanupPaths: string[] = [];

interface SyntheticRepository {
  readonly holder: string;
  readonly root: string;
  readonly workspaces: string;
  readonly baselineSha: string;
  readonly sourceBranch: string;
}

interface SourceSnapshot {
  readonly headSha: string;
  readonly branch: string;
  readonly status: string;
  readonly byteHashes: Readonly<Record<string, string>>;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited ${String(result.exitCode)}`);
  }
  return result.stdout.trim();
}

async function gitStatus(root: string): Promise<string> {
  const result = await runProcess({
    executable: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited ${String(result.exitCode)}`);
  }
  return result.stdout.trimEnd();
}

async function createRepository(): Promise<SyntheticRepository> {
  const holder = await mkdtemp(join(tmpdir(), 'ks-leslie-c3-6-'));
  cleanupPaths.push(holder);
  const root = join(holder, 'repo');
  const workspaces = join(holder, 'workspaces');
  await mkdir(join(root, 'tools'), { recursive: true });
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'ks-leslie-c3-6@example.invalid']);
  await git(root, ['config', 'user.name', 'KS Leslie C3.6']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, FIXTURE_PATH), 'alpha\n', 'utf8');
  await writeFile(
    join(root, 'tools', 'run-suite-validator.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const fixture = readFileSync('fixture.txt', 'utf8');",
      "if (fixture !== 'beta\\n') process.exit(9);",
      '',
    ].join('\n'),
    'utf8',
  );
  await git(root, ['add', FIXTURE_PATH, 'tools/run-suite-validator.mjs']);
  await git(root, ['commit', '-m', 'synthetic baseline']);
  return {
    holder,
    root,
    workspaces,
    baselineSha: await git(root, ['rev-parse', 'HEAD']),
    sourceBranch: await git(root, ['branch', '--show-current']),
  };
}

async function byteHashes(root: string): Promise<Readonly<Record<string, string>>> {
  const hashes: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (directory === root && entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const path = relative(root, absolute).replaceAll('\\', '/');
        hashes[path] = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
      }
    }
  }

  await visit(root);
  return Object.freeze(hashes);
}

async function sourceSnapshot(repository: SyntheticRepository): Promise<SourceSnapshot> {
  return {
    headSha: await git(repository.root, ['rev-parse', 'HEAD']),
    branch: await git(repository.root, ['branch', '--show-current']),
    status: await gitStatus(repository.root),
    byteHashes: await byteHashes(repository.root),
  };
}

async function expectCandidateRemoved(
  repository: SyntheticRepository,
  branch: string,
): Promise<void> {
  expect(await git(repository.root, ['branch', '--list', branch])).toBe('');
  const entries = await readdir(repository.workspaces).catch(() => [] as string[]);
  expect(entries).toEqual([]);
}

function intakeFor(caseId: string): SyntheticDebugIntakeRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INTAKE',
    caseId,
    projectId: 'synthetic',
    problem: 'A deterministic synthetic fixture still contains the baseline value.',
    affectedSurfaces: ['synthetic fixture'],
    evidenceReferences: [
      {
        evidenceId: `reproduction-${caseId}`,
        kind: 'SYNTHETIC_FIXTURE',
        reference: `fixture:${caseId}`,
      },
    ],
  };
}

function rootCauseFor(caseId: string): SyntheticDebugRootCauseRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'ROOT_CAUSE',
    caseId,
    projectId: 'synthetic',
    rootCauseId: `root-cause-${caseId}`,
    explanation: 'The bounded fixture retained the old deterministic value.',
    evidenceReferences: [`reproduction-${caseId}`],
    status: 'verified',
    confidence: 'high',
    unresolvedUncertainty: [],
  };
}

function planFor(
  caseId: string,
  baselineSha: string,
  profileId = SUITE_PROFILE_ID,
): SyntheticDebugImplementationPlanRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'IMPLEMENTATION_PLAN',
    caseId,
    projectId: 'synthetic',
    planId: `implementation-plan-${caseId}`,
    authority: 'PROPOSAL_ONLY',
    allowedPaths: [FIXTURE_PATH],
    requiredTestProfileIds: [profileId],
    boundedChangeSummary: 'Change only the bounded synthetic fixture from alpha to beta.',
    rollbackSha: baselineSha,
    rollbackRef: baselineSha,
    proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
    proposedWorkspaceId: `workspace-${caseId}`,
  };
}

function baselineFor(caseId: string, baselineSha: string): TrustedSyntheticDebugBaselineRecord {
  const sourceReference = `owner:${caseId}:baseline`;
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'BASELINE',
    caseId,
    projectId: 'synthetic',
    sourceBoundary: 'TRUSTED_APPLICATION',
    commitSha: baselineSha,
    provenance: 'owner_verification',
    sourceReference,
    ownerVerification: {
      status: 'OWNER_VERIFIED',
      evidenceReference: sourceReference,
    },
    knownBlockers: [],
  };
}

type TaskGExecutor = (request: SyntheticDebugTaskGRequest) => unknown;

function controllerFor(
  caseId: string,
  baselineSha: string,
  executeTaskG?: TaskGExecutor,
  approvalDecision: 'APPROVED' | 'DENIED' | 'CANCELLED' = 'APPROVED',
): SyntheticDebugDiscoveryController {
  const taskD: NonNullable<SyntheticDebugOrchestratorDependencies['taskD']> = {
    authorize: () => true,
    readRepositoryDiscovery: (request: SyntheticDebugTaskDRequest) => ({
      currentCandidate: {
        commitSha: baselineSha,
        observedAt: '2026-08-24T10:00:00.000Z',
        sourceReference: `repository:${request.caseId}:current`,
      },
      baselineEvidence: [],
    }),
    readAuthorizedMemoryEvidence: (request: SyntheticDebugTaskDRequest) => ({
      authorizationAppliedBeforeRanking: true,
      baselineEvidence: [
        {
          sourceReference: `owner:${request.caseId}:baseline`,
          evidence: {
            project: request.projectId,
            commitSha: baselineSha,
            state: 'verified_good',
            source: 'owner_verification',
            observedAt: '2026-08-23T10:00:00.000Z',
          },
        },
      ],
    }),
    readTrustedBaseline: () => baselineFor(caseId, baselineSha),
  };
  return createSyntheticDebugDiscoveryController({
    taskD,
    taskF: {
      readTrustedWriteApprovalDecision: (request: SyntheticDebugTaskFRequest) => ({
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'WRITE_APPROVAL_DECISION',
        sourceBoundary: 'TRUSTED_APPLICATION',
        caseId: request.caseId,
        projectId: request.projectId,
        proposalId: request.proposal.proposalId,
        decisionReferenceId: `approval-decision-${request.caseId}`,
        decision: approvalDecision,
      }),
    },
    ...(executeTaskG === undefined
      ? {}
      : {
          taskG: {
            executeApprovedSyntheticImplementation: executeTaskG,
          },
        }),
  });
}

async function pendingState(
  controller: SyntheticDebugDiscoveryController,
  caseId: string,
  baselineSha: string,
  profileId = SUITE_PROFILE_ID,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const created = controller.createCase(intakeFor(caseId));
  if (!created.ok) throw new Error(created.error.message);
  const started = controller.startDiscovery(created.snapshot);
  if (!started.ok) throw new Error(started.error.message);
  const discovered = await controller.completeDiscovery(started.snapshot);
  if (!discovered.ok) throw new Error(discovered.error.message);
  const baselineReady = await controller.resolveTrustedBaseline(discovered.snapshot);
  if (!baselineReady.ok) throw new Error(baselineReady.error.message);
  const recorded = controller.recordEvidenceAndRootCause(
    baselineReady.snapshot,
    rootCauseFor(caseId),
  );
  if (!recorded.ok) throw new Error(recorded.error.message);
  const ready = controller.evaluateImplementationGate(recorded.snapshot);
  if (!ready.ok) throw new Error(ready.error.message);
  const pending = controller.requestWriteApproval(
    ready.snapshot,
    planFor(caseId, baselineSha, profileId),
  );
  if (!pending.ok) throw new Error(pending.error.message);
  expect(pending.snapshot.machine.state).toBe('AWAITING_WRITE_APPROVAL');
  expect(pending.snapshot.workerExecution).toBeNull();
  return pending.snapshot;
}

async function approvedState(
  controller: SyntheticDebugDiscoveryController,
  caseId: string,
  baselineSha: string,
  profileId = SUITE_PROFILE_ID,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const approved = await controller.resolveWriteApproval(
    await pendingState(controller, caseId, baselineSha, profileId),
  );
  if (!approved.ok) throw new Error(approved.error.message);
  expect(approved.snapshot.machine.state).toBe('IMPLEMENTING');
  expect(approved.snapshot.writeApprovalDecision?.decision).toBe('APPROVED');
  expect(approved.snapshot.workerExecution).toBeNull();
  return approved.snapshot;
}

function serviceFor(repository: SyntheticRepository, jobId: string): WorkerAgentService {
  const policies = new WorkerPolicyRegistry([
    {
      projectId: 'synthetic',
      repositoryRoot: repository.root,
      readablePaths: [FIXTURE_PATH, 'tools/run-suite-validator.mjs'],
      writablePaths: [FIXTURE_PATH],
      allowedTestProfileIds: [SUITE_PROFILE_ID],
      requiredWriteTestProfileIds: [SUITE_PROFILE_ID],
      branchPrefix: 'ks-leslie/synthetic/',
    },
  ]);
  const approvals = new WriteApprovalStore({
    now: () => NOW,
    tokenFactory: () => APPROVAL_TOKEN,
  });
  return new WorkerAgentService({
    policies,
    approvals,
    workspaceBaseDir: repository.workspaces,
    jobIdFactory: () => jobId,
    now: () => NOW,
  });
}

async function issueBoundedApproval(
  service: WorkerAgentService,
  request: SyntheticDebugTaskGRequest,
): Promise<void> {
  expect(request.proposal.requiredTestProfileIds).toEqual([SUITE_PROFILE_ID]);
  await service.issueWriteApproval({
    projectId: request.projectId,
    baselineSha: request.proposal.baselineSha,
    baselineOwnerVerified: true,
    problemEvidenceItems: 1,
    rootCauseRecorded: true,
    branch: request.proposal.proposedIsolatedBranch,
    allowedPaths: request.proposal.approvedPaths,
    patchId: request.proposal.proposalId,
    patch: FIXED_PATCH,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
}

function customProfile(id: string, source: string): TestProfile {
  return {
    id,
    purpose: `Exercise the synthetic ${id} Worker boundary.`,
    source: 'C3.6 test fixture',
    availability: 'available',
    steps: [
      {
        executable: 'node',
        args: ['-e', source],
        workingDirectory: '.',
        timeoutMs: 10_000,
      },
    ],
  };
}

async function executeDirectWorker(
  repository: SyntheticRepository,
  request: SyntheticDebugTaskGRequest,
  profile: TestProfile,
  patch = FIXED_PATCH,
): Promise<WorkerJobResult> {
  expect(request.proposal.requiredTestProfileIds).toEqual([profile.id]);
  const approvals = new WriteApprovalStore({
    now: () => NOW,
    tokenFactory: () => APPROVAL_TOKEN,
  });
  const grant = approvals.issue({
    projectId: request.projectId,
    repositoryRoot: repository.root,
    baselineSha: request.proposal.baselineSha,
    branch: request.proposal.proposedIsolatedBranch,
    allowedPaths: request.proposal.approvedPaths,
    patchId: request.proposal.proposalId,
    patch,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const job: WorkerJob = {
    jobId: `worker-${request.caseId}`,
    mode: 'controlled_write',
    scope: {
      projectId: request.projectId,
      repositoryRoot: repository.root,
      allowedPaths: [...request.proposal.approvedPaths],
      baselineRef: request.proposal.baselineSha,
      branch: request.proposal.proposedIsolatedBranch,
    },
    approvalToken: grant.token,
    actions: [
      {
        kind: 'apply_patch',
        patchId: request.proposal.proposalId,
        expectedBaseSha: request.proposal.baselineSha,
      },
      { kind: 'run_test_profile', profileId: profile.id },
      { kind: 'finalize_candidate' },
    ],
  };
  return await executeLocalWorkerJob(job, {
    approvalStore: approvals,
    testProfiles: [profile],
    workspaceBaseDir: repository.workspaces,
    now: () => NOW,
  });
}

function recursiveKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => recursiveKeys(item));
  return Object.entries(value).flatMap(([key, child]) => [key, ...recursiveKeys(child)]);
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe('C3.6 synthetic Worker execution', () => {
  it('executes one approved patch through the existing Worker and advances only to VERIFYING', async () => {
    const repository = await createRepository();
    const caseId = 'c3-6-success';
    const service = serviceFor(repository, 'worker-c3-6-success');
    const requests: SyntheticDebugTaskGRequest[] = [];
    let calls = 0;
    const controller = controllerFor(caseId, repository.baselineSha, async (request) => {
      calls += 1;
      requests.push(request);
      await issueBoundedApproval(service, request);
      return await service.applyApprovedPatch({ projectId: request.projectId });
    });
    const pending = await pendingState(controller, caseId, repository.baselineSha);

    const beforeApproval = await controller.executeApprovedImplementation(pending);
    expect(beforeApproval).toMatchObject({
      ok: false,
      snapshot: pending,
      error: { code: 'OUT_OF_ORDER', state: 'AWAITING_WRITE_APPROVAL' },
    });
    expect(calls).toBe(0);

    const forgedApproval = structuredClone(pending);
    const forgedProposal = forgedApproval.writeProposal;
    if (forgedProposal === null) throw new Error('Expected the pending proposal');
    Object.assign(forgedApproval, {
      writeApprovalDecision: {
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'WRITE_APPROVAL_DECISION',
        sourceBoundary: 'TRUSTED_APPLICATION',
        caseId,
        projectId: 'synthetic',
        proposalId: forgedProposal.proposalId,
        decisionReferenceId: `approval-decision-forged-${caseId}`,
        decision: 'APPROVED',
      },
    });
    Object.assign(forgedApproval.machine, { state: 'IMPLEMENTING' });
    expect(await controller.executeApprovedImplementation(forgedApproval)).toMatchObject({
      ok: false,
      snapshot: forgedApproval,
      error: { code: 'WORKER_EXECUTION_INTEGRITY_MISMATCH', state: 'IMPLEMENTING' },
    });
    expect(calls).toBe(0);

    const approval = await controller.resolveWriteApproval(pending);
    if (!approval.ok) throw new Error(approval.error.message);
    const approved = approval.snapshot;
    const validatorPath = join(repository.root, 'tools', 'run-suite-validator.mjs');
    await writeFile(
      validatorPath,
      `${await readFile(validatorPath, 'utf8')}// source-only dirty state\n`,
      'utf8',
    );
    await writeFile(join(repository.root, 'source-only.tmp'), 'untracked source bytes\n', 'utf8');
    const sourceBefore = await sourceSnapshot(repository);
    const [first, replay] = await Promise.all([
      controller.executeApprovedImplementation(approved),
      controller.executeApprovedImplementation(approved),
    ]);

    expect(replay).toBe(first);
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      transition: {
        event: 'START_VERIFICATION',
        from: 'IMPLEMENTING',
        to: 'VERIFYING',
        reasons: [{ code: 'WORKER_EXECUTION_CAPTURED' }],
      },
      snapshot: {
        machine: { state: 'VERIFYING', outcome: null },
        workerExecution: {
          recordKind: 'WORKER_EXECUTION',
          status: 'SUCCEEDED',
          projectId: 'synthetic',
          baselineSha: repository.baselineSha,
          sourceHeadSha: repository.baselineSha,
          headShaBefore: repository.baselineSha,
          isolatedBranch: `ks-leslie/synthetic/${caseId}`,
          workspaceRetained: true,
          isolatedExecution: true,
          changedPaths: [FIXTURE_PATH],
          rollbackRef: repository.baselineSha,
          rollbackSha: repository.baselineSha,
          failure: null,
        },
      },
    });
    if (!first.ok || first.snapshot.workerExecution === null) {
      throw new Error('Expected a successful Worker execution record');
    }
    const execution = first.snapshot.workerExecution;
    expect(execution.jobId).toBe('worker-c3-6-success');
    expect(execution.headShaAfter).toMatch(/^[0-9a-f]{40}$/);
    expect(execution.headShaAfter).not.toBe(repository.baselineSha);
    expect(execution.candidateSha).toBe(execution.headShaAfter);
    expect(execution.actions.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'apply_patch', status: 'passed' },
      { kind: 'run_test_profile', status: 'passed' },
      { kind: 'finalize_candidate', status: 'passed' },
    ]);
    expect(
      execution.actions
        .filter((action) => action.kind === 'run_test_profile')
        .map((action) => action.profileId),
    ).toEqual([SUITE_PROFILE_ID]);
    expect(execution.actions.every((action) => !('output' in action))).toBe(true);
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.actions)).toBe(true);

    const request = requests[0];
    if (request === undefined) throw new Error('Expected one Task G request');
    expect(Object.keys(request).sort()).toEqual([
      'accessMode',
      'approvalDecisionReferenceId',
      'baselineMode',
      'caseId',
      'operation',
      'projectId',
      'proposal',
      'schemaVersion',
      'workflowKind',
    ]);
    expect(request).toMatchObject({
      accessMode: 'TRUSTED_WORKER_EXECUTION_ONLY',
      operation: 'EXECUTE_APPROVED_SYNTHETIC_IMPLEMENTATION',
      baselineMode: 'KNOWN_GOOD',
      caseId,
      projectId: 'synthetic',
      approvalDecisionReferenceId: `approval-decision-${caseId}`,
      proposal: {
        baselineSha: repository.baselineSha,
        approvedPaths: [FIXTURE_PATH],
        requiredTestProfileIds: [SUITE_PROFILE_ID],
        proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
      },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.proposal)).toBe(true);
    for (const forbiddenKey of [
      'args',
      'approvalToken',
      'command',
      'env',
      'executable',
      'grant',
      'patch',
      'process',
      'repositoryRoot',
      'testCommand',
      'token',
    ]) {
      expect(recursiveKeys(request)).not.toContain(forbiddenKey);
    }
    const publicCapture = JSON.stringify({ request, result: first });
    expect(publicCapture).not.toContain(APPROVAL_TOKEN);
    expect(publicCapture).not.toContain(repository.root);
    expect(publicCapture).not.toContain(FIXED_PATCH);

    const workspace = execution.workspaceReference;
    if (workspace === null) throw new Error('Expected a retained isolated workspace');
    const sourcePrefix = resolve(repository.root) + sep;
    expect(resolve(workspace).startsWith(sourcePrefix)).toBe(false);
    expect(await readFile(join(repository.root, FIXTURE_PATH), 'utf8')).toBe('alpha\n');
    expect(await readFile(join(workspace, FIXTURE_PATH), 'utf8')).toBe('beta\n');
    expect(await git(workspace, ['branch', '--show-current'])).toBe(
      `ks-leslie/synthetic/${caseId}`,
    );
    expect(await git(workspace, ['rev-parse', 'HEAD'])).toBe(execution.candidateSha);
    expect(await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(await sourceSnapshot(repository)).toEqual(sourceBefore);
    expect(sourceBefore).toEqual({
      headSha: repository.baselineSha,
      branch: repository.sourceBranch,
      status: ' M tools/run-suite-validator.mjs\n?? source-only.tmp',
      byteHashes: sourceBefore.byteHashes,
    });
    expect(Object.keys(sourceBefore.byteHashes).sort()).toEqual([
      FIXTURE_PATH,
      'source-only.tmp',
      'tools/run-suite-validator.mjs',
    ]);
    expect(first.snapshot.machine.history.map((transition) => transition.to)).not.toContain(
      'REVIEWING',
    );
    expect(first.snapshot.machine.history.map((transition) => transition.to)).not.toContain(
      'TEST_READY',
    );

    // @ts-expect-error Task G has no caller-selected command/root/token/patch parameter.
    const ignoredOverride = await controller.executeApprovedImplementation(approved, {
      repositoryRoot: 'untrusted-root',
      approvalToken: APPROVAL_TOKEN,
      patch: 'untrusted patch',
      command: 'untrusted command',
    });
    expect(ignoredOverride).toBe(first);
    expect(calls).toBe(1);

    const changedDecisionReplay = structuredClone(approved);
    if (changedDecisionReplay.writeApprovalDecision === null) {
      throw new Error('Expected the trusted approval decision');
    }
    Object.assign(changedDecisionReplay.writeApprovalDecision, {
      decisionReferenceId: `approval-decision-replayed-${caseId}`,
    });
    expect(await controller.executeApprovedImplementation(changedDecisionReplay)).toMatchObject({
      ok: false,
      snapshot: changedDecisionReplay,
      error: { code: 'WORKER_EXECUTION_INTEGRITY_MISMATCH', state: 'IMPLEMENTING' },
    });
    expect(calls).toBe(1);

    const deniedRepository = await createRepository();
    const deniedCaseId = 'c3-6-forged-denial';
    let deniedWorkerCalls = 0;
    const deniedController = controllerFor(
      deniedCaseId,
      deniedRepository.baselineSha,
      () => {
        deniedWorkerCalls += 1;
        throw new Error('denied execution must not reach Task G');
      },
      'DENIED',
    );
    const denied = await deniedController.resolveWriteApproval(
      await pendingState(deniedController, deniedCaseId, deniedRepository.baselineSha),
    );
    if (!denied.ok || denied.snapshot.writeApprovalDecision === null) {
      throw new Error('Expected the trusted denial');
    }
    const forgedDenied = structuredClone(denied.snapshot);
    if (forgedDenied.writeApprovalDecision === null) throw new Error('Expected a denial record');
    Object.assign(forgedDenied.writeApprovalDecision, { decision: 'APPROVED' });
    Object.assign(forgedDenied.machine, { state: 'IMPLEMENTING', outcome: null });
    expect(await deniedController.executeApprovedImplementation(forgedDenied)).toMatchObject({
      ok: false,
      snapshot: forgedDenied,
      error: { code: 'WORKER_EXECUTION_INTEGRITY_MISMATCH', state: 'IMPLEMENTING' },
    });
    expect(deniedWorkerCalls).toBe(0);
  }, 60_000);

  it('blocks an invalid baseline before Task G and a missing grant without source mutation', async () => {
    const invalidRepository = await createRepository();
    const invalidCaseId = 'c3-6-invalid-baseline';
    let invalidCalls = 0;
    const invalidController = controllerFor(invalidCaseId, invalidRepository.baselineSha, () => {
      invalidCalls += 1;
      throw new Error('unsafe execution should not run');
    });
    const approved = await approvedState(
      invalidController,
      invalidCaseId,
      invalidRepository.baselineSha,
    );
    const corrupted = structuredClone(approved);
    if (corrupted.writeProposal === null) throw new Error('Expected an approved proposal');
    Object.assign(corrupted.writeProposal, { baselineSha: 'not-a-full-sha' });
    const invalid = await invalidController.executeApprovedImplementation(corrupted);
    expect(invalid).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        workerExecution: {
          status: 'BLOCKED',
          failure: { code: 'INVALID_BASELINE' },
        },
      },
      transition: { reasons: [{ code: 'INVALID_BASELINE' }] },
    });
    expect(invalidCalls).toBe(0);

    const missingRepository = await createRepository();
    const missingCaseId = 'c3-6-missing-grant';
    const service = serviceFor(missingRepository, 'worker-missing-grant');
    let calls = 0;
    const missingController = controllerFor(
      missingCaseId,
      missingRepository.baselineSha,
      async (request) => {
        calls += 1;
        return await service.applyApprovedPatch({ projectId: request.projectId });
      },
    );
    const missingApproved = await approvedState(
      missingController,
      missingCaseId,
      missingRepository.baselineSha,
    );
    const sourceBefore = await sourceSnapshot(missingRepository);
    const missing = await missingController.executeApprovedImplementation(missingApproved);
    expect(missing).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        workerExecution: {
          status: 'BLOCKED',
          candidateSha: null,
          workspaceRetained: false,
          failure: { code: 'APPROVAL_GRANT_REJECTED' },
        },
      },
      transition: { reasons: [{ code: 'APPROVAL_GRANT_REJECTED' }] },
    });
    expect(calls).toBe(1);
    expect(await sourceSnapshot(missingRepository)).toEqual(sourceBefore);
    await expectCandidateRemoved(missingRepository, `ks-leslie/synthetic/${missingCaseId}`);
    expect(JSON.stringify(missing)).not.toContain(APPROVAL_TOKEN);

    const invalidGrantRepository = await createRepository();
    const invalidGrantCaseId = 'c3-6-invalid-grant';
    const invalidGrantController = controllerFor(
      invalidGrantCaseId,
      invalidGrantRepository.baselineSha,
      async (request) => {
        const approvals = new WriteApprovalStore({
          now: () => NOW,
          tokenFactory: () => APPROVAL_TOKEN,
        });
        const grant = approvals.issue({
          projectId: request.projectId,
          repositoryRoot: invalidGrantRepository.root,
          baselineSha: request.proposal.baselineSha,
          branch: request.proposal.proposedIsolatedBranch,
          allowedPaths: request.proposal.approvedPaths,
          patchId: request.proposal.proposalId,
          patch: FIXED_PATCH,
          expiresAt: new Date(NOW.getTime() + 60_000),
        });
        return await executeLocalWorkerJob(
          {
            jobId: 'worker-invalid-grant',
            mode: 'controlled_write',
            scope: {
              projectId: request.projectId,
              repositoryRoot: invalidGrantRepository.root,
              allowedPaths: [...request.proposal.approvedPaths],
              baselineRef: request.proposal.baselineSha,
              branch: `${request.proposal.proposedIsolatedBranch}-mismatch`,
            },
            approvalToken: grant.token,
            actions: [
              {
                kind: 'apply_patch',
                patchId: request.proposal.proposalId,
                expectedBaseSha: request.proposal.baselineSha,
              },
              { kind: 'run_test_profile', profileId: SUITE_PROFILE_ID },
              { kind: 'finalize_candidate' },
            ],
          },
          {
            approvalStore: approvals,
            workspaceBaseDir: invalidGrantRepository.workspaces,
            now: () => NOW,
          },
        );
      },
    );
    const invalidGrantApproved = await approvedState(
      invalidGrantController,
      invalidGrantCaseId,
      invalidGrantRepository.baselineSha,
    );
    const invalidGrantSource = await sourceSnapshot(invalidGrantRepository);
    const invalidGrant =
      await invalidGrantController.executeApprovedImplementation(invalidGrantApproved);
    expect(invalidGrant).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        workerExecution: {
          status: 'BLOCKED',
          candidateSha: null,
          workspaceRetained: false,
          failure: { code: 'APPROVAL_GRANT_REJECTED' },
        },
      },
      transition: { reasons: [{ code: 'APPROVAL_GRANT_REJECTED' }] },
    });
    expect(await sourceSnapshot(invalidGrantRepository)).toEqual(invalidGrantSource);
    await expectCandidateRemoved(
      invalidGrantRepository,
      `ks-leslie/synthetic/${invalidGrantCaseId}`,
    );
    await expectCandidateRemoved(
      invalidGrantRepository,
      `ks-leslie/synthetic/${invalidGrantCaseId}-mismatch`,
    );
    expect(JSON.stringify(invalidGrant)).not.toContain(APPROVAL_TOKEN);
  }, 60_000);

  it('classifies a stale approved baseline through the real Worker without changing its source boundary', async () => {
    const repository = await createRepository();
    const caseId = 'c3-6-stale-baseline';
    const service = serviceFor(repository, 'worker-stale-baseline');
    let boundarySnapshot: SourceSnapshot | undefined;
    const controller = controllerFor(caseId, repository.baselineSha, async (request) => {
      await issueBoundedApproval(service, request);
      await writeFile(join(repository.root, 'trusted-advance.txt'), 'advance\n', 'utf8');
      await git(repository.root, ['add', 'trusted-advance.txt']);
      await git(repository.root, ['commit', '-m', 'advance source before Worker']);
      boundarySnapshot = await sourceSnapshot(repository);
      return await service.applyApprovedPatch({ projectId: request.projectId });
    });
    const approved = await approvedState(controller, caseId, repository.baselineSha);
    const result = await controller.executeApprovedImplementation(approved);

    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        workerExecution: {
          status: 'BLOCKED',
          baselineSha: repository.baselineSha,
          candidateSha: null,
          failure: { code: 'STALE_BASELINE' },
        },
      },
      transition: { reasons: [{ code: 'STALE_BASELINE' }] },
    });
    if (boundarySnapshot === undefined) throw new Error('Expected the Worker boundary snapshot');
    expect(await sourceSnapshot(repository)).toEqual(boundarySnapshot);
    expect(boundarySnapshot.headSha).not.toBe(repository.baselineSha);
    await expectCandidateRemoved(repository, `ks-leslie/synthetic/${caseId}`);
  }, 60_000);

  it('classifies patch, scope, test, and candidate-integrity failures from the existing Worker', async () => {
    const scenarios: readonly {
      readonly label: string;
      readonly profile: TestProfile;
      readonly patch: string;
      readonly failureCode: SyntheticDebugWorkerFailureCode;
      readonly terminalState: 'BLOCKED' | 'FAILED';
      readonly retained: boolean;
    }[] = [
      {
        label: 'patch-rejection',
        profile: customProfile('synthetic-patch-check', 'process.exit(0)'),
        patch: [
          'diff --git a/fixture.txt b/fixture.txt',
          '--- a/fixture.txt',
          '+++ b/fixture.txt',
          '@@ -1 +1 @@',
          '-not-the-baseline',
          '+beta',
          '',
        ].join('\n'),
        failureCode: 'PATCH_REJECTED',
        terminalState: 'BLOCKED',
        retained: false,
      },
      {
        label: 'path-escape',
        profile: customProfile(
          'synthetic-path-escape',
          "require('node:fs').writeFileSync('outside.tmp','escape\\n')",
        ),
        patch: FIXED_PATCH,
        failureCode: 'PATH_SCOPE_VIOLATION',
        terminalState: 'BLOCKED',
        retained: false,
      },
      {
        label: 'test-failure',
        profile: customProfile('synthetic-test-failure', 'process.exit(7)'),
        patch: FIXED_PATCH,
        failureCode: 'TEST_PROFILE_FAILED',
        terminalState: 'BLOCKED',
        retained: true,
      },
      {
        label: 'candidate-integrity',
        profile: customProfile(
          'synthetic-candidate-integrity',
          "require('node:fs').writeFileSync('fixture.txt','gamma\\n')",
        ),
        patch: FIXED_PATCH,
        failureCode: 'CANDIDATE_INTEGRITY_FAILURE',
        terminalState: 'FAILED',
        retained: false,
      },
    ];

    for (const scenario of scenarios) {
      const repository = await createRepository();
      const caseId = `c3-6-${scenario.label}`;
      let workerResult: WorkerJobResult | undefined;
      const controller = controllerFor(caseId, repository.baselineSha, async (request) => {
        workerResult = await executeDirectWorker(
          repository,
          request,
          scenario.profile,
          scenario.patch,
        );
        return workerResult;
      });
      const approved = await approvedState(
        controller,
        caseId,
        repository.baselineSha,
        scenario.profile.id,
      );
      const sourceBefore = await sourceSnapshot(repository);
      const result = await controller.executeApprovedImplementation(approved);

      expect(result).toMatchObject({
        ok: true,
        snapshot: {
          machine: { state: scenario.terminalState, outcome: 'FAILURE' },
          workerExecution: {
            candidateSha: null,
            workspaceRetained: scenario.retained,
            failure: { code: scenario.failureCode },
          },
        },
        transition: { reasons: [{ code: scenario.failureCode }] },
      });
      if (workerResult === undefined) throw new Error('Expected the existing Worker result');
      expect(workerResult.actions.filter((action) => action.kind === 'apply_patch')).toHaveLength(
        1,
      );
      expect(await sourceSnapshot(repository)).toEqual(sourceBefore);
      expect(await git(repository.root, ['rev-parse', 'HEAD'])).toBe(repository.baselineSha);
      if (scenario.retained) {
        expect(workerResult.workspacePath).toBeDefined();
        expect(workerResult.headShaAfter).toBe(repository.baselineSha);
        expect(workerResult.changedPaths).toEqual([FIXTURE_PATH]);
      } else {
        expect(workerResult.workspaceRetained).toBe(false);
        expect(workerResult.workspacePath).toBeUndefined();
        expect(workerResult.changedPaths).toEqual([]);
        await expectCandidateRemoved(repository, `ks-leslie/synthetic/${caseId}`);
      }
    }
  }, 120_000);

  it('classifies cleanup and internal errors safely and single-flights failed attempts', async () => {
    const cases: readonly {
      readonly caseId: string;
      readonly message: string;
      readonly code: SyntheticDebugWorkerFailureCode;
    }[] = [
      {
        caseId: 'c3-6-cleanup-error',
        message: 'workspace cleanup failed: disposable candidate could not be removed',
        code: 'CLEANUP_ROLLBACK_FAILURE',
      },
      {
        caseId: 'c3-6-internal-error',
        message: `unexpected executor failure prefix${APPROVAL_TOKEN}suffix ${API_SECRET}`,
        code: 'INTERNAL_WORKER_ERROR',
      },
    ];

    for (const item of cases) {
      const repository = await createRepository();
      let calls = 0;
      const controller = controllerFor(item.caseId, repository.baselineSha, () => {
        calls += 1;
        throw new Error(item.message);
      });
      const approved = await approvedState(controller, item.caseId, repository.baselineSha);
      const sourceBefore = await sourceSnapshot(repository);
      const first = await controller.executeApprovedImplementation(approved);
      const replay = await controller.executeApprovedImplementation(approved);

      expect(replay).toBe(first);
      expect(calls).toBe(1);
      expect(first).toMatchObject({
        ok: true,
        snapshot: {
          machine: { outcome: 'FAILURE' },
          workerExecution: {
            candidateSha: null,
            failure: { code: item.code },
          },
        },
        transition: { reasons: [{ code: item.code }] },
      });
      expect(await sourceSnapshot(repository)).toEqual(sourceBefore);
      expect(JSON.stringify(first)).not.toContain(APPROVAL_TOKEN);
      expect(JSON.stringify(first)).not.toContain(API_SECRET);
      expect(first.snapshot.machine.history.map((transition) => transition.to)).not.toContain(
        'REVIEWING',
      );
      expect(first.snapshot.machine.history.map((transition) => transition.to)).not.toContain(
        'TEST_READY',
      );
    }

    const actionRepository = await createRepository();
    const actionCaseId = 'c3-6-action-redaction';
    const actionController = controllerFor(
      actionCaseId,
      actionRepository.baselineSha,
      (request) => ({
        jobId: 'worker-action-redaction',
        projectId: request.projectId,
        baselineRef: request.proposal.baselineSha,
        workspaceBranch: request.proposal.proposedIsolatedBranch,
        workspaceRetained: false,
        isolatedExecution: true,
        sourceHeadSha: request.proposal.baselineSha,
        headShaBefore: request.proposal.baselineSha,
        headShaAfter: request.proposal.baselineSha,
        changedPaths: [],
        actions: [
          {
            actionIndex: 0,
            kind: 'apply_patch',
            status: 'error',
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            summary: `stale patch baseline: HEAD is prefix${APPROVAL_TOKEN}suffix`,
            patchId: request.proposal.proposalId,
          },
        ],
      }),
    );
    const actionResult = await actionController.executeApprovedImplementation(
      await approvedState(actionController, actionCaseId, actionRepository.baselineSha),
    );
    expect(actionResult).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { workerExecution: { failure: { code: 'STALE_BASELINE' } } },
    });
    expect(JSON.stringify(actionResult)).not.toContain(APPROVAL_TOKEN);
  }, 60_000);
});
