import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyntheticDebugApplicationApi } from '../src/debug/application-api.js';
import { createSyntheticDebugAgentTools } from '../src/debug/agent-tools.js';
import { canStartImplementation, canVerifyTestCandidate } from '../src/debug/gates.js';
import { SyntheticDebugMemorySink } from '../src/debug/memory-integration.js';
import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugTaskDRequest,
  type SyntheticDebugTaskFRequest,
  type SyntheticDebugTaskGRequest,
  type SyntheticDebugTaskIRequest,
} from '../src/debug/orchestrator.js';
import {
  parseModelSyntheticDebugRecord,
  type SyntheticDebugImplementationPlanRecord,
  type SyntheticDebugIntakeRecord,
  type SyntheticDebugRootCauseRecord,
  type TrustedSyntheticDebugDefectReferenceRecord,
} from '../src/debug/records.js';
import { createTrustedMemoryAccessContext } from '../src/memory/access.js';
import { MemoryService } from '../src/memory/service.js';
import { DurableMemoryStore } from '../src/memory/store.js';

const REFERENCE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const PROJECT_ID = 'synthetic-defect-reference';
const CASE_ID = 'c4-9-defect-reference';
const EVIDENCE_ID = 'reproducible-defect';
const PROFILE_ID = 'synthetic-check';
const CHANGED_PATH = 'src/fixture.ts';
const directories: string[] = [];

function intake(caseId = CASE_ID, projectId = PROJECT_ID): SyntheticDebugIntakeRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INTAKE',
    caseId,
    projectId,
    problem: 'A long-standing deterministic defect has no owner-verified defect-free baseline.',
    affectedSurfaces: ['synthetic fixture'],
    evidenceReferences: [
      {
        evidenceId: EVIDENCE_ID,
        kind: 'REPRODUCIBLE',
        reference: 'trusted-test:reproduction:c4-9',
      },
    ],
  };
}

function rootCause(caseId = CASE_ID, projectId = PROJECT_ID): SyntheticDebugRootCauseRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'ROOT_CAUSE',
    caseId,
    projectId,
    rootCauseId: `root-cause-${caseId}`,
    explanation: 'The fixture retains the reproduced pre-existing defective branch.',
    evidenceReferences: [EVIDENCE_ID],
    status: 'verified',
    confidence: 'high',
    unresolvedUncertainty: [],
  };
}

function defectReference(
  caseId = CASE_ID,
  projectId = PROJECT_ID,
): TrustedSyntheticDebugDefectReferenceRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'DEFECT_REFERENCE',
    sourceBoundary: 'TRUSTED_APPLICATION',
    baselineMode: 'DEFECT_REFERENCE',
    caseId,
    projectId,
    commitSha: REFERENCE_SHA,
    referenceVersion: 'v1.0.0-reference',
    historicalSearchBoundary: 'Owner-tested candidates v0.8.0 through v1.0.0 inclusive.',
    noOwnerVerifiedKnownGoodFound: true,
    defectEvidenceReferences: [EVIDENCE_ID],
    reasonSelected: 'This is the newest immutable SHA inside the documented tested boundary.',
    knownPreExistingDefects: ['The reproduced fixture branch is defective.'],
    knownUnrelatedFailures: ['An unrelated optional diagnostic is intentionally red.'],
    rollbackReferenceSemantics:
      'This SHA is an immutable comparison and rollback reference, not a known-good claim.',
    ownerAcknowledgement: {
      status: 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE',
      evidenceReference: `owner:${caseId}:defect-reference-acknowledgement`,
      acknowledgedNotKnownGood: true,
    },
    separateWriteApprovalRequired: true,
  };
}

function plan(caseId = CASE_ID, projectId = PROJECT_ID): SyntheticDebugImplementationPlanRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'IMPLEMENTATION_PLAN',
    caseId,
    projectId,
    planId: `plan-${caseId}`,
    authority: 'PROPOSAL_ONLY',
    allowedPaths: [CHANGED_PATH],
    requiredTestProfileIds: [PROFILE_ID],
    boundedChangeSummary: 'Correct only the reproduced fixture branch.',
    rollbackSha: REFERENCE_SHA,
    rollbackRef: REFERENCE_SHA,
    proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
    proposedWorkspaceId: `workspace-${caseId}`,
  };
}

