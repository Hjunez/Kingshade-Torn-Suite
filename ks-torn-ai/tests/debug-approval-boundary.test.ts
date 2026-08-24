import { describe, expect, it, vi } from 'vitest';

import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugOrchestratorDependencies,
  type SyntheticDebugTaskDRequest,
  type SyntheticDebugTaskFRequest,
} from '../src/debug/orchestrator.js';
import {
  modelSyntheticDebugRecordSchema,
  parseSyntheticDebugWorkflowRecord,
  trustedSyntheticDebugApprovalDecisionSchema,
  type SyntheticDebugImplementationPlanRecord,
  type SyntheticDebugIntakeRecord,
  type SyntheticDebugRootCauseRecord,
  type TrustedSyntheticDebugApprovalDecision,
  type TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';

const BASELINE_SHA = 'a'.repeat(40);
const CURRENT_SHA = 'b'.repeat(40);
const APPROVAL_SECRET = '1'.repeat(64);
const API_SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

function intakeFor(caseId = 'synthetic-case-c3-5'): SyntheticDebugIntakeRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INTAKE',
    caseId,
    projectId: 'synthetic',
    problem: 'The synthetic fixture has a reproducible approval-boundary regression.',
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

function rootCauseFor(caseId = 'synthetic-case-c3-5'): SyntheticDebugRootCauseRecord {
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

function planFor(caseId = 'synthetic-case-c3-5'): SyntheticDebugImplementationPlanRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'IMPLEMENTATION_PLAN',
    caseId,
    projectId: 'synthetic',
    planId: `implementation-plan-${caseId}`,
    authority: 'PROPOSAL_ONLY',
    allowedPaths: ['src/zeta.ts', 'src/alpha.ts'],
    requiredTestProfileIds: ['synthetic-secondary', 'synthetic-check'],
    boundedChangeSummary: 'Change one bounded synthetic fixture value.',
    rollbackSha: BASELINE_SHA,
    rollbackRef: BASELINE_SHA,
    proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
    proposedWorkspaceId: `workspace-${caseId}`,
  };
}

function baselineFor(caseId: string, projectId: string): TrustedSyntheticDebugBaselineRecord {
  const sourceReference = `owner:${caseId}:baseline`;
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'BASELINE',
    caseId,
    projectId,
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

function decisionFor(
  request: SyntheticDebugTaskFRequest,
  decision: TrustedSyntheticDebugApprovalDecision['decision'] = 'APPROVED',
  decisionReferenceId = `approval-decision-${request.caseId}`,
): TrustedSyntheticDebugApprovalDecision {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'WRITE_APPROVAL_DECISION',
    sourceBoundary: 'TRUSTED_APPLICATION',
    caseId: request.caseId,
    projectId: request.projectId,
    proposalId: request.proposal.proposalId,
    decisionReferenceId,
    decision,
  };
}

type TaskFDecisionFactory = (request: SyntheticDebugTaskFRequest) => unknown;

interface ControllerOptions {
  readonly calls?: string[];
  readonly taskFRequests?: SyntheticDebugTaskFRequest[];
  readonly taskFDecision?: TaskFDecisionFactory;
  readonly includeTaskF?: boolean;
  readonly forbiddenRuntime?: Readonly<Record<string, () => unknown>>;
}

function controllerFor(options: ControllerOptions = {}): SyntheticDebugDiscoveryController {
  const taskD: NonNullable<SyntheticDebugOrchestratorDependencies['taskD']> = {
    authorize: vi.fn((request: SyntheticDebugTaskDRequest) => {
      options.calls?.push(`authorize:${request.operation}`);
      return true;
    }),
    readRepositoryDiscovery: vi.fn((request: SyntheticDebugTaskDRequest) => {
      options.calls?.push('repository');
      return {
        currentCandidate: {
          commitSha: CURRENT_SHA,
          observedAt: '2026-08-24T10:00:00.000Z',
          sourceReference: `repository:${request.caseId}:current`,
        },
        baselineEvidence: [],
      };
    }),
    readAuthorizedMemoryEvidence: vi.fn((request: SyntheticDebugTaskDRequest) => {
      options.calls?.push('memory');
      return {
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
      };
    }),
    readTrustedBaseline: vi.fn((request: SyntheticDebugTaskDRequest) => {
      options.calls?.push('baseline');
      return baselineFor(request.caseId, request.projectId);
    }),
  };
  const dependencies: SyntheticDebugOrchestratorDependencies & {
    readonly worker?: Readonly<Record<string, () => unknown>>;
  } = {
    taskD,
    ...(options.includeTaskF === false
      ? {}
      : {
          taskF: {
            readTrustedWriteApprovalDecision: vi.fn(async (request: SyntheticDebugTaskFRequest) => {
              options.calls?.push('task-f');
              options.taskFRequests?.push(request);
              return options.taskFDecision === undefined
                ? decisionFor(request)
                : await options.taskFDecision(request);
            }),
          },
        }),
    ...(options.forbiddenRuntime === undefined ? {} : { worker: options.forbiddenRuntime }),
  };
  return createSyntheticDebugDiscoveryController(dependencies);
}

