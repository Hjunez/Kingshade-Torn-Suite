import { describe, expect, it } from 'vitest';

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
import {
  verifySyntheticDebugWorkerExecution,
  type SyntheticDebugVerificationInput,
} from '../src/debug/verification.js';
import type { SyntheticDebugWorkerExecutionRecord } from '../src/debug/worker-execution.js';
import type { WorkerActionResult, WorkerJobResult } from '../src/worker/contracts.js';

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

type MutableWorkerExecutionRecord = DeepMutable<SyntheticDebugWorkerExecutionRecord>;

const BASELINE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const PROFILE_ID = 'synthetic-check';
const FIXTURE_PATH = 'fixture.txt';
const ACTION_TIME = '2026-08-24T12:00:00.000Z';
const APPROVAL_SECRET = '7'.repeat(64);
const API_SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

interface ControllerHarness {
  readonly controller: SyntheticDebugDiscoveryController;
  readonly workerCalls: () => number;
}

function intake(caseId: string): SyntheticDebugIntakeRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INTAKE',
    caseId,
    projectId: 'synthetic',
    problem: 'The bounded synthetic fixture still contains its baseline value.',
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

function rootCause(caseId: string): SyntheticDebugRootCauseRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'ROOT_CAUSE',
    caseId,
    projectId: 'synthetic',
    rootCauseId: `root-cause-${caseId}`,
    explanation: 'The fixture retained the old deterministic value.',
    evidenceReferences: [`reproduction-${caseId}`],
    status: 'verified',
    confidence: 'high',
    unresolvedUncertainty: [],
  };
}

function implementationPlan(caseId: string): SyntheticDebugImplementationPlanRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'IMPLEMENTATION_PLAN',
    caseId,
    projectId: 'synthetic',
    planId: `implementation-plan-${caseId}`,
    authority: 'PROPOSAL_ONLY',
    allowedPaths: [FIXTURE_PATH],
    requiredTestProfileIds: [PROFILE_ID],
    boundedChangeSummary: 'Change only the bounded synthetic fixture.',
    rollbackSha: BASELINE_SHA,
    rollbackRef: BASELINE_SHA,
    proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
    proposedWorkspaceId: `workspace-${caseId}`,
  };
}

function baseline(caseId: string): TrustedSyntheticDebugBaselineRecord {
  const sourceReference = `owner:${caseId}:baseline`;
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'BASELINE',
    caseId,
    projectId: 'synthetic',
    sourceBoundary: 'TRUSTED_APPLICATION',
    commitSha: BASELINE_SHA,
    provenance: 'owner_verification',
    sourceReference,
    ownerVerification: {
      status: 'OWNER_VERIFIED',
      evidenceReference: sourceReference,
    },
    knownBlockers: [],
  };
}

function action(
  actionIndex: number,
  kind: WorkerActionResult['kind'],
  status: WorkerActionResult['status'] = 'passed',
  extra: Pick<WorkerActionResult, 'profileId' | 'patchId'> = {},
): WorkerActionResult {
  return {
    actionIndex,
    kind,
    status,
    startedAt: ACTION_TIME,
    finishedAt: ACTION_TIME,
    summary: `${kind} ${status}`,
    ...extra,
  };
}

function successfulWorkerResult(request: SyntheticDebugTaskGRequest): WorkerJobResult {
  return {
    jobId: `worker-${request.caseId}`,
    projectId: request.projectId,
    baselineRef: request.proposal.baselineSha,
    workspaceBranch: request.proposal.proposedIsolatedBranch,
    workspacePath: `C:/synthetic-workspaces/${request.caseId}`,
    workspaceRetained: true,
    isolatedExecution: true,
    sourceHeadSha: request.proposal.baselineSha,
    headShaBefore: request.proposal.baselineSha,
    headShaAfter: CANDIDATE_SHA,
    changedPaths: [FIXTURE_PATH],
    actions: [
      action(0, 'apply_patch', 'passed', { patchId: request.proposal.proposalId }),
      action(1, 'run_test_profile', 'passed', { profileId: PROFILE_ID }),
      action(2, 'finalize_candidate'),
    ],
  };
}