function supportingEvidence(projectId: string) {
  return [
    {
      sourceReference: 'ci:green-reference',
      evidence: {
        project: projectId,
        commitSha: REFERENCE_SHA,
        version: 'v1.0.0-reference',
        state: 'verified_good' as const,
        source: 'regression_suite' as const,
        observedAt: '2026-08-20T00:00:00.000Z',
        note: 'Automated evidence is supporting only.',
      },
    },
    {
      sourceReference: 'release:newest-reference',
      evidence: {
        project: projectId,
        commitSha: REFERENCE_SHA,
        version: 'v1.0.0-reference',
        state: 'verified_good' as const,
        source: 'release_record' as const,
        observedAt: '2026-08-21T00:00:00.000Z',
        note: 'Release evidence is supporting only.',
      },
    },
  ];
}

interface ControllerOptions {
  readonly caseId?: string;
  readonly projectId?: string;
  readonly referenceInput?: unknown;
  readonly includeWriteApproval?: boolean;
  readonly includeWorker?: boolean;
  readonly includeReview?: boolean;
  readonly workerChangedPaths?: readonly string[];
}

function controllerFor(options: ControllerOptions = {}) {
  const caseId = options.caseId ?? CASE_ID;
  const projectId = options.projectId ?? PROJECT_ID;
  const requests = {
    taskD: [] as SyntheticDebugTaskDRequest[],
    taskF: [] as SyntheticDebugTaskFRequest[],
    taskG: [] as SyntheticDebugTaskGRequest[],
    taskI: [] as SyntheticDebugTaskIRequest[],
  };
  const taskD = {
    authorize: vi.fn((request: SyntheticDebugTaskDRequest) => {
      requests.taskD.push(request);
      return true;
    }),
    readRepositoryDiscovery: vi.fn(() => ({
      currentCandidate: {
        commitSha: REFERENCE_SHA,
        observedAt: '2026-08-22T00:00:00.000Z',
        sourceReference: 'repository:current-reference',
      },
      baselineEvidence: supportingEvidence(projectId),
    })),
    readAuthorizedMemoryEvidence: vi.fn(() => ({
      authorizationAppliedBeforeRanking: true,
      baselineEvidence: [],
    })),
    readTrustedBaseline: vi.fn(() => null),
    readTrustedDefectReference: vi.fn(
      () => options.referenceInput ?? defectReference(caseId, projectId),
    ),
  };
  const dependencies = {
    taskD,
    ...(options.includeWriteApproval === true
      ? {
          taskF: {
            readTrustedWriteApprovalDecision: vi.fn((request: SyntheticDebugTaskFRequest) => {
              requests.taskF.push(request);
              return {
                schemaVersion: '1.0',
                workflowKind: 'synthetic',
                recordKind: 'WRITE_APPROVAL_DECISION',
                sourceBoundary: 'TRUSTED_APPLICATION',
                caseId,
                projectId,
                proposalId: request.proposal.proposalId,
                decisionReferenceId: `approval-decision-${caseId}`,
                decision: 'APPROVED',
              };
            }),
          },
        }
      : {}),
    ...(options.includeWorker === true
      ? {
          taskG: {
            executeApprovedSyntheticImplementation: vi.fn((request: SyntheticDebugTaskGRequest) => {
              requests.taskG.push(request);
              const proposal = request.proposal;
              const timestamp = '2026-08-25T12:00:00.000Z';
              return {
                jobId: `worker-${caseId}`,
                projectId,
                baselineRef: proposal.baselineSha,
                workspaceBranch: proposal.proposedIsolatedBranch,
                workspacePath: `C:\\isolated\\${caseId}`,
                workspaceRetained: true,
                isolatedExecution: true,
                sourceHeadSha: proposal.baselineSha,
                headShaBefore: proposal.baselineSha,
                headShaAfter: CANDIDATE_SHA,
                changedPaths: options.workerChangedPaths ?? [CHANGED_PATH],
                actions: [
                  {
                    actionIndex: 0,
                    kind: 'apply_patch',
                    status: 'passed',
                    startedAt: timestamp,
                    finishedAt: timestamp,
                    summary: 'Applied the bounded approved patch.',
                    patchId: proposal.proposalId,
                  },
                  {
                    actionIndex: 1,
                    kind: 'run_test_profile',
                    status: 'passed',
                    startedAt: timestamp,
                    finishedAt: timestamp,
                    summary: 'Required profile passed.',
                    exitCode: 0,
                    profileId: PROFILE_ID,
                  },
                  {
                    actionIndex: 2,
                    kind: 'finalize_candidate',
                    status: 'passed',
                    startedAt: timestamp,
                    finishedAt: timestamp,
                    summary: 'Finalized the isolated candidate.',
                  },
                ],
              };
            }),
          },
        }
      : {}),
    ...(options.includeReview === true
      ? {
          taskI: {
            reviewVerifiedSyntheticCandidate: vi.fn((request: SyntheticDebugTaskIRequest) => {
              requests.taskI.push(request);
              const reviewPackage = request.reviewPackage;
              return {
                schemaVersion: '1.0',
                workflowKind: 'synthetic',
                recordKind: 'INDEPENDENT_REVIEW',
                sourceBoundary: 'INDEPENDENT_REVIEW_SERVICE',
                caseId,
                projectId,
                reviewId: `review-${caseId}`,
                reviewPackageId: reviewPackage.reviewPackageId,
                candidateSha: reviewPackage.candidateSha,
                disposition: 'pass',
                summary: 'Independent read-only review passed the bounded candidate.',
                findings: ['DEFECT_REFERENCE provenance remained explicit.'],
                blockers: [],
                evidenceInspected: [...reviewPackage.evidenceReferences],
              };
            }),
          },
        }
      : {}),
  };
  return {
    caseId,
    projectId,
    requests,
    controller: createSyntheticDebugDiscoveryController(dependencies),
  };
}

