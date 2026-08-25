import { describe, expect, it } from 'vitest';

import { independentReviewForDelivery } from '../src/debug/independent-review.js';
import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugOrchestratorDependencies,
  type SyntheticDebugTaskDRequest,
  type SyntheticDebugTaskFRequest,
  type SyntheticDebugTaskGRequest,
  type SyntheticDebugTaskIRequest,
} from '../src/debug/orchestrator.js';
import type {
  SyntheticDebugImplementationPlanRecord,
  SyntheticDebugIntakeRecord,
  SyntheticDebugRootCauseRecord,
  TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';
import type { WorkerActionResult, WorkerJobResult } from '../src/worker/contracts.js';

const BASELINE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const PROFILE_ID = 'synthetic-check';
const FIXTURE_PATH = 'fixture.txt';
const ACTION_TIME = '2026-08-24T12:00:00.000Z';
const APPROVAL_SECRET = '7'.repeat(64);
const API_SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

type ReviewFactory = (request: SyntheticDebugTaskIRequest, call: number) => unknown;

interface HarnessOptions {
  readonly review?: ReviewFactory | null;
  readonly workerSummary?: string;
}

interface ReviewHarness {
  readonly controller: SyntheticDebugDiscoveryController;
  readonly workerCalls: () => number;
  readonly testProfileRuns: () => number;
  readonly reviewCalls: () => number;
  readonly reviewRequests: readonly SyntheticDebugTaskIRequest[];
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
    ownerVerification: { status: 'OWNER_VERIFIED', evidenceReference: sourceReference },
    knownBlockers: [],
  };
}

function action(
  actionIndex: number,
  kind: WorkerActionResult['kind'],
  summary: string,
  extra: Pick<WorkerActionResult, 'profileId' | 'patchId'> = {},
): WorkerActionResult {
  return {
    actionIndex,
    kind,
    status: 'passed',
    startedAt: ACTION_TIME,
    finishedAt: ACTION_TIME,
    summary,
    ...extra,
  };
}

function successfulWorkerResult(
  request: SyntheticDebugTaskGRequest,
  summary = 'synthetic action passed',
): WorkerJobResult {
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
      action(0, 'apply_patch', summary, { patchId: request.proposal.proposalId }),
      action(1, 'run_test_profile', summary, { profileId: PROFILE_ID }),
      action(2, 'finalize_candidate', summary),
    ],
  };
}

function validReview(
  request: SyntheticDebugTaskIRequest,
  disposition: 'pass' | 'fail' | 'blocked' = 'pass',
) {
  const blocking = disposition === 'pass' ? [] : [`Independent review ${disposition}.`];
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INDEPENDENT_REVIEW',
    sourceBoundary: 'INDEPENDENT_REVIEW_SERVICE',
    caseId: request.reviewPackage.caseId,
    projectId: request.reviewPackage.projectId,
    reviewId: `review-${request.reviewPackage.caseId}`,
    reviewPackageId: request.reviewPackage.reviewPackageId,
    candidateSha: request.reviewPackage.candidateSha,
    disposition,
    summary:
      disposition === 'pass'
        ? 'The verified synthetic candidate passed independent review.'
        : `The verified synthetic candidate was ${disposition}.`,
    findings: ['The review package was bounded to trusted verified evidence.'],
    blockers: blocking,
    evidenceInspected: [...request.reviewPackage.evidenceReferences],
  };
}

function controllerHarness(options: HarnessOptions = {}): ReviewHarness {
  let workerCalls = 0;
  let testProfileRuns = 0;
  let reviewCalls = 0;
  const reviewRequests: SyntheticDebugTaskIRequest[] = [];
  const reviewFactory =
    options.review === undefined
      ? (request: SyntheticDebugTaskIRequest) => validReview(request)
      : options.review;
  const dependencies: SyntheticDebugOrchestratorDependencies = {
    taskD: {
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
      readTrustedBaseline: (request: SyntheticDebugTaskDRequest) => baseline(request.caseId),
    },
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
        testProfileRuns += 1;
        return successfulWorkerResult(request, options.workerSummary);
      },
    },
    ...(reviewFactory === null
      ? {}
      : {
          taskI: {
            reviewVerifiedSyntheticCandidate: (request: SyntheticDebugTaskIRequest) => {
              reviewCalls += 1;
              reviewRequests.push(request);
              return reviewFactory(request, reviewCalls);
            },
          },
        }),
  };
  return {
    controller: createSyntheticDebugDiscoveryController(dependencies),
    workerCalls: () => workerCalls,
    testProfileRuns: () => testProfileRuns,
    reviewCalls: () => reviewCalls,
    reviewRequests,
  };
}