function controllerHarness(caseId: string): ControllerHarness {
  let workerCalls = 0;
  const taskD: NonNullable<SyntheticDebugOrchestratorDependencies['taskD']> = {
    authorize: () => true,
    readRepositoryDiscovery: (request: SyntheticDebugTaskDRequest) => ({
      currentCandidate: {
        commitSha: BASELINE_SHA,
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
            commitSha: BASELINE_SHA,
            state: 'verified_good',
            source: 'owner_verification',
            observedAt: '2026-08-23T10:00:00.000Z',
          },
        },
      ],
    }),
    readTrustedBaseline: () => baseline(caseId),
  };
  const controller = createSyntheticDebugDiscoveryController({
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
        decision: 'APPROVED',
      }),
    },
    taskG: {
      executeApprovedSyntheticImplementation: (request: SyntheticDebugTaskGRequest) => {
        workerCalls += 1;
        return successfulWorkerResult(request);
      },
    },
  });
  return { controller, workerCalls: () => workerCalls };
}

async function verifyingSnapshot(
  controller: SyntheticDebugDiscoveryController,
  caseId: string,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const created = controller.createCase(intake(caseId));
  if (!created.ok) throw new Error(created.error.message);
  const started = controller.startDiscovery(created.snapshot);
  if (!started.ok) throw new Error(started.error.message);
  const discovered = await controller.completeDiscovery(started.snapshot);
  if (!discovered.ok) throw new Error(discovered.error.message);
  const baselineReady = await controller.resolveTrustedBaseline(discovered.snapshot);
  if (!baselineReady.ok) throw new Error(baselineReady.error.message);
  const recorded = controller.recordEvidenceAndRootCause(baselineReady.snapshot, rootCause(caseId));
  if (!recorded.ok) throw new Error(recorded.error.message);
  const ready = controller.evaluateImplementationGate(recorded.snapshot);
  if (!ready.ok) throw new Error(ready.error.message);
  const pending = controller.requestWriteApproval(ready.snapshot, implementationPlan(caseId));
  if (!pending.ok) throw new Error(pending.error.message);
  const approved = await controller.resolveWriteApproval(pending.snapshot);
  if (!approved.ok) throw new Error(approved.error.message);
  const executed = await controller.executeApprovedImplementation(approved.snapshot);
  if (!executed.ok) throw new Error(executed.error.message);
  expect(executed.snapshot.machine.state).toBe('VERIFYING');
  expect(executed.snapshot.verificationDecision).toBeNull();
  return executed.snapshot;
}

function directVerificationInput(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  workerExecution: unknown = snapshot.workerExecution,
): SyntheticDebugVerificationInput {
  if (snapshot.writeProposal === null) throw new Error('Expected a sealed proposal');
  return {
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    baselineOwnerVerified: true,
    problemEvidenceItems: 1,
    rootCauseRecorded: true,
    proposal: snapshot.writeProposal,
    workerExecution,
  };
}

function mutableWorkerRecord(
  snapshot: SyntheticDebugOrchestrationSnapshot,
): MutableWorkerExecutionRecord {
  if (snapshot.workerExecution === null) throw new Error('Expected a Worker execution record');
  return structuredClone(snapshot.workerExecution) as MutableWorkerExecutionRecord;
}

function reindex(actions: readonly MutableWorkerExecutionRecord['actions'][number][]) {
  return actions.map((item, actionIndex) => ({ ...item, actionIndex }));
}

function recursiveKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => recursiveKeys(item));
  return Object.entries(value).flatMap(([key, child]) => [key, ...recursiveKeys(child)]);
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