async function evidenceReady(
  bundle: ReturnType<typeof controllerFor>,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const created = bundle.controller.createCase(intake(bundle.caseId, bundle.projectId));
  if (!created.ok) throw new Error(created.error.message);
  const started = bundle.controller.startDiscovery(created.snapshot);
  if (!started.ok) throw new Error(started.error.message);
  const discovered = await bundle.controller.completeDiscovery(started.snapshot);
  if (!discovered.ok) throw new Error(discovered.error.message);
  return discovered.snapshot;
}

async function referenceReady(
  bundle: ReturnType<typeof controllerFor>,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const discovered = await evidenceReady(bundle);
  const analyzed = bundle.controller.recordEvidenceAndRootCause(
    discovered,
    rootCause(bundle.caseId, bundle.projectId),
  );
  if (!analyzed.ok) throw new Error(analyzed.error.message);
  const authorized = await bundle.controller.authorizeDefectReference(analyzed.snapshot);
  if (!authorized.ok) throw new Error(authorized.error.message);
  return authorized.snapshot;
}

async function implementationReady(
  bundle: ReturnType<typeof controllerFor>,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const referenced = await referenceReady(bundle);
  const gated = bundle.controller.evaluateImplementationGate(referenced);
  if (!gated.ok) throw new Error(gated.error.message);
  return gated.snapshot;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('C4.9 explicit DEFECT_REFERENCE exception mode', () => {
  it('keeps KNOWN_GOOD as the strict unchanged default with no evidence promotion fallback', async () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: REFERENCE_SHA,
        baselineOwnerVerified: true,
        evidenceItems: 1,
        rootCauseRecorded: true,
      }),
    ).toEqual({ allowed: true, blockers: [] });
    const defaultWithOnlyExceptionFacts = canStartImplementation({
      knownGoodBaselineSha: null,
      baselineOwnerVerified: false,
      defectReferenceSha: REFERENCE_SHA,
      defectReferenceOwnerAcknowledged: true,
      defectReferenceEntryRequirementsSatisfied: true,
      evidenceItems: 1,
      rootCauseRecorded: true,
    });
    expect(defaultWithOnlyExceptionFacts.blockers).toEqual(
      expect.arrayContaining([
        'no exact 40-character known-good baseline',
        'baseline lacks explicit owner verification',
        'KNOWN_GOOD mode cannot use a DEFECT_REFERENCE SHA',
      ]),
    );

    const bundle = controllerFor();
    const discovered = await evidenceReady(bundle);
    expect(discovered.baselineMode).toBe('KNOWN_GOOD');
    expect(discovered.discovery?.knownGoodResolution).toMatchObject({
      status: 'MISSING',
      commitSha: null,
    });
    expect(discovered.knownGoodBaseline).toBeNull();
    expect(discovered.defectReference).toBeNull();
  });

  it('allows root-cause evidence read-only before reference approval and blocks mutation', async () => {
    const bundle = controllerFor();
    const discovered = await evidenceReady(bundle);
    const analyzed = bundle.controller.recordEvidenceAndRootCause(
      discovered,
      rootCause(bundle.caseId, bundle.projectId),
    );
    expect(analyzed).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      transition: {
        event: 'RECORD_READ_ONLY_ROOT_CAUSE',
        from: 'EVIDENCE_READY',
        to: 'EVIDENCE_READY',
        reasons: [{ code: 'READ_ONLY_ROOT_CAUSE_RECORDED' }],
      },
      snapshot: {
        baselineMode: 'KNOWN_GOOD',
        machine: { state: 'EVIDENCE_READY' },
        writeProposal: null,
        writeApprovalDecision: null,
        workerExecution: null,
      },
    });
    if (!analyzed.ok) throw new Error(analyzed.error.message);
    expect(bundle.controller.evaluateImplementationGate(analyzed.snapshot)).toMatchObject({
      ok: false,
      error: { code: 'OUT_OF_ORDER' },
    });
    expect(await bundle.controller.executeApprovedImplementation(analyzed.snapshot)).toMatchObject({
      ok: false,
      error: { code: 'OUT_OF_ORDER' },
    });
    expect(bundle.requests.taskG).toEqual([]);
  });

  it.each([
    [
      'trusted owner acknowledgement',
      (record: Record<string, unknown>): void => {
        delete record.ownerAcknowledgement;
      },
    ],
    [
      'exact 40-character SHA',
      (record: Record<string, unknown>): void => {
        record.commitSha = 'not-a-sha';
      },
    ],
    [
      'historical search boundary',
      (record: Record<string, unknown>): void => {
        record.historicalSearchBoundary = '';
      },
    ],
    [
      'reproducible defect evidence',
      (record: Record<string, unknown>): void => {
        record.defectEvidenceReferences = [];
      },
    ],
    [
      'known pre-existing defect record',
      (record: Record<string, unknown>): void => {
        record.knownPreExistingDefects = [];
      },
    ],
    [
      'reference selection reason',
      (record: Record<string, unknown>): void => {
        record.reasonSelected = '';
      },
    ],
    [
      'rollback/reference semantics',
      (record: Record<string, unknown>): void => {
        record.rollbackReferenceSemantics = '';
      },
    ],
  ] satisfies readonly (readonly [string, (record: Record<string, unknown>) => void])[])(
    'rejects entry without %s',
    async (_label, mutate) => {
      const invalid = structuredClone(defectReference()) as unknown as Record<string, unknown>;
      mutate(invalid);
      const bundle = controllerFor({ referenceInput: invalid });
      const discovered = await evidenceReady(bundle);
      const analyzed = bundle.controller.recordEvidenceAndRootCause(discovered, rootCause());
      if (!analyzed.ok) throw new Error(analyzed.error.message);
      const result = await bundle.controller.authorizeDefectReference(analyzed.snapshot);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'MALFORMED_TRUSTED_DEFECT_REFERENCE' },
        snapshot: { baselineMode: 'KNOWN_GOOD', defectReference: null },
      });
      expect(bundle.requests.taskG).toEqual([]);
    },
  );

  it('requires explicit trusted owner acknowledgement independently of synthetic, CI, and release evidence', () => {
    const decision = canStartImplementation({
      baselineMode: 'DEFECT_REFERENCE',
      knownGoodBaselineSha: null,
      baselineOwnerVerified: false,
      defectReferenceSha: REFERENCE_SHA,
      defectReferenceOwnerAcknowledged: false,
      defectReferenceEntryRequirementsSatisfied: true,
      evidenceItems: 10,
      rootCauseRecorded: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain(
      'DEFECT_REFERENCE lacks explicit trusted owner acknowledgement',
    );
  });

  it('keeps exception selection outside every model role and rejects model-authored records', async () => {
    expect(() => parseModelSyntheticDebugRecord(defectReference())).toThrow();
    const bundle = controllerFor();
    const api = new SyntheticDebugApplicationApi({ orchestrator: bundle.controller });
    const serializedTools = JSON.stringify(
      (['coordinator', 'research', 'engineering', 'review'] as const).flatMap((role) =>
        createSyntheticDebugAgentTools(api, role).map((tool) =>
          tool.type === 'function' ? { name: tool.name, parameters: tool.parameters } : tool,
        ),
      ),
    );
    expect(serializedTools).not.toMatch(
      /authorizeDefectReference|DEFECT_REFERENCE|historicalSearchBoundary|ownerAcknowledgement/i,
    );

    const handle = { caseId: bundle.caseId, projectId: bundle.projectId };
    expect(api.createCase(intake()).ok).toBe(true);
    expect(api.startDiscovery(handle).ok).toBe(true);
    expect((await api.completeDiscovery(handle)).ok).toBe(true);
    expect(api.recordEvidenceAndRootCause(handle, rootCause())).toMatchObject({
      ok: true,
      snapshot: { nextAction: { action: 'AWAIT_DEFECT_REFERENCE_AUTHORIZATION' } },
    });
    for (const role of ['coordinator', 'research', 'engineering', 'review'] as const) {
      expect(createSyntheticDebugAgentTools(api, role).map(({ name }) => name)).not.toContain(
        'authorize_defect_reference',
      );
    }
  });

  it('enters DEFECT_REFERENCE only through the trusted facade and keeps write approval separate', async () => {
    const bundle = controllerFor();
    const referenced = await referenceReady(bundle);
    expect(referenced).toMatchObject({
      baselineMode: 'DEFECT_REFERENCE',
      knownGoodBaseline: null,
      defectReference: {
        commitSha: REFERENCE_SHA,
        ownerAcknowledgement: {
          status: 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE',
          acknowledgedNotKnownGood: true,
        },
      },
      machine: { state: 'ROOT_CAUSE_READY' },
    });
    const ready = bundle.controller.evaluateImplementationGate(referenced);
    expect(ready).toMatchObject({
      ok: true,
      snapshot: {
        machine: { state: 'IMPLEMENTATION_READY' },
        implementationGate: { allowed: true },
        writeApprovalDecision: null,
        workerExecution: null,
      },
    });
    if (!ready.ok) throw new Error(ready.error.message);
    expect(await bundle.controller.executeApprovedImplementation(ready.snapshot)).toMatchObject({
      ok: false,
      error: { code: 'OUT_OF_ORDER' },
    });
    const requested = bundle.controller.requestWriteApproval(ready.snapshot, plan());
    expect(requested).toMatchObject({
      ok: true,
      snapshot: {
        machine: { state: 'AWAITING_WRITE_APPROVAL' },
        writeApprovalDecision: null,
        workerExecution: null,
      },
    });
    expect(bundle.requests.taskG).toEqual([]);
  });

  it('carries the exact reference through isolated Worker orchestration and every final gate', async () => {
    const bundle = controllerFor({
      includeWriteApproval: true,
      includeWorker: true,
      includeReview: true,
    });
    const ready = await implementationReady(bundle);
    const requested = bundle.controller.requestWriteApproval(ready, plan());
    if (!requested.ok) throw new Error(requested.error.message);
    const approved = await bundle.controller.resolveWriteApproval(requested.snapshot);
    if (!approved.ok) throw new Error(approved.error.message);
    expect(approved.snapshot.machine.state).toBe('IMPLEMENTING');
    expect(bundle.requests.taskG).toEqual([]);

    const executed = await bundle.controller.executeApprovedImplementation(approved.snapshot);
    if (!executed.ok) throw new Error(executed.error.message);
    expect(executed.snapshot.machine.state).toBe('VERIFYING');
    const taskG = bundle.requests.taskG[0];
    expect(taskG).toMatchObject({
      accessMode: 'TRUSTED_WORKER_EXECUTION_ONLY',
      baselineMode: 'DEFECT_REFERENCE',
      proposal: {
        baselineSha: REFERENCE_SHA,
        rollbackSha: REFERENCE_SHA,
        approvedPaths: [CHANGED_PATH],
        proposedIsolatedBranch: `ks-leslie/synthetic/${CASE_ID}`,
      },
    });

    expect(await bundle.controller.evaluateFinalDelivery(executed.snapshot)).toMatchObject({
      ok: false,
      error: { code: 'OUT_OF_ORDER' },
    });
    const verified = await bundle.controller.evaluateVerification(executed.snapshot);
    if (!verified.ok) throw new Error(verified.error.message);
    expect(verified.snapshot).toMatchObject({
      machine: { state: 'REVIEWING' },
      verificationDecision: { status: 'PASSED', baselineMode: 'DEFECT_REFERENCE' },
      independentReview: null,
    });

    const reviewed = await bundle.controller.evaluateIndependentReview(verified.snapshot);
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    expect(bundle.requests.taskI[0]?.reviewPackage).toMatchObject({
      baselineMode: 'DEFECT_REFERENCE',
      referenceSha: REFERENCE_SHA,
      referenceWasOwnerVerifiedKnownGood: false,
      defectReference: {
        notOwnerVerifiedKnownGood: true,
        knownPreExistingDefects: ['The reproduced fixture branch is defective.'],
      },
    });

    const delivered = await bundle.controller.evaluateFinalDelivery(reviewed.snapshot);
    if (!delivered.ok) throw new Error(delivered.error.message);
    expect(delivered.snapshot).toMatchObject({
      machine: { state: 'TEST_READY' },
      finalDelivery: {
        status: 'TEST_READY',
        baselineMode: 'DEFECT_REFERENCE',
        baselineSha: REFERENCE_SHA,
        baselineOwnerVerified: false,
        referenceWasOwnerVerifiedKnownGood: false,
        candidateSha: CANDIDATE_SHA,
        implementationBasis:
          'Implementation was based on a DEFECT_REFERENCE that contained the documented pre-existing defect and was not owner-verified known-good.',
        productionReleaseStatus: 'OWNER_VERIFICATION_REQUIRED',
        defectReference: {
          referenceSha: REFERENCE_SHA,
          notOwnerVerifiedKnownGood: true,
          separateWriteApprovalRequired: true,
          historicalSearchBoundary: 'Owner-tested candidates v0.8.0 through v1.0.0 inclusive.',
        },
        review: { status: 'passed' },
        gate: { allowed: true, blockers: [] },
      },
    });
    const serializedReport = JSON.stringify(delivered.snapshot.finalDelivery);
    expect(serializedReport).not.toContain('"referenceWasOwnerVerifiedKnownGood":true');
    expect(serializedReport).not.toMatch(/DEFECT_REFERENCE (is|was) (known-good|defect-free)/i);
  });

  it('fails closed on changed paths outside the approved isolated Worker scope', async () => {
    const bundle = controllerFor({
      includeWriteApproval: true,
      includeWorker: true,
      workerChangedPaths: ['outside-scope.ts'],
    });
    const ready = await implementationReady(bundle);
    const requested = bundle.controller.requestWriteApproval(ready, plan());
    if (!requested.ok) throw new Error(requested.error.message);
    const approved = await bundle.controller.resolveWriteApproval(requested.snapshot);
    if (!approved.ok) throw new Error(approved.error.message);
    const executed = await bundle.controller.executeApprovedImplementation(approved.snapshot);
    expect(executed).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED' },
        workerExecution: { failure: { code: 'PATH_SCOPE_VIOLATION' }, candidateSha: null },
      },
    });
  });

  it('keeps verification and delivery mode-aware without treating the reference as known-good', () => {
    const input = {
      baselineMode: 'DEFECT_REFERENCE' as const,
      baselineSha: REFERENCE_SHA,
      baselineOwnerVerified: false,
      defectReferenceOwnerAcknowledged: true,
      defectReferenceEntryRequirementsSatisfied: true,
      candidateSha: CANDIDATE_SHA,
      isolatedBranch: `ks-leslie/synthetic/${CASE_ID}`,
      rollbackRef: REFERENCE_SHA,
      rollbackSha: REFERENCE_SHA,
      problemEvidenceItems: 1,
      rootCauseRecorded: true,
      approvedPaths: [CHANGED_PATH],
      changedPaths: [CHANGED_PATH],
      requiredProfileIds: [PROFILE_ID],
      verification: [{ profileId: PROFILE_ID, status: 'passed' as const }],
    };
    expect(canVerifyTestCandidate(input)).toEqual({ allowed: true, blockers: [] });
    expect(
      canVerifyTestCandidate({
        ...input,
        baselineOwnerVerified: true,
        defectReferenceOwnerAcknowledged: false,
      }).blockers,
    ).toEqual(
      expect.arrayContaining([
        'DEFECT_REFERENCE must not be marked owner-verified known-good',
        'delivery DEFECT_REFERENCE lacks trusted owner acknowledgement',
      ]),
    );
  });

  it('round-trips explicit DEFECT_REFERENCE provenance through durable memory as supporting only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ks-leslie-c4-9-memory-'));
    directories.push(directory);
    const store = new DurableMemoryStore(directory, {
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      eventIdFactory: (() => {
        let index = 0;
        return () => `c4-event-${String(++index)}`;
      })(),
    });
    const service = new MemoryService(store, {
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });
    const access = createTrustedMemoryAccessContext({
      actorId: 'trusted-c4-memory-sink',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_READ', 'MEMORY_INGEST'],
      projectGrants: [PROJECT_ID],
      allowedZones: ['PRIVATE_KINGSHADE_DEV'],
      tenantGrants: [],
    });
    const sink = new SyntheticDebugMemorySink(service, access, PROJECT_ID);
    await sink.persist({
      schemaVersion: '1.0',
      workflowKind: 'synthetic',
      caseId: CASE_ID,
      projectId: PROJECT_ID,
      finalDisposition: 'TEST_READY',
      baselineMode: 'DEFECT_REFERENCE',
      baselineSha: REFERENCE_SHA,
      referenceVersion: 'v1.0.0-reference',
      referenceWasOwnerVerifiedKnownGood: false,
      ownerAcknowledgement: {
        status: 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE',
        evidenceReference: `owner:${CASE_ID}:defect-reference-acknowledgement`,
      },
      historicalSearchBoundary: 'Owner-tested candidates v0.8.0 through v1.0.0 inclusive.',
      defectEvidenceProvenance: [
        {
          evidenceId: EVIDENCE_ID,
          kind: 'REPRODUCIBLE',
          reference: 'trusted-test:reproduction:c4-9',
        },
      ],
      knownPreExistingDefects: ['The reproduced fixture branch is defective.'],
      knownUnrelatedFailures: ['An unrelated optional diagnostic is intentionally red.'],
      referenceSelectionReason:
        'This is the newest immutable SHA inside the documented tested boundary.',
      rollbackReferenceSemantics:
        'This SHA is an immutable comparison and rollback reference, not a known-good claim.',
      writeApprovalProvenance: {
        decisionReferenceId: `approval-decision-${CASE_ID}`,
        decision: 'APPROVED',
      },
      candidateSha: CANDIDATE_SHA,
      verificationDecisionId: `verification-${CASE_ID}`,
      verificationStatus: 'PASSED',
      verificationProfiles: [{ profileId: PROFILE_ID, status: 'passed' }],
      reviewId: `review-${CASE_ID}`,
      reviewDisposition: 'pass',
      failureCodes: [],
    });
    const retrieved = await service.retrieve(access, {
      query: 'Synthetic C4 DEFECT REFERENCE',
      kinds: ['BASELINE_EVIDENCE'],
      limit: 4,
    });
    expect(retrieved.authorizationAppliedBeforeRanking).toBe(true);
    expect(retrieved.records).toHaveLength(1);
    expect(retrieved.records[0]).toMatchObject({
      evidenceClassification: 'AUTOMATED_TEST',
      verificationState: 'SUPPORTING',
    });
    expect(retrieved.records[0]).not.toHaveProperty('ownerVerificationEvidence');
    const content = JSON.parse(retrieved.records[0]?.content ?? '{}') as Record<string, unknown>;
    expect(content).toMatchObject({
      baselineMode: 'DEFECT_REFERENCE',
      referenceSha: REFERENCE_SHA,
      referenceWasOwnerVerifiedKnownGood: false,
      historicalSearchBoundary: 'Owner-tested candidates v0.8.0 through v1.0.0 inclusive.',
      knownPreExistingDefects: ['The reproduced fixture branch is defective.'],
      separateWriteApprovalRequired: true,
      writeApprovalProvenance: {
        decisionReferenceId: `approval-decision-${CASE_ID}`,
        decision: 'APPROVED',
      },
    });
  });

  it('registers the approved War Dibs RW-MVP reference without touching production code', async () => {
    const caseId = 'ks-torn-war-dibs-rw-mvp';
    const projectId = 'ks-torn-war-dibs';
    const warReference: TrustedSyntheticDebugDefectReferenceRecord = {
      ...defectReference(caseId, projectId),
      commitSha: 'ab35607c20819819984b4cd682c9a51d2ab27eda',
      referenceVersion: 'v1.5.143',
      historicalSearchBoundary:
        'No owner-verified defect-free baseline was found among the tested minimum historical candidates.',
      reasonSelected:
        'v1.5.143 is the approved immutable DEFECT_REFERENCE; dirty v1.5.144 is not the reference.',
      knownPreExistingDefects: ['The RW-MVP defect is reproducible on the v1.5.143 reference.'],
      knownUnrelatedFailures: [
        'Existing unrelated diagnostic failures remain recorded separately.',
      ],
      rollbackReferenceSemantics:
        'Return to exact v1.5.143 reference state for comparison only; this is not known-good.',
    };
    const bundle = controllerFor({ caseId, projectId, referenceInput: warReference });
    const referenced = await referenceReady(bundle);
    const gated = bundle.controller.evaluateImplementationGate(referenced);
    expect(gated).toMatchObject({
      ok: true,
      snapshot: {
        baselineMode: 'DEFECT_REFERENCE',
        knownGoodBaseline: null,
        defectReference: {
          commitSha: 'ab35607c20819819984b4cd682c9a51d2ab27eda',
          referenceVersion: 'v1.5.143',
          reasonSelected:
            'v1.5.143 is the approved immutable DEFECT_REFERENCE; dirty v1.5.144 is not the reference.',
          ownerAcknowledgement: { acknowledgedNotKnownGood: true },
        },
        machine: { state: 'IMPLEMENTATION_READY' },
        writeProposal: null,
        writeApprovalDecision: null,
        workerExecution: null,
      },
    });
    expect(bundle.requests.taskF).toEqual([]);
    expect(bundle.requests.taskG).toEqual([]);
  });
});