async function verifyingSnapshot(
  harness: ReviewHarness,
  caseId: string,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const controller = harness.controller;
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
  return executed.snapshot;
}

async function reviewingSnapshot(
  harness: ReviewHarness,
  caseId: string,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const workerCallsBefore = harness.workerCalls();
  const testProfileRunsBefore = harness.testProfileRuns();
  const reviewCallsBefore = harness.reviewCalls();
  const verified = await harness.controller.evaluateVerification(
    await verifyingSnapshot(harness, caseId),
  );
  if (!verified.ok) throw new Error(verified.error.message);
  expect(verified.snapshot).toMatchObject({
    machine: { state: 'REVIEWING', outcome: null },
    verificationDecision: { status: 'PASSED' },
    independentReviewPackage: null,
    independentReview: null,
  });
  expect(harness.workerCalls()).toBe(workerCallsBefore + 1);
  expect(harness.testProfileRuns()).toBe(testProfileRunsBefore + 1);
  expect(harness.reviewCalls()).toBe(reviewCallsBefore);
  return verified.snapshot;
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

describe('C3.8 independent-review orchestration', () => {
  it('records trusted PASS in REVIEWING without Worker/profile re-execution or TEST_READY', async () => {
    const harness = controllerHarness();
    const reviewing = await reviewingSnapshot(harness, 'c3-8-pass');

    const result = await harness.controller.evaluateIndependentReview(reviewing);

    expect(result).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: {
        machine: { state: 'REVIEWING', outcome: null },
        independentReview: {
          sourceBoundary: 'INDEPENDENT_REVIEW_SERVICE',
          disposition: 'pass',
          candidateSha: CANDIDATE_SHA,
        },
      },
      transition: {
        event: 'COMPLETE_REVIEW',
        from: 'REVIEWING',
        to: 'REVIEWING',
        reasons: [{ code: 'INDEPENDENT_REVIEW_PASSED' }],
      },
    });
    if (!result.ok || result.snapshot.independentReview === null) {
      throw new Error('Expected a trusted passing review');
    }
    expect(result.snapshot.machine.history.map(({ to }) => to)).not.toContain('TEST_READY');
    expect(result.snapshot.machine.history.map(({ event }) => event)).not.toContain(
      'MARK_TEST_READY',
    );
    expect(independentReviewForDelivery(result.snapshot.independentReview)).toEqual({
      reviewId: 'review-c3-8-pass',
      status: 'passed',
      summary: 'The verified synthetic candidate passed independent review.',
    });
    expect(independentReviewForDelivery(null)).toEqual({
      reviewId: null,
      status: 'not_run',
      summary: '',
    });
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
    expect(harness.reviewCalls()).toBe(1);
  });

  it.each(['fail', 'blocked'] as const)(
    'transitions trusted %s to BLOCKED and preserves its blockers',
    async (disposition) => {
      const harness = controllerHarness({
        review: (request) => validReview(request, disposition),
      });
      const reviewing = await reviewingSnapshot(harness, `c3-8-${disposition}`);

      const result = await harness.controller.evaluateIndependentReview(reviewing);

      expect(result).toMatchObject({
        ok: true,
        status: 'BLOCKED',
        snapshot: {
          machine: { state: 'BLOCKED', outcome: 'FAILURE' },
          independentReview: { disposition },
        },
        transition: {
          event: 'BLOCK',
          from: 'REVIEWING',
          to: 'BLOCKED',
          reasons: [
            {
              code:
                disposition === 'fail' ? 'INDEPENDENT_REVIEW_FAILED' : 'INDEPENDENT_REVIEW_BLOCKED',
            },
          ],
        },
      });
      expect(harness.workerCalls()).toBe(1);
      expect(harness.testProfileRuns()).toBe(1);
    },
  );

  it('blocks a missing/not-run review without inventing a result', async () => {
    const harness = controllerHarness({ review: null });
    const reviewing = await reviewingSnapshot(harness, 'c3-8-missing');

    const result = await harness.controller.evaluateIndependentReview(reviewing);

    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED' },
        independentReviewPackage: { packageKind: 'INDEPENDENT_REVIEW_PACKAGE' },
        independentReview: null,
      },
      transition: { reasons: [{ code: 'INDEPENDENT_REVIEW_NOT_RUN' }] },
    });
    expect(harness.reviewCalls()).toBe(0);
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
  });

  it.each([
    {
      label: 'no returned record',
      mutate: () => undefined,
      code: 'INDEPENDENT_REVIEW_NOT_RUN',
    },
    {
      label: 'primitive result',
      mutate: () => 'pass',
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'missing review id',
      mutate: (record: Record<string, unknown>) => ({ ...record, reviewId: undefined }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'empty review id',
      mutate: (record: Record<string, unknown>) => ({ ...record, reviewId: '' }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'empty PASS summary',
      mutate: (record: Record<string, unknown>) => ({ ...record, summary: ' ' }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'PASS with blockers',
      mutate: (record: Record<string, unknown>) => ({ ...record, blockers: ['contradiction'] }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'FAIL without blockers',
      mutate: (record: Record<string, unknown>) => ({
        ...record,
        disposition: 'fail',
        blockers: [],
      }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'empty evidence set',
      mutate: (record: Record<string, unknown>) => ({ ...record, evidenceInspected: [] }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'fabricated reviewer authority',
      mutate: (record: Record<string, unknown>) => ({
        ...record,
        reviewerAuthority: 'ENGINEERING',
      }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
    {
      label: 'approval and direct state target',
      mutate: (record: Record<string, unknown>) => ({
        ...record,
        approvalGrant: APPROVAL_SECRET,
        targetState: 'TEST_READY',
      }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
  ] as const)('fails closed on $label', async ({ label, mutate, code }) => {
    const caseId = `c3-8-malformed-${label.replaceAll(' ', '-')}`;
    const harness = controllerHarness({
      review: (request) => mutate(validReview(request)),
    });
    const reviewing = await reviewingSnapshot(harness, caseId);

    const result = await harness.controller.evaluateIndependentReview(reviewing);

    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED' }, independentReview: null },
      transition: { reasons: [{ code }] },
    });
    expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
  });

  it.each([
    {
      label: 'wrong case',
      mutate: (record: Record<string, unknown>) => ({ ...record, caseId: 'different-case' }),
      code: 'INDEPENDENT_REVIEW_SCOPE_MISMATCH',
    },
    {
      label: 'wrong project',
      mutate: (record: Record<string, unknown>) => ({ ...record, projectId: 'different' }),
      code: 'INDEPENDENT_REVIEW_SCOPE_MISMATCH',
    },
    {
      label: 'wrong candidate',
      mutate: (record: Record<string, unknown>) => ({ ...record, candidateSha: OTHER_SHA }),
      code: 'INDEPENDENT_REVIEW_CANDIDATE_MISMATCH',
    },
    {
      label: 'wrong package',
      mutate: (record: Record<string, unknown>) => ({
        ...record,
        reviewPackageId: `review-package-${'d'.repeat(64)}`,
      }),
      code: 'INDEPENDENT_REVIEW_PACKAGE_MISMATCH',
    },
    {
      label: 'untrusted inspected evidence',
      mutate: (record: Record<string, unknown>) => ({
        ...record,
        evidenceInspected: [`review-package-${'e'.repeat(64)}`],
      }),
      code: 'INDEPENDENT_REVIEW_EVIDENCE_MISMATCH',
    },
  ] as const)('rejects $label review evidence', async ({ label, mutate, code }) => {
    const caseId = `c3-8-mismatch-${label.replaceAll(' ', '-')}`;
    const harness = controllerHarness({
      review: (request) => mutate(validReview(request)),
    });
    const result = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, caseId),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED' }, independentReview: null },
      transition: { reasons: [{ code }] },
    });
  });

  it('uses one frozen bounded allowlisted package built from cached trusted evidence only', async () => {
    const harness = controllerHarness({
      workerSummary: `${APPROVAL_SECRET} ${API_SECRET}`,
    });
    const reviewing = await reviewingSnapshot(harness, 'c3-8-package');
    const result = await harness.controller.evaluateIndependentReview(reviewing);
    if (!result.ok || result.snapshot.independentReviewPackage === null) {
      throw new Error('Expected a review package');
    }

    const request = harness.reviewRequests[0];
    expect(request).toBeDefined();
    if (request === undefined) throw new Error('Expected one review request');
    expect(Object.keys(request)).toEqual([
      'schemaVersion',
      'workflowKind',
      'accessMode',
      'operation',
      'reviewPackage',
    ]);
    expect(request).toMatchObject({
      accessMode: 'INDEPENDENT_REVIEW_SERVICE_ONLY',
      operation: 'REVIEW_VERIFIED_SYNTHETIC_CANDIDATE',
      reviewPackage: {
        sourceBoundary: 'TRUSTED_VERIFIED_EVIDENCE',
        caseId: 'c3-8-package',
        projectId: 'synthetic',
        verifiedBaselineSha: BASELINE_SHA,
        candidateSha: CANDIDATE_SHA,
        rollbackSha: BASELINE_SHA,
        approvedPaths: [FIXTURE_PATH],
        changedPaths: [FIXTURE_PATH],
        affectedSurfaces: ['synthetic fixture'],
        requiredVerificationOutcomes: [{ profileId: PROFILE_ID, status: 'passed' }],
        verificationSummary: { status: 'PASSED' },
        workerSummary: {
          status: 'SUCCEEDED',
          isolatedExecution: true,
          retainedWorkspaceEvidence: true,
        },
      },
    });
    expect(request.reviewPackage).toBe(result.snapshot.independentReviewPackage);
    expect(request.reviewPackage.evidenceReferences).toEqual([
      request.reviewPackage.reviewPackageId,
    ]);
    expect(JSON.stringify(request).length).toBeLessThan(30_000);
    expectDeeplyFrozen(request);
    expectDeeplyFrozen(result.snapshot.independentReview);
    expect(() => Object.assign(request.reviewPackage, { candidateSha: OTHER_SHA })).toThrow();

    const forbiddenKeys = [
      'approvalToken',
      'approvalGrant',
      'approvalDecisionReferenceId',
      'writeApprovalDecision',
      'reviewId',
      'disposition',
      'reviewerAuthority',
      'reviewerIdentity',
      'role',
      'capabilities',
      'targetState',
      'command',
      'env',
      'output',
      'patch',
      'repositoryRoot',
      'workspacePath',
      'workspaceReference',
      'rawMemory',
    ];
    expect(recursiveKeys(request)).not.toEqual(expect.arrayContaining(forbiddenKeys));
    expect(JSON.stringify(request)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(request)).not.toContain(API_SECRET);
    expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(result)).not.toContain(API_SECRET);
  });

  it('ignores model/Engineering/coordinator review claims and cannot bypass REVIEWING', async () => {
    const harness = controllerHarness({
      review: (request) => validReview(request, 'blocked'),
    });
    const verifying = await verifyingSnapshot(harness, 'c3-8-no-bypass');

    const premature = await harness.controller.evaluateIndependentReview(verifying);
    expect(premature).toMatchObject({
      ok: false,
      error: { code: 'OUT_OF_ORDER', state: 'VERIFYING' },
    });
    expect(harness.reviewCalls()).toBe(0);

    const reviewing = await harness.controller.evaluateVerification(verifying);
    if (!reviewing.ok) throw new Error(reviewing.error.message);
    // @ts-expect-error Task I accepts no model/Engineering/coordinator-authored review or target.
    const attemptedBypass = await harness.controller.evaluateIndependentReview(reviewing.snapshot, {
      reviewId: 'fabricated-pass',
      disposition: 'pass',
      reviewerAuthority: 'ENGINEERING',
      targetState: 'TEST_READY',
    });
    expect(attemptedBypass).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED' }, independentReview: { disposition: 'blocked' } },
    });
    expect(harness.reviewCalls()).toBe(1);
    expect(harness.reviewRequests[0]?.reviewPackage).not.toHaveProperty('disposition');
    expect(harness.reviewRequests[0]?.reviewPackage).not.toHaveProperty('reviewId');
    expect(harness.reviewRequests[0]?.reviewPackage).not.toHaveProperty('targetState');
  });

  it('rejects forged REVIEWING snapshots and cross-controller evidence before review', async () => {
    const harness = controllerHarness();
    const reviewing = await reviewingSnapshot(harness, 'c3-8-integrity');
    const mutations: readonly ((snapshot: SyntheticDebugOrchestrationSnapshot) => void)[] = [
      (snapshot) => Object.assign(snapshot, { caseId: 'different-case' }),
      (snapshot) => {
        if (snapshot.rootCause === null) throw new Error('Expected root cause');
        Object.assign(snapshot.rootCause, { explanation: 'forged root cause' });
      },
      (snapshot) => {
        if (snapshot.writeProposal === null) throw new Error('Expected proposal');
        Object.assign(snapshot.writeProposal, { proposalId: `write-proposal-${'d'.repeat(64)}` });
      },
      (snapshot) => {
        if (snapshot.verificationDecision === null) throw new Error('Expected verification');
        Object.assign(snapshot.verificationDecision, { candidateSha: OTHER_SHA });
      },
      (snapshot) =>
        Object.assign(snapshot, {
          independentReview: {
            disposition: 'pass',
            reviewId: 'forged-review',
          },
        }),
    ];

    for (const mutate of mutations) {
      const forged = structuredClone(reviewing);
      mutate(forged);
      const blocked = await harness.controller.evaluateIndependentReview(forged);
      expect(blocked).toMatchObject({
        ok: true,
        status: 'BLOCKED',
        transition: { reasons: [{ code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH' }] },
      });
    }
    expect(harness.reviewCalls()).toBe(0);

    const other = controllerHarness();
    const crossController = await other.controller.evaluateIndependentReview(reviewing);
    expect(crossController).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      transition: { reasons: [{ code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH' }] },
    });
    expect(other.reviewCalls()).toBe(0);
  });

  it('shares concurrent review, replays idempotently, and preserves the first result', async () => {
    let disposition: 'pass' | 'fail' = 'pass';
    const harness = controllerHarness({
      review: (request) => validReview(request, disposition),
    });
    const reviewing = await reviewingSnapshot(harness, 'c3-8-replay');

    const [first, concurrent] = await Promise.all([
      harness.controller.evaluateIndependentReview(reviewing),
      harness.controller.evaluateIndependentReview(structuredClone(reviewing)),
    ]);
    expect(concurrent).toBe(first);
    expect(harness.reviewCalls()).toBe(1);
    disposition = 'fail';

    if (!first.ok) throw new Error(first.error.message);
    const replay = await harness.controller.evaluateIndependentReview(
      structuredClone(first.snapshot),
    );
    expect(replay).toBe(first);
    expect(replay).toMatchObject({
      snapshot: { machine: { state: 'REVIEWING' }, independentReview: { disposition: 'pass' } },
    });
    expect(harness.reviewCalls()).toBe(1);
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
  });

  it('fails closed on later conflicting review evidence without latest-wins', async () => {
    const sharedReviewId = 'review-shared-conflict';
    const harness = controllerHarness({
      review: (request) => ({ ...validReview(request), reviewId: sharedReviewId }),
    });
    const firstReviewing = await reviewingSnapshot(harness, 'c3-8-conflict-a');
    const first = await harness.controller.evaluateIndependentReview(firstReviewing);
    expect(first).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: { independentReview: { reviewId: sharedReviewId, disposition: 'pass' } },
    });

    const secondReviewing = await reviewingSnapshot(harness, 'c3-8-conflict-b');
    const conflict = await harness.controller.evaluateIndependentReview(secondReviewing);
    expect(conflict).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED' }, independentReview: null },
      transition: { reasons: [{ code: 'INDEPENDENT_REVIEW_CONFLICT' }] },
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.snapshot.independentReview?.disposition).toBe('pass');
    expect(harness.reviewCalls()).toBe(2);
  });

  it('copies and freezes the trusted result independently of the service object', async () => {
    const returnedRecords: ReturnType<typeof validReview>[] = [];
    const harness = controllerHarness({
      review: (request) => {
        const returned = validReview(request);
        returnedRecords.push(returned);
        return returned;
      },
    });
    const result = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-8-result-freeze'),
    );
    const returned = returnedRecords[0];
    if (!result.ok || result.snapshot.independentReview === null || returned === undefined) {
      throw new Error('Expected one trusted review');
    }
    expectDeeplyFrozen(result.snapshot.independentReview);
    const stored = JSON.stringify(result.snapshot.independentReview);
    Object.assign(returned, { summary: 'mutated after return' });
    returned.findings.push('mutated finding');
    expect(JSON.stringify(result.snapshot.independentReview)).toBe(stored);
  });

  it.each([
    {
      label: 'approval secret in summary',
      secret: APPROVAL_SECRET,
      mutate: (record: Record<string, unknown>) => ({ ...record, summary: APPROVAL_SECRET }),
      code: 'SENSITIVE_INDEPENDENT_REVIEW',
    },
    {
      label: 'API secret in finding',
      secret: API_SECRET,
      mutate: (record: Record<string, unknown>) => ({ ...record, findings: [API_SECRET] }),
      code: 'SENSITIVE_INDEPENDENT_REVIEW',
    },
    {
      label: 'approval secret as review id',
      secret: APPROVAL_SECRET,
      mutate: (record: Record<string, unknown>) => ({ ...record, reviewId: APPROVAL_SECRET }),
      code: 'MALFORMED_INDEPENDENT_REVIEW',
    },
  ] as const)('does not expose $label', async ({ label, secret, mutate, code }) => {
    const harness = controllerHarness({
      review: (request) => mutate(validReview(request)),
    });
    const result = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, `c3-8-secret-${label.replaceAll(' ', '-')}`),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { independentReview: null },
      transition: { reasons: [{ code }] },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not expose a dependency exception or retry Worker/tests', async () => {
    const harness = controllerHarness({
      review: () => {
        throw new Error(`${APPROVAL_SECRET} ${API_SECRET}`);
      },
    });
    const result = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-8-dependency-error'),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'FAILED',
      snapshot: { machine: { state: 'FAILED' }, independentReview: null },
      transition: { reasons: [{ code: 'INDEPENDENT_REVIEW_DEPENDENCY_ERROR' }] },
    });
    expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(result)).not.toContain(API_SECRET);
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
    expect(harness.reviewCalls()).toBe(1);
  });

  it('turns conflicting pre-populated replay evidence into an explicit blocker', async () => {
    const harness = controllerHarness();
    const first = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-8-forged-replay'),
    );
    if (!first.ok || first.snapshot.independentReview === null) {
      throw new Error('Expected an accepted review');
    }
    const forged = structuredClone(first.snapshot);
    if (forged.independentReview === null) throw new Error('Expected cloned review evidence');
    Object.assign(forged.independentReview, { summary: 'conflicting later review evidence' });

    const conflict = await harness.controller.evaluateIndependentReview(forged);

    expect(conflict).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED' },
        independentReview: { summary: first.snapshot.independentReview.summary },
      },
      transition: { reasons: [{ code: 'INDEPENDENT_REVIEW_CONFLICT' }] },
    });
    expect(harness.reviewCalls()).toBe(1);
  });

  it('uses only the cached C3.1-C3.8 package and the authoritative gate to reach TEST_READY', async () => {
    const harness = controllerHarness();
    const reviewed = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-9-test-ready'),
    );
    if (!reviewed.ok) throw new Error(reviewed.error.message);

    const result = await harness.controller.evaluateFinalDelivery(reviewed.snapshot);

    expect(result).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: {
        machine: { state: 'TEST_READY', outcome: 'SUCCESS' },
        finalDelivery: {
          workflowKind: 'synthetic',
          caseId: 'c3-9-test-ready',
          projectId: 'synthetic',
          baselineSha: BASELINE_SHA,
          baselineOwnerVerified: true,
          candidateSha: CANDIDATE_SHA,
          rollbackSha: BASELINE_SHA,
          problemEvidence: [{ classification: 'SYNTHETIC' }],
          rootCause: 'The fixture retained the old deterministic value.',
          approvedPaths: [FIXTURE_PATH],
          changedPaths: [FIXTURE_PATH],
          requiredProfileIds: [PROFILE_ID],
          verification: [{ profileId: PROFILE_ID, status: 'passed' }],
          review: { reviewId: 'review-c3-9-test-ready', status: 'passed' },
          status: 'TEST_READY',
          gate: { allowed: true, blockers: [] },
        },
      },
      transition: { event: 'MARK_TEST_READY', from: 'REVIEWING', to: 'TEST_READY' },
    });
    if (!result.ok || result.snapshot.finalDelivery === null) {
      throw new Error('Expected a final delivery report');
    }
    expectDeeplyFrozen(result.snapshot.finalDelivery);
    expect(result.snapshot.finalDelivery.status).toBe(
      result.snapshot.finalDelivery.gate.allowed ? 'TEST_READY' : 'BLOCKED',
    );
    expect(JSON.stringify(result)).not.toContain(APPROVAL_SECRET);
    expect(JSON.stringify(result)).not.toContain(API_SECRET);
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
    expect(harness.reviewCalls()).toBe(1);
  });

  it('replays the exact final decision without Worker, test, or review re-execution', async () => {
    const harness = controllerHarness();
    const reviewed = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-9-replay'),
    );
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    const first = await harness.controller.evaluateFinalDelivery(reviewed.snapshot);
    const replay = await harness.controller.evaluateFinalDelivery(
      structuredClone(reviewed.snapshot),
    );

    expect(replay).toBe(first);
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
    expect(harness.reviewCalls()).toBe(1);
    if (!first.ok) throw new Error(first.error.message);
    const terminal = await harness.controller.evaluateFinalDelivery(first.snapshot);
    expect(terminal).toBe(first);

    const conflict = structuredClone(reviewed.snapshot);
    if (conflict.independentReview === null) throw new Error('Expected review');
    Object.assign(conflict.independentReview, { summary: 'conflicting final evidence' });
    const rejected = await harness.controller.evaluateFinalDelivery(conflict);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'FINAL_DELIVERY_INTEGRITY_MISMATCH' },
    });
    expect(first.snapshot.machine.state).toBe('TEST_READY');
  });

  it('rejects mismatched cached delivery evidence and cannot accept a model-authored disposition', async () => {
    const harness = controllerHarness();
    const reviewed = await harness.controller.evaluateIndependentReview(
      await reviewingSnapshot(harness, 'c3-9-integrity'),
    );
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    const forged = structuredClone(reviewed.snapshot);
    if (forged.verificationDecision === null) throw new Error('Expected verification');
    Object.assign(forged.verificationDecision, { candidateSha: OTHER_SHA });

    // @ts-expect-error Task J accepts no model-authored final disposition.
    const result = await harness.controller.evaluateFinalDelivery(forged, { status: 'TEST_READY' });

    expect(result).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED' }, finalDelivery: null },
      transition: { reasons: [{ code: 'FINAL_DELIVERY_INTEGRITY_MISMATCH' }] },
    });
    expect(harness.workerCalls()).toBe(1);
    expect(harness.testProfileRuns()).toBe(1);
    expect(harness.reviewCalls()).toBe(1);
  });
});