describe('C3.7 verification orchestration', () => {
  it('advances one trusted VERIFYING case only to REVIEWING without calling the Worker again', async () => {
    const caseId = 'c3-7-success';
    const harness = controllerHarness(caseId);
    const verifying = await verifyingSnapshot(harness.controller, caseId);
    expect(harness.workerCalls()).toBe(1);

    const [first, replay] = await Promise.all([
      harness.controller.evaluateVerification(verifying),
      harness.controller.evaluateVerification(verifying),
    ]);

    expect(replay).toBe(first);
    expect(harness.workerCalls()).toBe(1);
    expect(first).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      transition: {
        event: 'START_REVIEW',
        from: 'VERIFYING',
        to: 'REVIEWING',
        reasons: [{ code: 'PRE_REVIEW_VERIFICATION_PASSED' }],
      },
      snapshot: {
        machine: { state: 'REVIEWING', outcome: null },
        verificationDecision: {
          recordKind: 'VERIFICATION_DECISION',
          sourceBoundary: 'TRUSTED_APPLICATION',
          status: 'PASSED',
          caseId,
          projectId: 'synthetic',
          workerStatus: 'SUCCEEDED',
          baselineSha: BASELINE_SHA,
          candidateSha: CANDIDATE_SHA,
          rollbackSha: BASELINE_SHA,
          isolatedExecution: true,
          retainedWorkspaceEvidence: true,
          approvedPaths: [FIXTURE_PATH],
          changedPaths: [FIXTURE_PATH],
          requiredProfileIds: [PROFILE_ID],
          profileResults: [
            {
              actionIndex: 1,
              profileId: PROFILE_ID,
              required: true,
              status: 'passed',
            },
          ],
          blockers: [],
        },
      },
    });
    if (!first.ok || first.snapshot.verificationDecision === null) {
      throw new Error('Expected a passing verification decision');
    }
    const verification = first.snapshot.verificationDecision;
    expect(verification.verificationDecisionId).toMatch(/^verification-decision-[0-9a-f]{64}$/);
    expectDeeplyFrozen(verification);
    expect(JSON.parse(JSON.stringify(verification))).toEqual(verification);
    expect(recursiveKeys(verification)).not.toEqual(
      expect.arrayContaining([
        'approvalToken',
        'command',
        'env',
        'output',
        'patch',
        'repositoryRoot',
        'token',
        'workspaceReference',
      ]),
    );
    expect(JSON.stringify(verification)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(verification)).not.toContain(API_SECRET);
    expect(first.snapshot.machine.history.map(({ to }) => to)).not.toContain('TEST_READY');

    // @ts-expect-error Task H accepts no model-authored verification record.
    const ignoredModelSuccess = await harness.controller.evaluateVerification(verifying, {
      status: 'PASSED',
      approvalToken: APPROVAL_SECRET,
    });
    expect(ignoredModelSuccess).toBe(first);
    expect(JSON.stringify(ignoredModelSuccess)).not.toContain(APPROVAL_SECRET);
    expect(harness.workerCalls()).toBe(1);

    const beyondReview = await harness.controller.evaluateVerification(first.snapshot);
    expect(beyondReview).toMatchObject({
      ok: false,
      snapshot: first.snapshot,
      error: { code: 'OUT_OF_ORDER', state: 'REVIEWING' },
    });
    expect(harness.workerCalls()).toBe(1);
  });

  it('accepts only the cached C3.6 case/proposal/result binding and fails closed on injection', async () => {
    const caseId = 'c3-7-binding';
    const harness = controllerHarness(caseId);
    const verifying = await verifyingSnapshot(harness.controller, caseId);

    const exactReplay = structuredClone(verifying);
    const acceptedReplay = await harness.controller.evaluateVerification(exactReplay);
    expect(acceptedReplay).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: { machine: { state: 'REVIEWING' } },
    });
    expect(harness.workerCalls()).toBe(1);

    const forgedDecision = { ...verifying } as SyntheticDebugOrchestrationSnapshot;
    Object.assign(forgedDecision, {
      verificationDecision: {
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'VERIFICATION_DECISION',
        sourceBoundary: 'TRUSTED_APPLICATION',
        status: 'PASSED',
      },
    });

    const mutations: readonly ((snapshot: SyntheticDebugOrchestrationSnapshot) => void)[] = [
      (snapshot) => Object.assign(snapshot, { caseId: 'different-case' }),
      (snapshot) => Object.assign(snapshot, { projectId: 'different-project' }),
      (snapshot) => {
        if (snapshot.writeProposal === null) throw new Error('Expected a proposal');
        Object.assign(snapshot.writeProposal, { proposalId: `write-proposal-${'d'.repeat(64)}` });
      },
      (snapshot) => {
        if (snapshot.workerExecution === null) throw new Error('Expected Worker evidence');
        Object.assign(snapshot.workerExecution, { baselineSha: OTHER_SHA });
      },
      (snapshot) => {
        if (snapshot.workerExecution === null) throw new Error('Expected Worker evidence');
        Object.assign(snapshot.workerExecution, { candidateSha: OTHER_SHA });
      },
    ];

    const forgedSnapshots = [
      forgedDecision,
      ...mutations.map((mutate) => {
        const snapshot = structuredClone(verifying);
        mutate(snapshot);
        return snapshot;
      }),
    ];
    for (const forged of forgedSnapshots) {
      const rejected = await harness.controller.evaluateVerification(forged);
      expect(rejected).toMatchObject({
        ok: true,
        status: 'FAILED',
        snapshot: { machine: { state: 'FAILED', outcome: 'FAILURE' } },
        transition: { reasons: [{ code: 'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH' }] },
      });
    }
    expect(harness.workerCalls()).toBe(1);

    const otherHarness = controllerHarness('c3-7-other-controller');
    const crossController = await otherHarness.controller.evaluateVerification(verifying);
    expect(crossController).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH' }] },
    });
    expect(otherHarness.workerCalls()).toBe(0);
  });
});