async function baselineReadyState(
  controller: SyntheticDebugDiscoveryController,
  caseId = 'synthetic-case-c3-5',
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const created = controller.createCase(intakeFor(caseId));
  if (!created.ok) throw new Error(created.error.message);
  const started = controller.startDiscovery(created.snapshot);
  if (!started.ok) throw new Error(started.error.message);
  const discovered = await controller.completeDiscovery(started.snapshot);
  if (!discovered.ok) throw new Error(discovered.error.message);
  const resolved = await controller.resolveTrustedBaseline(discovered.snapshot);
  if (!resolved.ok) throw new Error(resolved.error.message);
  if (resolved.snapshot.machine.state !== 'BASELINE_READY') {
    throw new Error(`Expected BASELINE_READY, received ${resolved.snapshot.machine.state}`);
  }
  return resolved.snapshot;
}

async function implementationReadyState(
  controller: SyntheticDebugDiscoveryController,
  caseId = 'synthetic-case-c3-5',
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const baselineReady = await baselineReadyState(controller, caseId);
  const recorded = controller.recordEvidenceAndRootCause(baselineReady, rootCauseFor(caseId));
  if (!recorded.ok) throw new Error(recorded.error.message);
  const ready = controller.evaluateImplementationGate(recorded.snapshot);
  if (!ready.ok) throw new Error(ready.error.message);
  if (ready.snapshot.machine.state !== 'IMPLEMENTATION_READY') {
    throw new Error(`Expected IMPLEMENTATION_READY, received ${ready.snapshot.machine.state}`);
  }
  return ready.snapshot;
}

async function pendingState(
  controller: SyntheticDebugDiscoveryController,
  caseId = 'synthetic-case-c3-5',
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const proposed = controller.requestWriteApproval(
    await implementationReadyState(controller, caseId),
    planFor(caseId),
  );
  if (!proposed.ok) throw new Error(proposed.error.message);
  if (proposed.snapshot.machine.state !== 'AWAITING_WRITE_APPROVAL') {
    throw new Error(
      `Expected AWAITING_WRITE_APPROVAL, received ${proposed.snapshot.machine.state}`,
    );
  }
  return proposed.snapshot;
}

function expectC34Identity(
  before: SyntheticDebugOrchestrationSnapshot,
  after: SyntheticDebugOrchestrationSnapshot,
): void {
  expect(after.intake).toBe(before.intake);
  expect(after.discovery).toBe(before.discovery);
  expect(after.knownGoodBaseline).toBe(before.knownGoodBaseline);
  expect(after.reproducibleDefectEvidence).toBe(before.reproducibleDefectEvidence);
  expect(after.rootCause).toBe(before.rootCause);
  expect(after.implementationGate).toBe(before.implementationGate);
}