describe('C3.7 trusted Worker-result verification decision', () => {
  it('is deterministic, immutable, bounded, and contains only safe captured facts', async () => {
    const caseId = 'c3-7-decision';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const input = directVerificationInput(snapshot);
    const before = JSON.stringify(input);

    const first = verifySyntheticDebugWorkerExecution(input);
    const second = verifySyntheticDebugWorkerExecution(input);

    expect(first).toEqual(second);
    expect(first.verificationDecisionId).toBe(second.verificationDecisionId);
    expect(first.status).toBe('PASSED');
    expect(JSON.stringify(input)).toBe(before);
    expectDeeplyFrozen(first);
    expect(JSON.stringify(first).length).toBeLessThan(20_000);
    expect(recursiveKeys(first)).not.toEqual(
      expect.arrayContaining([
        'approvalToken',
        'context',
        'output',
        'patch',
        'patchId',
        'repositoryRoot',
        'summary',
        'workspaceReference',
      ]),
    );
  });

  it.each([
    {
      label: 'required profile missing',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.actions = reindex(record.actions.filter((item) => item.kind !== 'run_test_profile'));
      },
      blocker: 'required test profile was not executed: synthetic-check',
    },
    {
      label: 'required profile skipped',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const profile = record.actions.find((item) => item.kind === 'run_test_profile');
        if (profile === undefined) throw new Error('Expected a profile action');
        profile.status = 'blocked';
      },
      blocker: 'required test profile did not pass: synthetic-check',
    },
    {
      label: 'required profile failed',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const profile = record.actions.find((item) => item.kind === 'run_test_profile');
        if (profile === undefined) throw new Error('Expected a profile action');
        profile.status = 'failed';
      },
      blocker: 'one or more executed verification profiles failed',
    },
    {
      label: 'required profile errored',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const profile = record.actions.find((item) => item.kind === 'run_test_profile');
        if (profile === undefined) throw new Error('Expected a profile action');
        profile.status = 'error';
      },
      blocker: 'one or more executed verification profiles failed',
    },
    {
      label: 'duplicate required profile evidence',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const finalizer = record.actions.at(-1);
        if (finalizer === undefined) throw new Error('Expected finalization');
        record.actions = reindex([
          ...record.actions.slice(0, -1),
          {
            ...record.actions[1],
            summary: 'duplicate required profile passed',
          } as MutableWorkerExecutionRecord['actions'][number],
          finalizer,
        ]);
      },
      blocker: 'required test profile has ambiguous duplicate evidence: synthetic-check',
    },
    {
      label: 'extra failed verification',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const finalizer = record.actions.at(-1);
        if (finalizer === undefined) throw new Error('Expected finalization');
        record.actions = reindex([
          ...record.actions.slice(0, -1),
          {
            ...record.actions[1],
            profileId: 'extra-check',
            status: 'failed',
            summary: 'extra verification failed',
          } as MutableWorkerExecutionRecord['actions'][number],
          finalizer,
        ]);
      },
      blocker: 'one or more executed verification profiles failed',
    },
    {
      label: 'extra errored verification',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const finalizer = record.actions.at(-1);
        if (finalizer === undefined) throw new Error('Expected finalization');
        record.actions = reindex([
          ...record.actions.slice(0, -1),
          {
            ...record.actions[1],
            profileId: 'extra-check',
            status: 'error',
            summary: 'extra verification errored',
          } as MutableWorkerExecutionRecord['actions'][number],
          finalizer,
        ]);
      },
      blocker: 'one or more executed verification profiles failed',
    },
  ] satisfies readonly {
    readonly label: string;
    readonly mutate: (record: MutableWorkerExecutionRecord) => void;
    readonly blocker: string;
  }[])('blocks $label', async ({ mutate, blocker }) => {
    const caseId = 'c3-7-profile-matrix';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const record = mutableWorkerRecord(snapshot);
    mutate(record);

    const result = verifySyntheticDebugWorkerExecution(directVerificationInput(snapshot, record));
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.map(({ summary }) => summary)).toContain(blocker);
  });

  it('allows a passing extra profile without weakening required-profile cardinality', async () => {
    const caseId = 'c3-7-extra-pass';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const record = mutableWorkerRecord(snapshot);
    const finalizer = record.actions.at(-1);
    if (finalizer === undefined) throw new Error('Expected finalization');
    record.actions = reindex([
      ...record.actions.slice(0, -1),
      {
        ...record.actions[1],
        profileId: 'extra-check',
        summary: 'extra verification passed',
      } as MutableWorkerExecutionRecord['actions'][number],
      finalizer,
    ]);

    const result = verifySyntheticDebugWorkerExecution(directVerificationInput(snapshot, record));
    expect(result.status).toBe('PASSED');
    expect(result.profileResults).toEqual([
      { actionIndex: 1, profileId: PROFILE_ID, required: true, status: 'passed' },
      { actionIndex: 2, profileId: 'extra-check', required: false, status: 'passed' },
    ]);
  });

  it('blocks zero required profiles and an empty approved path scope through the shared gate', async () => {
    const caseId = 'c3-7-empty-gate-inputs';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const input = directVerificationInput(snapshot);
    const scenarios = [
      {
        proposal: { ...input.proposal, requiredTestProfileIds: [] },
        blocker: 'no required test profiles were declared',
      },
      {
        proposal: { ...input.proposal, approvedPaths: [] },
        blocker: 'approved path scope is missing',
      },
    ] as const;

    for (const scenario of scenarios) {
      const result = verifySyntheticDebugWorkerExecution({
        ...input,
        proposal: scenario.proposal,
      });
      expect(result.status).toBe('BLOCKED');
      expect(result.blockers.map(({ summary }) => summary)).toContain(scenario.blocker);
    }
  });

  it.each([
    {
      label: 'candidate equals baseline',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.candidateSha = BASELINE_SHA;
        record.headShaAfter = BASELINE_SHA;
      },
      status: 'BLOCKED',
      blocker: 'candidate commit is identical to the baseline',
    },
    {
      label: 'invalid candidate SHA',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.candidateSha = 'invalid-candidate';
        record.headShaAfter = 'invalid-candidate';
      },
      status: 'BLOCKED',
      blocker: 'candidate commit SHA is missing or invalid',
    },
    {
      label: 'rollback mismatch',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.rollbackSha = OTHER_SHA;
      },
      status: 'BLOCKED',
      blocker: 'rollback commit does not match the verified baseline',
    },
    {
      label: 'missing isolated branch evidence',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.isolatedBranch = null;
      },
      status: 'BLOCKED',
      blocker: 'no isolated branch or workspace',
    },
    {
      label: 'zero changed paths',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.changedPaths = [];
      },
      status: 'BLOCKED',
      blocker: 'no bounded code change recorded',
    },
    {
      label: 'scope escape',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.changedPaths = [FIXTURE_PATH, 'outside.txt'];
      },
      status: 'BLOCKED',
      blocker: 'candidate changed paths outside approval: outside.txt',
    },
    {
      label: 'candidate/head mismatch',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.candidateSha = OTHER_SHA;
      },
      status: 'FAILED',
      blocker: 'The captured candidate does not match the Worker finalization result.',
    },
    {
      label: 'baseline/proposal mismatch',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.baselineSha = OTHER_SHA;
      },
      status: 'FAILED',
      blocker: 'The captured Worker baseline does not match the sealed proposal baseline.',
    },
  ] satisfies readonly {
    readonly label: string;
    readonly mutate: (record: MutableWorkerExecutionRecord) => void;
    readonly status: 'BLOCKED' | 'FAILED';
    readonly blocker: string;
  }[])('rejects $label', async ({ mutate, status, blocker }) => {
    const caseId = 'c3-7-candidate-matrix';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const record = mutableWorkerRecord(snapshot);
    mutate(record);

    const result = verifySyntheticDebugWorkerExecution(directVerificationInput(snapshot, record));
    expect(result.status).toBe(status);
    expect(result.blockers.map(({ summary }) => summary)).toContain(blocker);
  });

  it.each([
    {
      label: 'missing finalization',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.actions = reindex(
          record.actions.filter((item) => item.kind !== 'finalize_candidate'),
        );
      },
    },
    {
      label: 'failed finalization',
      mutate: (record: MutableWorkerExecutionRecord) => {
        const finalizer = record.actions.find((item) => item.kind === 'finalize_candidate');
        if (finalizer === undefined) throw new Error('Expected finalization');
        finalizer.status = 'failed';
      },
    },
    {
      label: 'missing retained workspace evidence',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.workspaceReference = null;
      },
    },
    {
      label: 'non-isolated execution',
      mutate: (record: MutableWorkerExecutionRecord) => {
        record.isolatedExecution = false;
      },
    },
  ] satisfies readonly {
    readonly label: string;
    readonly mutate: (record: MutableWorkerExecutionRecord) => void;
  }[])('blocks $label', async ({ mutate }) => {
    const caseId = 'c3-7-finalization-matrix';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const record = mutableWorkerRecord(snapshot);
    mutate(record);

    const result = verifySyntheticDebugWorkerExecution(directVerificationInput(snapshot, record));
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers.map(({ code }) => code)).toContain('WORKER_FINALIZATION_INCOMPLETE');
  });

  it('consumes C3.6 candidate-integrity failure and rejects malformed action evidence', async () => {
    const caseId = 'c3-7-integrity';
    const harness = controllerHarness(caseId);
    const snapshot = await verifyingSnapshot(harness.controller, caseId);
    const failedRecord = mutableWorkerRecord(snapshot);
    failedRecord.status = 'FAILED';
    failedRecord.candidateSha = null;
    failedRecord.failure = {
      code: 'CANDIDATE_INTEGRITY_FAILURE',
      disposition: 'FAILED',
      summary: 'The existing Worker candidate integrity check did not pass.',
      context: null,
      actionIndex: 2,
      actionKind: 'finalize_candidate',
    };
    const failed = verifySyntheticDebugWorkerExecution(
      directVerificationInput(snapshot, failedRecord),
    );
    expect(failed.status).toBe('FAILED');
    expect(failed.blockers.map(({ code }) => code)).toContain('WORKER_EXECUTION_FAILED');

    const malformedProfile = mutableWorkerRecord(snapshot);
    const profile = malformedProfile.actions.find((item) => item.kind === 'run_test_profile');
    if (profile === undefined) throw new Error('Expected a profile action');
    profile.profileId = null;
    profile.summary = `${APPROVAL_SECRET} ${API_SECRET}`;
    const malformed = verifySyntheticDebugWorkerExecution(
      directVerificationInput(snapshot, malformedProfile),
    );
    expect(malformed).toMatchObject({
      status: 'FAILED',
      blockers: [{ code: 'MALFORMED_TRUSTED_WORKER_RESULT' }],
    });
    expect(JSON.stringify(malformed)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(malformed)).not.toContain(API_SECRET);
  });
});