describe('C3.5 trusted write approval boundary', () => {
  it('creates one deterministic bounded non-secret proposal and awaits approval', async () => {
    const calls: string[] = [];
    const taskFRequests: SyntheticDebugTaskFRequest[] = [];
    const controller = controllerFor({ calls, taskFRequests });
    const ready = await implementationReadyState(controller);
    const input = structuredClone(planFor());
    const before = JSON.stringify(input);

    const proposed = controller.requestWriteApproval(ready, input);
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) throw new Error(proposed.error.message);
    expect(proposed).toMatchObject({
      status: 'ADVANCED',
      transition: {
        event: 'REQUEST_WRITE_APPROVAL',
        from: 'IMPLEMENTATION_READY',
        to: 'AWAITING_WRITE_APPROVAL',
        reasons: [{ code: 'BOUNDED_WRITE_PROPOSAL_CREATED' }],
      },
      snapshot: {
        machine: { state: 'AWAITING_WRITE_APPROVAL', outcome: null },
        writeApprovalDecision: null,
      },
    });
    const proposal = proposed.snapshot.writeProposal;
    expect(proposal).not.toBeNull();
    if (proposal === null) throw new Error('Expected a write proposal');
    expect(proposal).toMatchObject({
      recordKind: 'WRITE_PROPOSAL',
      caseId: ready.caseId,
      projectId: ready.projectId,
      planId: input.planId,
      baselineSha: BASELINE_SHA,
      boundedChangeSummary: input.boundedChangeSummary,
      approvedPaths: ['src/alpha.ts', 'src/zeta.ts'],
      requiredTestProfileIds: ['synthetic-check', 'synthetic-secondary'],
      rollbackSha: BASELINE_SHA,
      rollbackRef: BASELINE_SHA,
      proposedIsolatedBranch: input.proposedIsolatedBranch,
      proposedWorkspaceId: input.proposedWorkspaceId,
    });
    expect(proposal.proposalId).toMatch(/^write-proposal-[0-9a-f]{64}$/);
    expect(Object.keys(proposal).sort()).toEqual([
      'approvedPaths',
      'baselineSha',
      'boundedChangeSummary',
      'caseId',
      'planId',
      'projectId',
      'proposalId',
      'proposedIsolatedBranch',
      'proposedWorkspaceId',
      'recordKind',
      'requiredTestProfileIds',
      'rollbackRef',
      'rollbackSha',
      'schemaVersion',
      'workflowKind',
    ]);
    for (const forbidden of [
      'approvalToken',
      'token',
      'grant',
      'actorId',
      'role',
      'capabilities',
      'repositoryRoot',
      'workspacePath',
      'patch',
      'command',
      'executable',
      'args',
      'env',
    ]) {
      expect(proposal).not.toHaveProperty(forbidden);
    }
    expect(Object.isFrozen(proposed.snapshot)).toBe(true);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.approvedPaths)).toBe(true);
    expect(Object.isFrozen(proposal.requiredTestProfileIds)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expectC34Identity(ready, proposed.snapshot);
    expect(taskFRequests).toEqual([]);
    expect(calls).not.toContain('task-f');

    const equivalentPlan = { ...planFor(), allowedPaths: [...planFor().allowedPaths].reverse() };
    const replayed = controller.requestWriteApproval(ready, equivalentPlan);
    expect(replayed).toBe(proposed);
  });

  it('prevents a second proposal through pending or stale case snapshots', async () => {
    const controller = controllerFor();
    const ready = await implementationReadyState(controller);
    const first = controller.requestWriteApproval(ready, planFor());
    if (!first.ok) throw new Error(first.error.message);

    expect(controller.requestWriteApproval(first.snapshot, planFor())).toMatchObject({
      ok: false,
      snapshot: first.snapshot,
      error: { code: 'OUT_OF_ORDER', state: 'AWAITING_WRITE_APPROVAL' },
    });
    expect(
      controller.requestWriteApproval(ready, {
        ...planFor(),
        boundedChangeSummary: 'A different stale-snapshot proposal.',
      }),
    ).toMatchObject({
      ok: false,
      snapshot: ready,
      error: { code: 'WRITE_PROPOSAL_ALREADY_EXISTS', state: 'IMPLEMENTATION_READY' },
    });
    expect(controller.requestWriteApproval(ready, planFor())).toBe(first);
  });

  it('rejects model authority, foreign scope, stale baseline, and secret proposal content', async () => {
    const controller = controllerFor();
    const ready = await implementationReadyState(controller);
    const attempts = [
      {
        input: { ...planFor(), authority: 'APPROVED' },
        code: 'MALFORMED_MODEL_RECORD',
      },
      {
        input: { ...planFor(), approvalToken: APPROVAL_SECRET },
        code: 'MALFORMED_MODEL_RECORD',
      },
      {
        input: { ...planFor(), caseId: 'different-case' },
        code: 'IMPLEMENTATION_PLAN_SCOPE_MISMATCH',
      },
      {
        input: { ...planFor(), projectId: 'different-project' },
        code: 'IMPLEMENTATION_PLAN_SCOPE_MISMATCH',
      },
      {
        input: { ...planFor(), rollbackSha: 'c'.repeat(40) },
        code: 'IMPLEMENTATION_PLAN_BASELINE_MISMATCH',
      },
      {
        input: { ...planFor(), boundedChangeSummary: `Credential ${API_SECRET}` },
        code: 'SENSITIVE_WRITE_PROPOSAL',
      },
      {
        input: { ...planFor(), boundedChangeSummary: `Opaque grant ${APPROVAL_SECRET}` },
        code: 'SENSITIVE_WRITE_PROPOSAL',
      },
    ];

    for (const attempt of attempts) {
      const result = controller.requestWriteApproval(ready, attempt.input);
      expect(result).toMatchObject({
        ok: false,
        snapshot: ready,
        error: { code: attempt.code, state: 'IMPLEMENTATION_READY' },
      });
      expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
      expect(JSON.stringify(result)).not.toContain(API_SECRET);
    }

    const corrupted = structuredClone(ready);
    if (corrupted.implementationGate === null) throw new Error('Expected an implementation gate');
    Object.assign(corrupted.implementationGate, { allowed: false, blockers: ['tampered'] });
    expect(controller.requestWriteApproval(corrupted, planFor())).toMatchObject({
      ok: false,
      snapshot: corrupted,
      error: { code: 'IMPLEMENTATION_GATE_INVARIANT' },
    });
  });

  it('keeps proposals and trusted decisions outside the model record boundary', async () => {
    const controller = controllerFor();
    const pending = await pendingState(controller);
    const proposal = pending.writeProposal;
    if (proposal === null) throw new Error('Expected a write proposal');
    const request = {
      schemaVersion: '1.0' as const,
      workflowKind: 'synthetic' as const,
      accessMode: 'TRUSTED_APPLICATION_DECISION_ONLY' as const,
      operation: 'READ_TRUSTED_WRITE_APPROVAL_DECISION' as const,
      caseId: pending.caseId,
      projectId: pending.projectId,
      proposal,
    };
    const decision = decisionFor(request);

    expect(modelSyntheticDebugRecordSchema.safeParse(proposal).success).toBe(false);
    expect(modelSyntheticDebugRecordSchema.safeParse(decision).success).toBe(false);
    expect(parseSyntheticDebugWorkflowRecord(proposal)).toEqual(proposal);
    expect(parseSyntheticDebugWorkflowRecord(decision)).toEqual(decision);
    expect(
      trustedSyntheticDebugApprovalDecisionSchema.safeParse({
        ...decision,
        actorId: 'model-selected-actor',
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugApprovalDecisionSchema.safeParse({
        ...decision,
        decisionReferenceId: `approval-decision-${APPROVAL_SECRET}`,
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugApprovalDecisionSchema.safeParse({
        ...decision,
        decisionReferenceId: `approval-decision-${API_SECRET}`,
      }).success,
    ).toBe(false);
  });

  it('cannot self-approve from a model-shaped method argument', async () => {
    const calls: string[] = [];
    const controller = controllerFor({ calls, includeTaskF: false });
    const pending = await pendingState(controller);
    const proposalId = pending.writeProposal?.proposalId;
    if (proposalId === undefined) throw new Error('Expected a proposal id');
    const modelAttempt = {
      decision: 'APPROVED',
      sourceBoundary: 'TRUSTED_APPLICATION',
      proposalId,
      approvalToken: APPROVAL_SECRET,
    };

    // @ts-expect-error A model-shaped second argument is deliberately outside the public API.
    const result = await controller.resolveWriteApproval(pending, modelAttempt);
    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        writeApprovalDecision: null,
      },
      transition: { reasons: [{ code: 'TRUSTED_APPROVAL_CAPABILITY_MISSING' }] },
    });
    expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
    expect(calls).not.toContain('task-f');
  });

  it('rejects and consumes an untrusted approval-shaped capability result deterministically', async () => {
    const calls: string[] = [];
    const controller = controllerFor({
      calls,
      taskFDecision: (request) => ({
        ...decisionFor(request),
        sourceBoundary: 'MODEL_OUTPUT',
      }),
    });
    const pending = await pendingState(controller);

    const first = await controller.resolveWriteApproval(pending);
    const second = await controller.resolveWriteApproval(pending);
    expect(first).toMatchObject({
      ok: false,
      snapshot: pending,
      error: { code: 'MALFORMED_TRUSTED_APPROVAL', state: 'AWAITING_WRITE_APPROVAL' },
    });
    expect(second).toBe(first);
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it('rejects forbidden approval fields without exposing their secret values', async () => {
    const calls: string[] = [];
    const taskFRequests: SyntheticDebugTaskFRequest[] = [];
    const controller = controllerFor({
      calls,
      taskFRequests,
      taskFDecision: (request) => ({
        ...decisionFor(request),
        approvalToken: APPROVAL_SECRET,
        actorId: 'model-selected-actor',
        role: 'OWNER',
        capabilities: ['write'],
        projectGrants: ['synthetic'],
        allowedZones: ['private'],
        ownerVerification: true,
        baselineSha: 'c'.repeat(40),
        approvedPaths: ['outside.ts'],
        requiredTestProfileIds: ['untrusted-test'],
        rootCause: 'rewritten',
        patch: 'untrusted patch',
        command: 'untrusted command',
        repositoryRoot: 'C:/untrusted',
      }),
    });
    const pending = await pendingState(controller);

    const result = await controller.resolveWriteApproval(pending);
    expect(result).toMatchObject({
      ok: false,
      snapshot: pending,
      error: { code: 'MALFORMED_TRUSTED_APPROVAL' },
    });
    const reportSafe = JSON.stringify({ result, taskFRequests });
    expect(reportSafe).not.toContain(APPROVAL_SECRET);
    expect(reportSafe).not.toContain('approvalToken');
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it('accepts a trusted APPROVED decision and stops at the pre-Worker state', async () => {
    const calls: string[] = [];
    const taskFRequests: SyntheticDebugTaskFRequest[] = [];
    const forbiddenRuntime = {
      executeWorker: vi.fn(),
      createWorktree: vi.fn(),
      applyPatch: vi.fn(),
      runTestProfile: vi.fn(),
      startReview: vi.fn(),
    };
    const controller = controllerFor({
      calls,
      taskFRequests,
      forbiddenRuntime,
      taskFDecision: (request) => {
        void APPROVAL_SECRET;
        return decisionFor(request, 'APPROVED', 'approval-decision-approved-c3-5');
      },
    });
    const pending = await pendingState(controller);

    const approved = await controller.resolveWriteApproval(pending);
    expect(approved).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: {
        machine: { state: 'IMPLEMENTING', outcome: null },
        writeApprovalDecision: {
          sourceBoundary: 'TRUSTED_APPLICATION',
          decisionReferenceId: 'approval-decision-approved-c3-5',
          decision: 'APPROVED',
        },
      },
      transition: {
        event: 'GRANT_WRITE_APPROVAL',
        from: 'AWAITING_WRITE_APPROVAL',
        to: 'IMPLEMENTING',
        reasons: [{ code: 'TRUSTED_WRITE_APPROVAL_ACCEPTED' }],
      },
    });
    if (!approved.ok) throw new Error(approved.error.message);
    expectC34Identity(pending, approved.snapshot);
    expect(approved.snapshot.writeProposal).toBe(pending.writeProposal);
    expect(Object.isFrozen(approved.snapshot.writeApprovalDecision)).toBe(true);
    expect(taskFRequests).toHaveLength(1);
    expect(Object.keys(taskFRequests[0] ?? {}).sort()).toEqual([
      'accessMode',
      'caseId',
      'operation',
      'projectId',
      'proposal',
      'schemaVersion',
      'workflowKind',
    ]);
    expect(taskFRequests[0]?.proposal).toBe(pending.writeProposal);
    expect(JSON.stringify({ approved, taskFRequests })).not.toContain(APPROVAL_SECRET);
    for (const method of Object.values(forbiddenRuntime)) expect(method).not.toHaveBeenCalled();
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it.each([
    {
      decision: 'DENIED' as const,
      status: 'BLOCKED' as const,
      state: 'BLOCKED' as const,
      event: 'BLOCK' as const,
      reason: 'TRUSTED_WRITE_APPROVAL_DENIED',
    },
    {
      decision: 'CANCELLED' as const,
      status: 'CANCELLED' as const,
      state: 'CANCELLED' as const,
      event: 'CANCEL' as const,
      reason: 'TRUSTED_WRITE_APPROVAL_CANCELLED',
    },
  ])('handles trusted $decision with no mutation or second decision', async (scenario) => {
    const calls: string[] = [];
    const controller = controllerFor({
      calls,
      taskFDecision: (request) => decisionFor(request, scenario.decision),
    });
    const pending = await pendingState(controller);

    const resolved = await controller.resolveWriteApproval(pending);
    expect(resolved).toMatchObject({
      ok: true,
      status: scenario.status,
      snapshot: {
        machine: { state: scenario.state, outcome: 'FAILURE' },
        writeApprovalDecision: { decision: scenario.decision },
      },
      transition: {
        event: scenario.event,
        from: 'AWAITING_WRITE_APPROVAL',
        to: scenario.state,
        reasons: [{ code: scenario.reason }],
      },
    });
    if (!resolved.ok) throw new Error(resolved.error.message);
    expectC34Identity(pending, resolved.snapshot);
    expect(resolved.snapshot.writeProposal).toBe(pending.writeProposal);

    const repeated = await controller.resolveWriteApproval(resolved.snapshot);
    expect(repeated).toMatchObject({
      ok: false,
      snapshot: resolved.snapshot,
      error: { code: 'TERMINAL_STATE', state: scenario.state },
    });
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it.each([
    { label: 'case', override: { caseId: 'different-case' } },
    { label: 'project', override: { projectId: 'different-project' } },
    { label: 'proposal', override: { proposalId: 'write-proposal-different' } },
  ])('rejects a trusted decision bound to the wrong $label', async ({ override }) => {
    const calls: string[] = [];
    const controller = controllerFor({
      calls,
      taskFDecision: (request) => ({ ...decisionFor(request), ...override }),
    });
    const pending = await pendingState(controller);

    const first = await controller.resolveWriteApproval(pending);
    const replay = await controller.resolveWriteApproval(pending);
    expect(first).toMatchObject({
      ok: false,
      snapshot: pending,
      error: { code: 'TRUSTED_APPROVAL_SCOPE_MISMATCH' },
    });
    expect(replay).toBe(first);
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it('resolves concurrent and stale decision replays exactly once', async () => {
    const calls: string[] = [];
    const controller = controllerFor({
      calls,
      taskFDecision: async (request) => {
        await Promise.resolve();
        return decisionFor(request);
      },
    });
    const pending = await pendingState(controller);

    const [first, concurrent, replay] = await Promise.all([
      controller.resolveWriteApproval(pending),
      controller.resolveWriteApproval(pending),
      controller.resolveWriteApproval(pending),
    ]);
    expect(concurrent).toBe(first);
    expect(replay).toBe(first);
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
    if (!first.ok) throw new Error(first.error.message);

    expect(await controller.resolveWriteApproval(first.snapshot)).toMatchObject({
      ok: false,
      snapshot: first.snapshot,
      error: { code: 'OUT_OF_ORDER', state: 'IMPLEMENTING' },
    });
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it('rejects reuse of a decision reference across case-bound proposals', async () => {
    const controller = controllerFor({
      taskFDecision: (request) =>
        decisionFor(request, 'APPROVED', 'approval-decision-shared-reference'),
    });
    const firstPending = await pendingState(controller, 'synthetic-case-c3-5-a');
    const secondPending = await pendingState(controller, 'synthetic-case-c3-5-b');

    const first = await controller.resolveWriteApproval(firstPending);
    expect(first).toMatchObject({ ok: true, snapshot: { machine: { state: 'IMPLEMENTING' } } });
    const second = await controller.resolveWriteApproval(secondPending);
    expect(second).toMatchObject({
      ok: false,
      snapshot: secondPending,
      error: { code: 'TRUSTED_APPROVAL_REPLAY_MISMATCH' },
    });
  });

  it('deep-freezes proposals and detects sealed snapshot tampering before authority is called', async () => {
    const calls: string[] = [];
    const controller = controllerFor({ calls });
    const pending = await pendingState(controller);
    const proposal = pending.writeProposal;
    if (proposal === null) throw new Error('Expected a write proposal');

    expect(() => {
      (proposal.approvedPaths as string[])[0] = 'outside.ts';
    }).toThrow(TypeError);
    expect(proposal.approvedPaths).toEqual(['src/alpha.ts', 'src/zeta.ts']);

    const mutations: ((snapshot: SyntheticDebugOrchestrationSnapshot) => void)[] = [
      (snapshot) => Object.assign(snapshot.writeProposal ?? {}, { approvedPaths: ['outside.ts'] }),
      (snapshot) => Object.assign(snapshot.knownGoodBaseline ?? {}, { commitSha: 'c'.repeat(40) }),
      (snapshot) => Object.assign(snapshot.rootCause ?? {}, { explanation: 'rewritten' }),
      (snapshot) => Object.assign(snapshot.intake, { problem: 'rewritten' }),
      (snapshot) =>
        Object.assign(snapshot.reproducibleDefectEvidence[0] ?? {}, { reference: 'rewritten' }),
      (snapshot) => Object.assign(snapshot.implementationGate ?? {}, { blockers: ['rewritten'] }),
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(pending);
      mutate(tampered);
      expect(await controller.resolveWriteApproval(tampered)).toMatchObject({
        ok: false,
        snapshot: tampered,
        error: { code: 'WRITE_PROPOSAL_INTEGRITY_MISMATCH' },
      });
    }
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(0);
  });

  it('does not let approval rewrite baseline, evidence, scope, tests, or root cause', async () => {
    const controller = controllerFor({
      taskFDecision: (request) => ({
        ...decisionFor(request),
        baselineSha: 'c'.repeat(40),
        approvedPaths: ['outside.ts'],
        requiredTestProfileIds: ['untrusted-test'],
        rootCause: { explanation: 'rewritten' },
      }),
    });
    const pending = await pendingState(controller);
    const before = JSON.stringify(pending);

    const result = await controller.resolveWriteApproval(pending);
    expect(result).toMatchObject({
      ok: false,
      snapshot: pending,
      error: { code: 'MALFORMED_TRUSTED_APPROVAL' },
    });
    expect(result.snapshot).toBe(pending);
    expect(JSON.stringify(pending)).toBe(before);
  });

  it('uses static failure evidence when the trusted dependency throws a secret', async () => {
    const calls: string[] = [];
    const controller = controllerFor({
      calls,
      taskFDecision: () => {
        throw new Error(`trusted dependency leaked ${APPROVAL_SECRET}`);
      },
    });
    const pending = await pendingState(controller);

    const failed = await controller.resolveWriteApproval(pending);
    expect(failed).toMatchObject({
      ok: true,
      status: 'FAILED',
      snapshot: { machine: { state: 'FAILED', outcome: 'FAILURE' } },
      transition: { reasons: [{ code: 'TRUSTED_APPROVAL_DEPENDENCY_ERROR' }] },
    });
    expect(JSON.stringify(failed)).not.toContain(APPROVAL_SECRET);
    expect(await controller.resolveWriteApproval(pending)).toBe(failed);
    if (!failed.ok) throw new Error(failed.error.message);
    expect(await controller.resolveWriteApproval(failed.snapshot)).toMatchObject({
      ok: false,
      snapshot: failed.snapshot,
      error: { code: 'TERMINAL_STATE', state: 'FAILED' },
    });
    expect(calls.filter((call) => call === 'task-f')).toHaveLength(1);
  });

  it('rejects skipped transitions and exposes no Worker, patch, test, review, or delivery surface', async () => {
    const calls: string[] = [];
    const controller = controllerFor({ calls });
    const baselineReady = await baselineReadyState(controller);
    expect(controller.requestWriteApproval(baselineReady, planFor())).toMatchObject({
      ok: false,
      snapshot: baselineReady,
      error: { code: 'OUT_OF_ORDER', state: 'BASELINE_READY' },
    });
    const ready = await implementationReadyState(controller, 'synthetic-case-c3-5-skipped');
    expect(await controller.resolveWriteApproval(ready)).toMatchObject({
      ok: false,
      snapshot: ready,
      error: { code: 'OUT_OF_ORDER', state: 'IMPLEMENTATION_READY' },
    });
    expect(calls).not.toContain('task-f');

    expect(Object.keys(controller).sort()).toEqual([
      'completeDiscovery',
      'createCase',
      'evaluateImplementationGate',
      'executeApprovedImplementation',
      'recordEvidenceAndRootCause',
      'requestWriteApproval',
      'resolveTrustedBaseline',
      'resolveWriteApproval',
      'startDiscovery',
    ]);
    for (const forbidden of [
      'issueWriteApproval',
      'grantWriteApproval',
      'callWorker',
      'executeWorker',
      'createWorktree',
      'createPatchRequest',
      'applyPatch',
      'runTestProfile',
      'startVerification',
      'startReview',
      'markTestReady',
      'finalizeCandidate',
    ]) {
      expect(controller).not.toHaveProperty(forbidden);
    }
  });
});
