import { createHash } from 'node:crypto';

import { z } from 'zod';

import { selectKnownGoodBaseline, type BaselineEvidence } from '../repository/baseline.js';
import { redactRepositorySecrets } from '../repository/validation.js';
import type { SyntheticDebugBaselineMode } from './baseline-mode.js';
import { canStartImplementation, isFullCommitSha, type GateDecision } from './gates.js';
import { independentReviewForDelivery } from './independent-review.js';
import {
  adaptSyntheticDebugIndependentReview,
  buildSyntheticDebugIndependentReviewPackage,
  type SyntheticDebugIndependentReviewPackage,
} from './independent-review.js';
import { buildDebugDeliveryReport, type DebugDeliveryReport } from './report.js';
import {
  parseModelSyntheticDebugRecord,
  parseTrustedSyntheticDebugApprovalDecision,
  parseTrustedSyntheticDebugBaselineRecord,
  parseTrustedSyntheticDebugDefectReferenceRecord,
  syntheticDebugWriteProposalSchema,
  trustedSyntheticDebugDefectReferenceRecordSchema,
  trustedSyntheticDebugApprovalDecisionSchema,
  type SyntheticDebugEvidenceReference,
  type SyntheticDebugImplementationPlanRecord,
  type SyntheticDebugIntakeRecord,
  type SyntheticDebugRootCauseRecord,
  type SyntheticDebugWriteProposal,
  type TrustedSyntheticDebugApprovalDecision,
  type TrustedSyntheticDebugBaselineRecord,
  type TrustedSyntheticDebugDefectReferenceRecord,
  type TrustedSyntheticDebugReferenceRecord,
  type TrustedSyntheticDebugReviewRecord,
} from './records.js';
import {
  adaptSyntheticDebugWorkerError,
  adaptSyntheticDebugWorkerResult,
  type SyntheticDebugWorkerExecutionRecord,
} from './worker-execution.js';
import {
  createSyntheticDebugMachine,
  isSyntheticDebugTerminalState,
  transitionSyntheticDebugMachine,
  type SyntheticDebugEvent,
  type SyntheticDebugMachineSnapshot,
  type SyntheticDebugState,
  type SyntheticDebugTransitionReason,
  type SyntheticDebugTransitionRecord,
} from './state-machine.js';
import {
  verifySyntheticDebugWorkerExecution,
  type SyntheticDebugVerificationDecision,
} from './verification.js';

const MAX_DISCOVERY_EVIDENCE = 200;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POSSIBLE_OPAQUE_APPROVAL_SECRET = /\b[0-9a-f]{64}\b/i;
const REPRODUCIBLE_EVIDENCE_KINDS = new Set<SyntheticDebugEvidenceReference['kind']>([
  'REPRODUCIBLE',
  'AUTOMATED_TEST',
  'SYNTHETIC_FIXTURE',
]);

const exactCommitShaSchema = z
  .string()
  .refine((value) => isFullCommitSha(value), 'Expected an exact 40-character commit SHA')
  .transform((value) => value.toLowerCase());

const canonicalTimestampSchema = z.string().refine((value) => {
  if (!CANONICAL_UTC_TIMESTAMP.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}, 'Expected a canonical UTC timestamp');

const sourceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !value.includes('\0'), 'Reference cannot contain NUL');

const baselineEvidenceSchema = z
  .object({
    project: z.string().trim().min(1).max(80),
    commitSha: exactCommitShaSchema,
    version: z.string().trim().min(1).max(128).optional(),
    state: z.enum(['verified_good', 'failed', 'candidate', 'unknown']),
    source: z.enum(['owner_verification', 'regression_suite', 'release_record', 'manual_review']),
    observedAt: canonicalTimestampSchema,
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const observationSchema = z
  .object({
    sourceReference: sourceReferenceSchema,
    evidence: baselineEvidenceSchema,
  })
  .strict();

const currentCandidateSchema = z
  .object({
    commitSha: exactCommitShaSchema,
    observedAt: canonicalTimestampSchema,
    sourceReference: sourceReferenceSchema,
  })
  .strict();

const repositoryDiscoverySchema = z
  .object({
    currentCandidate: currentCandidateSchema.nullable(),
    baselineEvidence: z.array(observationSchema).max(MAX_DISCOVERY_EVIDENCE),
  })
  .strict()
  .superRefine((result, context) => {
    for (const [index, observation] of result.baselineEvidence.entries()) {
      if (observation.evidence.source === 'owner_verification') {
        context.addIssue({
          code: 'custom',
          path: ['baselineEvidence', index, 'evidence', 'source'],
          message: 'Repository evidence cannot establish owner verification',
        });
      }
    }
  });

const authorizedMemoryDiscoverySchema = z
  .object({
    authorizationAppliedBeforeRanking: z.literal(true),
    baselineEvidence: z.array(observationSchema).max(MAX_DISCOVERY_EVIDENCE),
  })
  .strict();

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type DiscoveryObservation = DeepReadonly<
  z.infer<typeof observationSchema> & {
    origin: 'REPOSITORY_INTELLIGENCE' | 'AUTHORIZED_MEMORY';
  }
>;

export type SyntheticDebugTaskDOperation =
  | 'READ_ONLY_DISCOVERY'
  | 'RESOLVE_TRUSTED_BASELINE'
  | 'RESOLVE_TRUSTED_DEFECT_REFERENCE';

export interface SyntheticDebugTaskDRequest {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly accessMode: 'READ_ONLY';
  readonly operation: SyntheticDebugTaskDOperation;
  readonly caseId: string;
  readonly projectId: string;
}

export interface SyntheticDebugTaskDCapability {
  readonly authorize: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readRepositoryDiscovery: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readAuthorizedMemoryEvidence: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readTrustedBaseline: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readTrustedDefectReference?: (request: SyntheticDebugTaskDRequest) => unknown;
}

export type SyntheticDebugTaskFOperation = 'READ_TRUSTED_WRITE_APPROVAL_DECISION';

export interface SyntheticDebugTaskFRequest {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly accessMode: 'TRUSTED_APPLICATION_DECISION_ONLY';
  readonly operation: SyntheticDebugTaskFOperation;
  readonly caseId: string;
  readonly projectId: string;
  readonly proposal: DeepReadonly<SyntheticDebugWriteProposal>;
}

export interface SyntheticDebugTaskFCapability {
  readonly readTrustedWriteApprovalDecision: (request: SyntheticDebugTaskFRequest) => unknown;
}

export type SyntheticDebugTaskGOperation = 'EXECUTE_APPROVED_SYNTHETIC_IMPLEMENTATION';

export interface SyntheticDebugTaskGRequest {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly accessMode: 'TRUSTED_WORKER_EXECUTION_ONLY';
  readonly operation: SyntheticDebugTaskGOperation;
  readonly caseId: string;
  readonly projectId: string;
  readonly baselineMode: SyntheticDebugBaselineMode;
  readonly approvalDecisionReferenceId: string;
  readonly proposal: DeepReadonly<SyntheticDebugWriteProposal>;
}

export interface SyntheticDebugTaskGCapability {
  readonly executeApprovedSyntheticImplementation: (request: SyntheticDebugTaskGRequest) => unknown;
}

export type SyntheticDebugTaskIOperation = 'REVIEW_VERIFIED_SYNTHETIC_CANDIDATE';

export interface SyntheticDebugTaskIRequest {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly accessMode: 'INDEPENDENT_REVIEW_SERVICE_ONLY';
  readonly operation: SyntheticDebugTaskIOperation;
  readonly reviewPackage: DeepReadonly<SyntheticDebugIndependentReviewPackage>;
}

export interface SyntheticDebugTaskICapability {
  readonly reviewVerifiedSyntheticCandidate: (request: SyntheticDebugTaskIRequest) => unknown;
}

export interface SyntheticDebugOrchestratorDependencies {
  readonly taskD?: SyntheticDebugTaskDCapability;
  readonly taskF?: SyntheticDebugTaskFCapability;
  readonly taskG?: SyntheticDebugTaskGCapability;
  readonly taskI?: SyntheticDebugTaskICapability;
}

export interface SyntheticDebugCurrentCandidate {
  readonly commitSha: string;
  readonly observedAt: string;
  readonly sourceReference: string;
  readonly confidence: 'CANDIDATE' | 'INVALIDATED';
  readonly invalidatedBy: readonly string[];
}

export interface SyntheticDebugKnownGoodResolution {
  readonly status: 'RESOLVED' | 'MISSING' | 'CONFLICT';
  readonly commitSha: string | null;
  readonly sourceReferences: readonly string[];
  readonly conflictingCommitShas: readonly string[];
  readonly consideredCommits: number;
}

export interface SyntheticDebugDiscoverySummary {
  readonly currentCandidate: SyntheticDebugCurrentCandidate | null;
  readonly baselineEvidence: readonly DiscoveryObservation[];
  readonly knownGoodResolution: SyntheticDebugKnownGoodResolution;
}

export interface SyntheticDebugOrchestrationSnapshot {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly caseId: string;
  readonly projectId: string;
  readonly machine: SyntheticDebugMachineSnapshot;
  readonly intake: DeepReadonly<SyntheticDebugIntakeRecord>;
  readonly discovery: SyntheticDebugDiscoverySummary | null;
  readonly baselineMode: SyntheticDebugBaselineMode;
  readonly knownGoodBaseline: DeepReadonly<TrustedSyntheticDebugBaselineRecord> | null;
  readonly defectReference: DeepReadonly<TrustedSyntheticDebugDefectReferenceRecord> | null;
  readonly reproducibleDefectEvidence: readonly DeepReadonly<SyntheticDebugEvidenceReference>[];
  readonly rootCause: DeepReadonly<SyntheticDebugRootCauseRecord> | null;
  readonly implementationGate: DeepReadonly<GateDecision> | null;
  readonly writeProposal: DeepReadonly<SyntheticDebugWriteProposal> | null;
  readonly writeApprovalDecision: DeepReadonly<TrustedSyntheticDebugApprovalDecision> | null;
  readonly workerExecution: DeepReadonly<SyntheticDebugWorkerExecutionRecord> | null;
  readonly verificationDecision: DeepReadonly<SyntheticDebugVerificationDecision> | null;
  readonly independentReviewPackage: DeepReadonly<SyntheticDebugIndependentReviewPackage> | null;
  readonly independentReview: DeepReadonly<TrustedSyntheticDebugReviewRecord> | null;
  readonly finalDelivery: DeepReadonly<DebugDeliveryReport> | null;
}

export type SyntheticDebugOrchestrationOperation =
  | 'CREATE_CASE'
  | 'START_DISCOVERY'
  | 'COMPLETE_DISCOVERY'
  | 'RESOLVE_TRUSTED_BASELINE'
  | 'AUTHORIZE_DEFECT_REFERENCE'
  | 'RECORD_EVIDENCE_AND_ROOT_CAUSE'
  | 'EVALUATE_IMPLEMENTATION_GATE'
  | 'REQUEST_WRITE_APPROVAL'
  | 'RESOLVE_WRITE_APPROVAL'
  | 'EXECUTE_APPROVED_IMPLEMENTATION'
  | 'EVALUATE_VERIFICATION'
  | 'EVALUATE_INDEPENDENT_REVIEW'
  | 'EVALUATE_FINAL_DELIVERY';

export type SyntheticDebugOrchestrationErrorCode =
  | 'MALFORMED_MODEL_RECORD'
  | 'UNSUPPORTED_RECORD_KIND'
  | 'EVIDENCE_SCOPE_MISMATCH'
  | 'ROOT_CAUSE_SCOPE_MISMATCH'
  | 'IMPLEMENTATION_PLAN_SCOPE_MISMATCH'
  | 'IMPLEMENTATION_PLAN_BASELINE_MISMATCH'
  | 'MALFORMED_TRUSTED_DEFECT_REFERENCE'
  | 'TRUSTED_DEFECT_REFERENCE_SCOPE_MISMATCH'
  | 'DEFECT_REFERENCE_ENTRY_REQUIREMENTS_NOT_MET'
  | 'IMPLEMENTATION_GATE_INVARIANT'
  | 'SENSITIVE_WRITE_PROPOSAL'
  | 'WRITE_PROPOSAL_ALREADY_EXISTS'
  | 'WRITE_PROPOSAL_INTEGRITY_MISMATCH'
  | 'MALFORMED_TRUSTED_APPROVAL'
  | 'TRUSTED_APPROVAL_SCOPE_MISMATCH'
  | 'TRUSTED_APPROVAL_REPLAY_MISMATCH'
  | 'WORKER_EXECUTION_INTEGRITY_MISMATCH'
  | 'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH'
  | 'FINAL_DELIVERY_INTEGRITY_MISMATCH'
  | 'OUT_OF_ORDER'
  | 'TERMINAL_STATE'
  | 'TRANSITION_REJECTED';

export interface SyntheticDebugOrchestrationError {
  readonly code: SyntheticDebugOrchestrationErrorCode;
  readonly operation: SyntheticDebugOrchestrationOperation;
  readonly message: string;
  readonly state: SyntheticDebugState | null;
}

export type SyntheticDebugOrchestrationCreateResult =
  | {
      readonly ok: true;
      readonly status: 'CREATED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
    }
  | {
      readonly ok: false;
      readonly status: 'REJECTED';
      readonly error: SyntheticDebugOrchestrationError;
    };

export type SyntheticDebugOrchestrationResult =
  | {
      readonly ok: true;
      readonly status: 'ADVANCED' | 'BLOCKED' | 'FAILED' | 'CANCELLED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
      readonly transition: SyntheticDebugTransitionRecord;
    }
  | {
      readonly ok: false;
      readonly status: 'REJECTED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
      readonly error: SyntheticDebugOrchestrationError;
    };

export interface SyntheticDebugDiscoveryController {
  createCase(input: unknown): SyntheticDebugOrchestrationCreateResult;
  startDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot): SyntheticDebugOrchestrationResult;
  completeDiscovery(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  resolveTrustedBaseline(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  authorizeDefectReference(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  recordEvidenceAndRootCause(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    rootCauseInput: unknown,
  ): SyntheticDebugOrchestrationResult;
  evaluateImplementationGate(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): SyntheticDebugOrchestrationResult;
  requestWriteApproval(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    implementationPlanInput: unknown,
  ): SyntheticDebugOrchestrationResult;
  resolveWriteApproval(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  executeApprovedImplementation(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  evaluateVerification(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  evaluateIndependentReview(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  evaluateFinalDelivery(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function error(
  code: SyntheticDebugOrchestrationErrorCode,
  operation: SyntheticDebugOrchestrationOperation,
  message: string,
  state: SyntheticDebugState | null,
): SyntheticDebugOrchestrationError {
  return Object.freeze({ code, operation, message, state });
}

function reject(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  code: SyntheticDebugOrchestrationErrorCode,
  message: string,
): SyntheticDebugOrchestrationResult {
  return Object.freeze({
    ok: false,
    status: 'REJECTED',
    snapshot,
    error: error(code, operation, message, snapshot.machine.state),
  });
}

function requireState(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  expected: SyntheticDebugState,
): SyntheticDebugOrchestrationResult | null {
  if (isSyntheticDebugTerminalState(snapshot.machine.state)) {
    return reject(
      snapshot,
      operation,
      'TERMINAL_STATE',
      `State ${snapshot.machine.state} is terminal`,
    );
  }
  if (snapshot.machine.state !== expected) {
    return reject(
      snapshot,
      operation,
      'OUT_OF_ORDER',
      `${operation} requires state ${expected}; current state is ${snapshot.machine.state}`,
    );
  }
  return null;
}

type SyntheticDebugSnapshotPatch = Partial<
  Pick<
    SyntheticDebugOrchestrationSnapshot,
    | 'discovery'
    | 'baselineMode'
    | 'knownGoodBaseline'
    | 'defectReference'
    | 'reproducibleDefectEvidence'
    | 'rootCause'
    | 'implementationGate'
    | 'writeProposal'
    | 'writeApprovalDecision'
    | 'workerExecution'
    | 'verificationDecision'
    | 'independentReviewPackage'
    | 'independentReview'
    | 'finalDelivery'
  >
>;

function apply(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  event: SyntheticDebugEvent,
  reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
  status: 'ADVANCED' | 'BLOCKED' | 'FAILED' | 'CANCELLED',
  patch: SyntheticDebugSnapshotPatch = {},
): SyntheticDebugOrchestrationResult {
  const transitioned = transitionSyntheticDebugMachine(snapshot.machine, { event, reasons });
  if (!transitioned.ok) {
    return reject(
      snapshot,
      operation,
      'TRANSITION_REJECTED',
      `State machine rejected ${event}: ${transitioned.error.code}`,
    );
  }
  const next = deepFreeze({ ...snapshot, ...patch, machine: transitioned.snapshot });
  return Object.freeze({ ok: true, status, snapshot: next, transition: transitioned.transition });
}

function block(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
  patch: SyntheticDebugSnapshotPatch = {},
): SyntheticDebugOrchestrationResult {
  return apply(snapshot, operation, 'BLOCK', reasons, 'BLOCKED', patch);
}

function cancel(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
  patch: SyntheticDebugSnapshotPatch = {},
): SyntheticDebugOrchestrationResult {
  return apply(snapshot, operation, 'CANCEL', reasons, 'CANCELLED', patch);
}

function fail(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  code: string,
  summary: string,
  patch: SyntheticDebugSnapshotPatch = {},
): SyntheticDebugOrchestrationResult {
  return apply(snapshot, operation, 'FAIL', [{ code, summary }], 'FAILED', patch);
}

function request(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugTaskDOperation,
): SyntheticDebugTaskDRequest {
  return Object.freeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    accessMode: 'READ_ONLY',
    operation,
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
  });
}

type SyntheticDebugWriteProposalContent = Omit<SyntheticDebugWriteProposal, 'proposalId'>;

function selectedReferenceRecord(
  snapshot: SyntheticDebugOrchestrationSnapshot,
): DeepReadonly<TrustedSyntheticDebugReferenceRecord> | null {
  return snapshot.baselineMode === 'KNOWN_GOOD'
    ? snapshot.knownGoodBaseline
    : snapshot.defectReference;
}

function selectedReferenceSha(snapshot: SyntheticDebugOrchestrationSnapshot): string | null {
  return selectedReferenceRecord(snapshot)?.commitSha.toLowerCase() ?? null;
}

function defectReferenceEntryRequirementsSatisfied(
  snapshot: SyntheticDebugOrchestrationSnapshot,
): boolean {
  const reference = snapshot.defectReference;
  if (
    snapshot.baselineMode !== 'DEFECT_REFERENCE' ||
    reference === null ||
    !trustedSyntheticDebugDefectReferenceRecordSchema.safeParse(reference).success ||
    snapshot.knownGoodBaseline !== null ||
    snapshot.discovery?.knownGoodResolution.status !== 'MISSING' ||
    reference.caseId !== snapshot.caseId ||
    reference.projectId !== snapshot.projectId ||
    reference.historicalSearchBoundary.trim().length === 0 ||
    reference.reasonSelected.trim().length === 0 ||
    reference.knownPreExistingDefects.length === 0 ||
    reference.rollbackReferenceSemantics.trim().length === 0
  ) {
    return false;
  }
  const evidence = new Map(
    snapshot.intake.evidenceReferences.map((item) => [item.evidenceId, item] as const),
  );
  const recordedEvidenceIds = new Set(
    snapshot.reproducibleDefectEvidence.map(({ evidenceId }) => evidenceId),
  );
  return reference.defectEvidenceReferences.every((evidenceId) => {
    const item = evidence.get(evidenceId);
    return (
      item !== undefined &&
      REPRODUCIBLE_EVIDENCE_KINDS.has(item.kind) &&
      recordedEvidenceIds.has(evidenceId)
    );
  });
}

function writeProposalContent(
  plan: SyntheticDebugImplementationPlanRecord,
  baselineSha: string,
): SyntheticDebugWriteProposalContent {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'WRITE_PROPOSAL',
    caseId: plan.caseId,
    projectId: plan.projectId,
    planId: plan.planId,
    baselineSha: baselineSha.toLowerCase(),
    boundedChangeSummary: plan.boundedChangeSummary,
    approvedPaths: [...plan.allowedPaths].sort(),
    requiredTestProfileIds: [...plan.requiredTestProfileIds].sort(),
    rollbackSha: plan.rollbackSha.toLowerCase(),
    rollbackRef: plan.rollbackRef,
    proposedIsolatedBranch: plan.proposedIsolatedBranch,
    proposedWorkspaceId: plan.proposedWorkspaceId,
  };
}

function writeProposalIdentifier(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposalContent>,
): string {
  const binding = JSON.stringify({
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    intake: snapshot.intake,
    discovery: snapshot.discovery,
    baselineMode: snapshot.baselineMode,
    knownGoodBaseline: snapshot.knownGoodBaseline,
    defectReference: snapshot.defectReference,
    reproducibleDefectEvidence: snapshot.reproducibleDefectEvidence,
    rootCause: snapshot.rootCause,
    implementationGate: snapshot.implementationGate,
    proposal,
  });
  return `write-proposal-${createHash('sha256').update(binding, 'utf8').digest('hex')}`;
}

function buildWriteProposal(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  plan: SyntheticDebugImplementationPlanRecord,
): DeepReadonly<SyntheticDebugWriteProposal> {
  const baselineSha = selectedReferenceSha(snapshot) ?? '';
  const content = writeProposalContent(plan, baselineSha);
  return deepFreeze({
    ...content,
    proposalId: writeProposalIdentifier(snapshot, content),
  });
}

function sealedWriteProposalMatchesSnapshot(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
): boolean {
  const { proposalId, ...content } = proposal;
  const referenceSha = selectedReferenceSha(snapshot);
  return (
    referenceSha !== null &&
    snapshot.implementationGate?.allowed === true &&
    proposal.caseId === snapshot.caseId &&
    proposal.projectId === snapshot.projectId &&
    proposal.baselineSha === referenceSha &&
    proposal.rollbackSha === proposal.baselineSha &&
    proposalId === writeProposalIdentifier(snapshot, content)
  );
}

function pendingWriteProposalMatchesSnapshot(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
): boolean {
  return (
    snapshot.writeApprovalDecision === null &&
    sealedWriteProposalMatchesSnapshot(snapshot, proposal)
  );
}

function approvedWriteProposalMatchesSnapshot(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
  decision: DeepReadonly<TrustedSyntheticDebugApprovalDecision>,
): boolean {
  return (
    decision.decision === 'APPROVED' &&
    decision.caseId === snapshot.caseId &&
    decision.projectId === snapshot.projectId &&
    decision.proposalId === proposal.proposalId &&
    sealedWriteProposalMatchesSnapshot(snapshot, proposal)
  );
}

function containsSensitiveWriteProposalContent(
  plan: SyntheticDebugImplementationPlanRecord,
): boolean {
  const serialized = JSON.stringify(plan);
  return (
    POSSIBLE_OPAQUE_APPROVAL_SECRET.test(serialized) ||
    redactRepositorySecrets(serialized).redactionCount > 0
  );
}

function taskFRequest(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
): SyntheticDebugTaskFRequest {
  return deepFreeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    accessMode: 'TRUSTED_APPLICATION_DECISION_ONLY',
    operation: 'READ_TRUSTED_WRITE_APPROVAL_DECISION',
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    proposal,
  });
}

function taskGRequest(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
  decision: DeepReadonly<TrustedSyntheticDebugApprovalDecision>,
): SyntheticDebugTaskGRequest {
  return deepFreeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    accessMode: 'TRUSTED_WORKER_EXECUTION_ONLY',
    operation: 'EXECUTE_APPROVED_SYNTHETIC_IMPLEMENTATION',
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    baselineMode: snapshot.baselineMode,
    approvalDecisionReferenceId: decision.decisionReferenceId,
    proposal,
  });
}

function taskIRequest(
  reviewPackage: DeepReadonly<SyntheticDebugIndependentReviewPackage>,
): SyntheticDebugTaskIRequest {
  return deepFreeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    accessMode: 'INDEPENDENT_REVIEW_SERVICE_ONLY',
    operation: 'REVIEW_VERIFIED_SYNTHETIC_CANDIDATE',
    reviewPackage,
  });
}

function caseBindingKey(snapshot: SyntheticDebugOrchestrationSnapshot): string {
  return JSON.stringify([snapshot.projectId, snapshot.caseId]);
}

function writeApprovalBindingKey(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
): string {
  return JSON.stringify([snapshot.projectId, snapshot.caseId, proposal.proposalId]);
}

function workerExecutionBindingKey(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  proposal: DeepReadonly<SyntheticDebugWriteProposal>,
  decision: DeepReadonly<TrustedSyntheticDebugApprovalDecision>,
): string {
  return JSON.stringify([
    snapshot.projectId,
    snapshot.caseId,
    proposal.proposalId,
    decision.decisionReferenceId,
  ]);
}

async function authorize(
  capability: SyntheticDebugTaskDCapability,
  operationRequest: SyntheticDebugTaskDRequest,
): Promise<'ALLOWED' | 'DENIED' | 'ERROR'> {
  try {
    const decision = await capability.authorize(operationRequest);
    return typeof decision === 'boolean' ? (decision ? 'ALLOWED' : 'DENIED') : 'ERROR';
  } catch {
    return 'ERROR';
  }
}

function candidateSummary(
  candidate: z.infer<typeof currentCandidateSchema> | null,
  observations: readonly DiscoveryObservation[],
): SyntheticDebugCurrentCandidate | null {
  if (candidate === null) return null;
  const candidateTime = Date.parse(candidate.observedAt);
  const invalidatedBy = observations
    .filter(
      ({ evidence }) =>
        evidence.commitSha === candidate.commitSha &&
        evidence.state === 'failed' &&
        Date.parse(evidence.observedAt) > candidateTime,
    )
    .map(({ sourceReference }) => sourceReference)
    .filter((reference, index, references) => references.indexOf(reference) === index)
    .sort();
  return deepFreeze({
    ...candidate,
    confidence: invalidatedBy.length > 0 ? ('INVALIDATED' as const) : ('CANDIDATE' as const),
    invalidatedBy,
  });
}

function knownGoodSummary(
  observations: readonly DiscoveryObservation[],
  projectId: string,
): SyntheticDebugKnownGoodResolution {
  const evidence: BaselineEvidence[] = observations.map(({ evidence: item }) => ({
    project: item.project,
    commitSha: item.commitSha,
    state: item.state,
    source: item.source,
    observedAt: item.observedAt,
    ...(item.version === undefined ? {} : { version: item.version }),
    ...(item.note === undefined ? {} : { note: item.note }),
  }));
  const decision = selectKnownGoodBaseline(evidence, projectId);
  const activeOwnerShas = decision.assessments
    .filter(({ eligible, ownerVerification }) => eligible && ownerVerification !== undefined)
    .map(({ commitSha }) => commitSha)
    .filter((sha, index, shas) => shas.indexOf(sha) === index)
    .sort();

  if (activeOwnerShas.length > 1) {
    return deepFreeze({
      status: 'CONFLICT' as const,
      commitSha: null,
      sourceReferences: [],
      conflictingCommitShas: activeOwnerShas,
      consideredCommits: decision.consideredCommits,
    });
  }
  if (decision.baseline === null) {
    return deepFreeze({
      status: 'MISSING' as const,
      commitSha: null,
      sourceReferences: [],
      conflictingCommitShas: [],
      consideredCommits: decision.consideredCommits,
    });
  }

  const selected = decision.baseline;
  const sourceReferences = observations
    .filter(
      ({ evidence }) =>
        evidence.commitSha === selected.commitSha &&
        evidence.source === selected.source &&
        evidence.state === selected.state &&
        evidence.observedAt === selected.observedAt,
    )
    .map(({ sourceReference }) => sourceReference)
    .filter((reference, index, references) => references.indexOf(reference) === index)
    .sort();
  return deepFreeze({
    status: 'RESOLVED' as const,
    commitSha: selected.commitSha,
    sourceReferences,
    conflictingCommitShas: [],
    consideredCommits: decision.consideredCommits,
  });
}

function discoverySummary(
  projectId: string,
  repository: z.infer<typeof repositoryDiscoverySchema>,
  memory: z.infer<typeof authorizedMemoryDiscoverySchema>,
): SyntheticDebugDiscoverySummary | null {
  const observations: DiscoveryObservation[] = [
    ...repository.baselineEvidence.map((observation) =>
      deepFreeze({ ...observation, origin: 'REPOSITORY_INTELLIGENCE' as const }),
    ),
    ...memory.baselineEvidence.map((observation) =>
      deepFreeze({ ...observation, origin: 'AUTHORIZED_MEMORY' as const }),
    ),
  ];
  if (observations.some(({ evidence }) => evidence.project !== projectId)) return null;
  return deepFreeze({
    currentCandidate: candidateSummary(repository.currentCandidate, observations),
    baselineEvidence: observations,
    knownGoodResolution: knownGoodSummary(observations, projectId),
  });
}

function baselineBlockers(
  discovery: SyntheticDebugDiscoverySummary,
  baseline: TrustedSyntheticDebugBaselineRecord | null,
): SyntheticDebugTransitionReason[] {
  const resolution = discovery.knownGoodResolution;
  const blockers: SyntheticDebugTransitionReason[] = [];
  if (resolution.status === 'CONFLICT') {
    blockers.push({
      code: 'CONTRADICTORY_OWNER_VERIFIED_BASELINES',
      summary: `Conflicting owner-verified baseline SHAs: ${resolution.conflictingCommitShas.join(', ')}.`,
    });
  } else if (resolution.status === 'MISSING') {
    blockers.push({
      code: 'OWNER_VERIFIED_BASELINE_MISSING',
      summary: 'No exact owner-verified known-good baseline is available.',
    });
  }
  if (baseline === null) {
    if (!blockers.some(({ code }) => code === 'OWNER_VERIFIED_BASELINE_MISSING')) {
      blockers.push({
        code: 'OWNER_VERIFIED_BASELINE_MISSING',
        summary: 'The trusted application did not supply a baseline record.',
      });
    }
    return blockers;
  }
  if (baseline.ownerVerification.status !== 'OWNER_VERIFIED') {
    blockers.push({
      code: 'BASELINE_NOT_OWNER_VERIFIED',
      summary: 'The supplied baseline does not carry trusted owner verification.',
    });
  }
  if (resolution.status === 'RESOLVED') {
    if (baseline.commitSha.toLowerCase() !== resolution.commitSha) {
      blockers.push({
        code: 'BASELINE_DOES_NOT_MATCH_DISCOVERY',
        summary: 'The supplied baseline SHA does not match the read-only discovery result.',
      });
    }
    if (!resolution.sourceReferences.includes(baseline.sourceReference)) {
      blockers.push({
        code: 'BASELINE_PROVENANCE_DOES_NOT_MATCH_DISCOVERY',
        summary:
          'The supplied owner-verification reference was not present in authorized evidence.',
      });
    }
  }
  blockers.push(
    ...baseline.knownBlockers.map((summary) => ({ code: 'BASELINE_KNOWN_BLOCKER', summary })),
  );
  return blockers;
}

function defectReferenceBlockers(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  reference: TrustedSyntheticDebugDefectReferenceRecord | null,
): SyntheticDebugTransitionReason[] {
  const blockers: SyntheticDebugTransitionReason[] = [];
  const resolution = snapshot.discovery?.knownGoodResolution;
  if (resolution === undefined) {
    blockers.push({
      code: 'DISCOVERY_INVARIANT_MISSING',
      summary: 'A discovery summary is required before DEFECT_REFERENCE authorization.',
    });
  } else if (resolution.status === 'RESOLVED') {
    blockers.push({
      code: 'OWNER_VERIFIED_BASELINE_AVAILABLE',
      summary: 'DEFECT_REFERENCE is prohibited while an owner-verified known-good exists.',
    });
  } else if (resolution.status === 'CONFLICT') {
    blockers.push({
      code: 'CONTRADICTORY_OWNER_VERIFIED_BASELINES',
      summary: 'Conflicting owner-verified baseline evidence must be resolved normally.',
    });
  }
  if (reference === null) {
    blockers.push({
      code: 'TRUSTED_DEFECT_REFERENCE_MISSING',
      summary: 'The trusted application did not supply a DEFECT_REFERENCE record.',
    });
    return blockers;
  }
  if (reference.caseId !== snapshot.caseId || reference.projectId !== snapshot.projectId) {
    blockers.push({
      code: 'TRUSTED_DEFECT_REFERENCE_SCOPE_MISMATCH',
      summary: 'The DEFECT_REFERENCE does not match the active case and project.',
    });
  }
  const evidenceById = new Map(
    snapshot.intake.evidenceReferences.map((item) => [item.evidenceId, item] as const),
  );
  const invalidEvidence = reference.defectEvidenceReferences.filter((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    return evidence === undefined || !REPRODUCIBLE_EVIDENCE_KINDS.has(evidence.kind);
  });
  if (invalidEvidence.length > 0) {
    blockers.push({
      code: 'DEFECT_REFERENCE_REPRODUCIBLE_EVIDENCE_MISSING',
      summary: `DEFECT_REFERENCE evidence is absent or not reproducible: ${invalidEvidence.join(', ')}.`,
    });
  }
  return blockers;
}

function reproducibleEvidenceFor(
  intake: DeepReadonly<SyntheticDebugIntakeRecord>,
  evidenceIds: readonly string[],
): readonly DeepReadonly<SyntheticDebugEvidenceReference>[] {
  const referenced = new Set(evidenceIds);
  return intake.evidenceReferences.filter(
    (evidence) =>
      referenced.has(evidence.evidenceId) && REPRODUCIBLE_EVIDENCE_KINDS.has(evidence.kind),
  );
}

function unresolvedBaselineBlocker(
  baseline: DeepReadonly<TrustedSyntheticDebugBaselineRecord> | null,
): string | null {
  if (baseline === null || baseline.knownBlockers.length === 0) return null;
  return [...new Set(baseline.knownBlockers)].join('; ');
}

function rootCauseUncertainty(
  rootCause: DeepReadonly<SyntheticDebugRootCauseRecord> | null,
): readonly string[] {
  if (rootCause === null) return [];
  return [
    ...(rootCause.status === 'verified' ? [] : [`root cause status remains ${rootCause.status}`]),
    ...rootCause.unresolvedUncertainty,
  ];
}

function implementationDecision(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  evidence: readonly DeepReadonly<SyntheticDebugEvidenceReference>[],
  rootCause: DeepReadonly<SyntheticDebugRootCauseRecord> | null,
): GateDecision {
  const baseline = snapshot.knownGoodBaseline;
  const reference = snapshot.defectReference;
  const baselineBlocker =
    snapshot.baselineMode === 'KNOWN_GOOD' ? unresolvedBaselineBlocker(baseline) : null;
  return canStartImplementation({
    baselineMode: snapshot.baselineMode,
    knownGoodBaselineSha: baseline?.commitSha ?? null,
    baselineOwnerVerified: baseline?.ownerVerification.status === 'OWNER_VERIFIED',
    defectReferenceSha: reference?.commitSha ?? null,
    defectReferenceOwnerAcknowledged:
      reference?.ownerAcknowledgement.status === 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE',
    defectReferenceEntryRequirementsSatisfied: defectReferenceEntryRequirementsSatisfied(snapshot),
    evidenceItems: evidence.length,
    rootCauseRecorded: rootCause !== null && rootCause.explanation.trim().length > 0,
    ...(baselineBlocker === null ? {} : { unresolvedBaselineBlocker: baselineBlocker }),
    unresolvedBlockingUncertainty: rootCauseUncertainty(rootCause),
  });
}

function gateBlockers(
  decision: GateDecision,
): readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]] {
  if (decision.blockers.length === 0) {
    throw new Error('A blocked implementation decision requires at least one gate blocker');
  }
  return decision.blockers.map((summary) => ({
    code: 'IMPLEMENTATION_GATE_BLOCKER',
    summary,
  })) as [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]];
}

export function createSyntheticDebugDiscoveryController(
  dependencies: SyntheticDebugOrchestratorDependencies = {},
): SyntheticDebugDiscoveryController {
  const capability = dependencies.taskD;
  const taskFCapability = dependencies.taskF;
  const taskGCapability = dependencies.taskG;
  const taskICapability = dependencies.taskI;
  const writeProposalResults = new Map<string, SyntheticDebugOrchestrationResult>();
  const writeApprovalResults = new Map<string, Promise<SyntheticDebugOrchestrationResult>>();
  const workerExecutionResults = new Map<string, Promise<SyntheticDebugOrchestrationResult>>();
  const verificationResults = new Map<string, Promise<SyntheticDebugOrchestrationResult>>();
  const independentReviewResults = new Map<string, Promise<SyntheticDebugOrchestrationResult>>();
  const finalDeliveryResults = new Map<
    string,
    {
      readonly inputFingerprint: string;
      readonly result: SyntheticDebugOrchestrationResult;
    }
  >();
  const approvalDecisionBindings = new Map<
    string,
    {
      readonly bindingKey: string;
      readonly decision: TrustedSyntheticDebugApprovalDecision['decision'];
    }
  >();
  const independentReviewIdBindings = new Map<
    string,
    {
      readonly bindingKey: string;
      readonly fingerprint: string;
    }
  >();

  function transitionWorkerExecution(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    adaptation: ReturnType<typeof adaptSyntheticDebugWorkerResult>,
  ): SyntheticDebugOrchestrationResult {
    const operation = 'EXECUTE_APPROVED_IMPLEMENTATION';
    const workerExecution = deepFreeze(adaptation.record);
    if (adaptation.disposition === 'VERIFYING') {
      return apply(
        snapshot,
        operation,
        'START_VERIFICATION',
        [
          {
            code: 'WORKER_EXECUTION_CAPTURED',
            summary:
              'The existing Worker completed one bounded isolated implementation for verification.',
          },
        ],
        'ADVANCED',
        { workerExecution },
      );
    }

    const failure = workerExecution.failure;
    if (failure === null) {
      return fail(
        snapshot,
        operation,
        'INTERNAL_WORKER_ERROR',
        'The Worker adapter returned an inconsistent failure classification.',
      );
    }
    const reasons = [{ code: failure.code, summary: failure.summary }] as const;
    return adaptation.disposition === 'BLOCKED'
      ? block(snapshot, operation, reasons, { workerExecution })
      : apply(snapshot, operation, 'FAIL', reasons, 'FAILED', { workerExecution });
  }

  async function executePendingWorker(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    proposal: DeepReadonly<SyntheticDebugWriteProposal>,
    decision: DeepReadonly<TrustedSyntheticDebugApprovalDecision>,
  ): Promise<SyntheticDebugOrchestrationResult> {
    const operation = 'EXECUTE_APPROVED_IMPLEMENTATION';
    if (taskGCapability === undefined) {
      return block(snapshot, operation, [
        {
          code: 'WORKER_EXECUTION_CAPABILITY_MISSING',
          summary: 'The trusted application Worker execution capability was not injected.',
        },
      ]);
    }

    try {
      const result = await taskGCapability.executeApprovedSyntheticImplementation(
        taskGRequest(snapshot, proposal, decision),
      );
      return transitionWorkerExecution(snapshot, adaptSyntheticDebugWorkerResult(result, proposal));
    } catch (workerError: unknown) {
      return transitionWorkerExecution(
        snapshot,
        adaptSyntheticDebugWorkerError(workerError, proposal),
      );
    }
  }

  function capturedWorkerExecutionMatches(
    snapshotRecord: DeepReadonly<SyntheticDebugWorkerExecutionRecord>,
    trustedRecord: DeepReadonly<SyntheticDebugWorkerExecutionRecord>,
  ): boolean {
    try {
      return JSON.stringify(snapshotRecord) === JSON.stringify(trustedRecord);
    } catch {
      return false;
    }
  }

  function verificationTransitionReasons(
    verification: DeepReadonly<SyntheticDebugVerificationDecision>,
  ): readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]] | null {
    if (verification.blockers.length === 0) return null;
    return verification.blockers.map(({ code, summary }) => ({ code, summary })) as [
      SyntheticDebugTransitionReason,
      ...SyntheticDebugTransitionReason[],
    ];
  }

  async function evaluatePendingVerification(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    proposal: DeepReadonly<SyntheticDebugWriteProposal>,
    decision: DeepReadonly<TrustedSyntheticDebugApprovalDecision>,
    bindingKey: string,
    trustedExecutionPromise: Promise<SyntheticDebugOrchestrationResult>,
  ): Promise<SyntheticDebugOrchestrationResult> {
    const operation = 'EVALUATE_VERIFICATION';
    const trustedExecution = await trustedExecutionPromise;
    const snapshotRecord = snapshot.workerExecution;
    const trustedRecord = trustedExecution.ok ? trustedExecution.snapshot.workerExecution : null;
    if (
      snapshotRecord === null ||
      trustedRecord === null ||
      !trustedExecution.ok ||
      trustedExecution.status !== 'ADVANCED' ||
      trustedExecution.snapshot.machine.state !== 'VERIFYING' ||
      trustedExecution.snapshot.caseId !== snapshot.caseId ||
      trustedExecution.snapshot.projectId !== snapshot.projectId ||
      trustedExecution.snapshot.writeProposal?.proposalId !== proposal.proposalId ||
      trustedExecution.snapshot.writeApprovalDecision?.decisionReferenceId !==
        decision.decisionReferenceId ||
      !capturedWorkerExecutionMatches(snapshotRecord, trustedRecord)
    ) {
      return fail(
        snapshot,
        operation,
        'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
        'Verification rejected Worker evidence that was not the cached trusted C3.6 result.',
      );
    }

    const existing = verificationResults.get(bindingKey);
    if (existing !== undefined) return await existing;

    const verification = deepFreeze(
      verifySyntheticDebugWorkerExecution({
        caseId: snapshot.caseId,
        projectId: snapshot.projectId,
        baselineMode: snapshot.baselineMode,
        baselineOwnerVerified:
          snapshot.knownGoodBaseline?.ownerVerification.status === 'OWNER_VERIFIED',
        defectReferenceOwnerAcknowledged:
          snapshot.defectReference?.ownerAcknowledgement.status ===
          'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE',
        defectReferenceEntryRequirementsSatisfied:
          defectReferenceEntryRequirementsSatisfied(snapshot),
        problemEvidenceItems: snapshot.reproducibleDefectEvidence.length,
        rootCauseRecorded:
          snapshot.rootCause !== null && snapshot.rootCause.explanation.trim().length > 0,
        proposal,
        workerExecution: trustedRecord,
      }),
    );
    const patch = { verificationDecision: verification } as const;
    if (verification.status === 'PASSED') {
      const result = apply(
        snapshot,
        operation,
        'START_REVIEW',
        [
          {
            code: 'PRE_REVIEW_VERIFICATION_PASSED',
            summary:
              'The cached trusted C3.6 result passed the centralized pre-review verification policy.',
          },
        ],
        'ADVANCED',
        patch,
      );
      verificationResults.set(bindingKey, Promise.resolve(result));
      return result;
    }

    const reasons = verificationTransitionReasons(verification);
    if (reasons === null) {
      const result = fail(
        snapshot,
        operation,
        'VERIFICATION_DECISION_INTEGRITY_MISMATCH',
        'A non-passing verification decision requires at least one structured blocker.',
        patch,
      );
      verificationResults.set(bindingKey, Promise.resolve(result));
      return result;
    }
    const result =
      verification.status === 'FAILED'
        ? apply(snapshot, operation, 'FAIL', reasons, 'FAILED', patch)
        : block(snapshot, operation, reasons, patch);
    verificationResults.set(bindingKey, Promise.resolve(result));
    return result;
  }

  function serializedEqual(left: unknown, right: unknown): boolean {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function trustedReviewPrerequisites(
    result: SyntheticDebugOrchestrationResult,
  ): SyntheticDebugOrchestrationSnapshot | null {
    if (
      !result.ok ||
      result.status !== 'ADVANCED' ||
      result.snapshot.machine.state !== 'REVIEWING' ||
      result.snapshot.verificationDecision?.status !== 'PASSED' ||
      result.snapshot.independentReviewPackage !== null ||
      result.snapshot.independentReview !== null
    ) {
      return null;
    }
    return result.snapshot;
  }

  function independentReviewFingerprint(
    record: DeepReadonly<TrustedSyntheticDebugReviewRecord>,
  ): string {
    return createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
  }

  function reviewOutcomeReasons(
    review: DeepReadonly<TrustedSyntheticDebugReviewRecord>,
  ): readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]] {
    const code =
      review.disposition === 'fail' ? 'INDEPENDENT_REVIEW_FAILED' : 'INDEPENDENT_REVIEW_BLOCKED';
    return review.blockers.map((summary) => ({ code, summary })) as [
      SyntheticDebugTransitionReason,
      ...SyntheticDebugTransitionReason[],
    ];
  }

  function buildTrustedReviewPackage(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): DeepReadonly<SyntheticDebugIndependentReviewPackage> | null {
    const reference = selectedReferenceRecord(snapshot);
    if (
      reference === null ||
      snapshot.rootCause === null ||
      snapshot.writeProposal === null ||
      snapshot.verificationDecision === null
    ) {
      return null;
    }
    try {
      return buildSyntheticDebugIndependentReviewPackage({
        caseId: snapshot.caseId,
        projectId: snapshot.projectId,
        intake: snapshot.intake,
        baselineMode: snapshot.baselineMode,
        reference,
        problemEvidence: snapshot.reproducibleDefectEvidence,
        rootCause: snapshot.rootCause,
        proposal: snapshot.writeProposal,
        verification: snapshot.verificationDecision,
      });
    } catch {
      return null;
    }
  }

  async function resolvePendingIndependentReview(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    bindingKey: string,
    trustedVerificationPromise: Promise<SyntheticDebugOrchestrationResult>,
  ): Promise<SyntheticDebugOrchestrationResult> {
    const operation = 'EVALUATE_INDEPENDENT_REVIEW';
    const trustedVerification = await trustedVerificationPromise;
    const trustedSnapshot = trustedReviewPrerequisites(trustedVerification);
    if (trustedSnapshot === null) {
      return block(snapshot, operation, [
        {
          code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
          summary: 'Independent review requires the cached trusted passing C3.7 result.',
        },
      ]);
    }

    const reviewPackage = buildTrustedReviewPackage(trustedSnapshot);
    if (reviewPackage === null) {
      return block(trustedSnapshot, operation, [
        {
          code: 'INDEPENDENT_REVIEW_PACKAGE_INVALID',
          summary: 'The cached trusted evidence could not produce a strict review package.',
        },
      ]);
    }
    const packagePatch = { independentReviewPackage: reviewPackage } as const;
    if (!serializedEqual(snapshot, trustedSnapshot)) {
      return block(
        trustedSnapshot,
        operation,
        [
          {
            code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
            summary: 'Independent review rejected evidence outside the cached trusted C3.7 result.',
          },
        ],
        packagePatch,
      );
    }
    if (taskICapability === undefined) {
      return block(
        trustedSnapshot,
        operation,
        [
          {
            code: 'INDEPENDENT_REVIEW_NOT_RUN',
            summary: 'The application-owned independent review capability was not injected.',
          },
        ],
        packagePatch,
      );
    }

    let reviewInput: unknown;
    try {
      reviewInput = await taskICapability.reviewVerifiedSyntheticCandidate(
        taskIRequest(reviewPackage),
      );
    } catch {
      return fail(
        trustedSnapshot,
        operation,
        'INDEPENDENT_REVIEW_DEPENDENCY_ERROR',
        'The injected independent review capability failed.',
        packagePatch,
      );
    }

    const adaptation = adaptSyntheticDebugIndependentReview(reviewInput, reviewPackage);
    if (!adaptation.ok) {
      return block(
        trustedSnapshot,
        operation,
        [{ code: adaptation.code, summary: adaptation.summary }],
        packagePatch,
      );
    }

    const review = adaptation.record;
    const fingerprint = independentReviewFingerprint(review);
    const existingBinding = independentReviewIdBindings.get(review.reviewId);
    if (
      existingBinding !== undefined &&
      (existingBinding.bindingKey !== bindingKey || existingBinding.fingerprint !== fingerprint)
    ) {
      return block(
        trustedSnapshot,
        operation,
        [
          {
            code: 'INDEPENDENT_REVIEW_CONFLICT',
            summary:
              'The independent review identifier is already bound to different review evidence.',
          },
        ],
        packagePatch,
      );
    }
    independentReviewIdBindings.set(review.reviewId, Object.freeze({ bindingKey, fingerprint }));

    const patch = { ...packagePatch, independentReview: review } as const;
    if (review.disposition === 'pass') {
      return apply(
        trustedSnapshot,
        operation,
        'COMPLETE_REVIEW',
        [
          {
            code: 'INDEPENDENT_REVIEW_PASSED',
            summary:
              'The application-owned independent review service passed the verified candidate.',
          },
        ],
        'ADVANCED',
        patch,
      );
    }
    return block(trustedSnapshot, operation, reviewOutcomeReasons(review), patch);
  }

  async function resolveIndependentReviewReplay(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    cachedPromise: Promise<SyntheticDebugOrchestrationResult>,
    trustedVerificationPromise: Promise<SyntheticDebugOrchestrationResult>,
  ): Promise<SyntheticDebugOrchestrationResult> {
    const [cached, trustedVerification] = await Promise.all([
      cachedPromise,
      trustedVerificationPromise,
    ]);
    const trustedSnapshot = trustedReviewPrerequisites(trustedVerification);
    if (
      (trustedSnapshot !== null && serializedEqual(snapshot, trustedSnapshot)) ||
      (cached.ok && serializedEqual(snapshot, cached.snapshot))
    ) {
      return cached;
    }

    const preserved =
      cached.ok && cached.snapshot.machine.state === 'REVIEWING'
        ? cached.snapshot
        : trustedSnapshot;
    if (preserved === null) {
      return block(snapshot, 'EVALUATE_INDEPENDENT_REVIEW', [
        {
          code: 'INDEPENDENT_REVIEW_CONFLICT',
          summary: 'Conflicting independent review evidence failed closed.',
        },
      ]);
    }
    return block(preserved, 'EVALUATE_INDEPENDENT_REVIEW', [
      {
        code: 'INDEPENDENT_REVIEW_CONFLICT',
        summary: 'Conflicting independent review evidence failed closed without latest-wins.',
      },
    ]);
  }

  function buildFinalDeliveryReport(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): DeepReadonly<DebugDeliveryReport> | null {
    const reference = selectedReferenceRecord(snapshot);
    const defectReference = snapshot.defectReference;
    const proposal = snapshot.writeProposal;
    const execution = snapshot.workerExecution;
    const verification = snapshot.verificationDecision;
    if (reference === null || proposal === null || execution === null || verification === null) {
      return null;
    }
    const verificationRecords = verification.profileResults.map((profile) => {
      const action = execution.actions.find(
        ({ actionIndex }) => actionIndex === profile.actionIndex,
      );
      return {
        profileId: profile.profileId,
        required: profile.required,
        status: profile.status,
        ...(action?.exitCode === null || action?.exitCode === undefined
          ? {}
          : { exitCode: action.exitCode }),
        startedAt: action?.startedAt ?? '',
        finishedAt: action?.finishedAt ?? '',
        summary: action?.summary ?? `Cached verification outcome: ${profile.status}`,
      };
    });
    return buildDebugDeliveryReport({
      workflowKind: 'synthetic',
      caseId: snapshot.caseId,
      workerJobId: verification.workerJobId ?? '',
      projectId: snapshot.projectId,
      baselineMode: snapshot.baselineMode,
      baselineSha: verification.baselineSha,
      baselineOwnerVerified:
        snapshot.knownGoodBaseline?.ownerVerification.status === 'OWNER_VERIFIED',
      referenceWasOwnerVerifiedKnownGood: snapshot.baselineMode === 'KNOWN_GOOD',
      defectReference:
        defectReference === null
          ? null
          : {
              referenceSha: defectReference.commitSha,
              referenceVersion: defectReference.referenceVersion,
              historicalSearchBoundary: defectReference.historicalSearchBoundary,
              defectEvidenceReferences: defectReference.defectEvidenceReferences,
              knownPreExistingDefects: defectReference.knownPreExistingDefects,
              knownUnrelatedFailures: defectReference.knownUnrelatedFailures,
              reasonSelected: defectReference.reasonSelected,
              rollbackReferenceSemantics: defectReference.rollbackReferenceSemantics,
              ownerAcknowledgementReference: defectReference.ownerAcknowledgement.evidenceReference,
              notOwnerVerifiedKnownGood: true,
              separateWriteApprovalRequired: true,
            },
      candidateSha: verification.candidateSha,
      isolatedBranch: verification.isolatedBranch,
      workspacePath: execution.workspaceReference,
      rollbackRef: verification.rollbackRef,
      rollbackSha: verification.rollbackSha,
      problemEvidence: snapshot.reproducibleDefectEvidence.map((evidence) => ({
        evidenceId: evidence.evidenceId,
        classification: 'SYNTHETIC' as const,
        summary: evidence.reference,
      })),
      rootCause: snapshot.rootCause?.explanation ?? '',
      approvedPaths: verification.approvedPaths,
      changedPaths: verification.changedPaths,
      affectedSurfaces: snapshot.intake.affectedSurfaces,
      requiredProfileIds: verification.requiredProfileIds,
      verification: verificationRecords,
      review: independentReviewForDelivery(snapshot.independentReview),
      unresolvedBlockingUncertainty: rootCauseUncertainty(snapshot.rootCause),
      unresolvedNonBlockingUncertainty: [],
    });
  }

  async function resolvePendingWriteApproval(
    snapshot: SyntheticDebugOrchestrationSnapshot,
    proposal: DeepReadonly<SyntheticDebugWriteProposal>,
    bindingKey: string,
  ): Promise<SyntheticDebugOrchestrationResult> {
    const operation = 'RESOLVE_WRITE_APPROVAL';
    if (taskFCapability === undefined) {
      return block(snapshot, operation, [
        {
          code: 'TRUSTED_APPROVAL_CAPABILITY_MISSING',
          summary: 'The trusted application approval capability was not injected.',
        },
      ]);
    }

    let decisionInput: unknown;
    try {
      decisionInput = await taskFCapability.readTrustedWriteApprovalDecision(
        taskFRequest(snapshot, proposal),
      );
    } catch {
      return fail(
        snapshot,
        operation,
        'TRUSTED_APPROVAL_DEPENDENCY_ERROR',
        'The injected trusted approval capability failed.',
      );
    }

    let decision: TrustedSyntheticDebugApprovalDecision;
    try {
      decision = parseTrustedSyntheticDebugApprovalDecision(decisionInput);
    } catch {
      return reject(
        snapshot,
        operation,
        'MALFORMED_TRUSTED_APPROVAL',
        'The injected trusted approval capability returned an invalid record.',
      );
    }
    if (
      decision.caseId !== snapshot.caseId ||
      decision.projectId !== snapshot.projectId ||
      decision.proposalId !== proposal.proposalId
    ) {
      return reject(
        snapshot,
        operation,
        'TRUSTED_APPROVAL_SCOPE_MISMATCH',
        'The trusted approval decision did not match the active case, project, and proposal.',
      );
    }

    const existingBinding = approvalDecisionBindings.get(decision.decisionReferenceId);
    if (existingBinding !== undefined && existingBinding.bindingKey !== bindingKey) {
      return reject(
        snapshot,
        operation,
        'TRUSTED_APPROVAL_REPLAY_MISMATCH',
        'The trusted approval decision reference is already bound to another proposal.',
      );
    }
    approvalDecisionBindings.set(
      decision.decisionReferenceId,
      Object.freeze({ bindingKey, decision: decision.decision }),
    );

    const trustedDecision = deepFreeze(decision);
    const patch = { writeApprovalDecision: trustedDecision } as const;
    if (trustedDecision.decision === 'APPROVED') {
      return apply(
        snapshot,
        operation,
        'GRANT_WRITE_APPROVAL',
        [
          {
            code: 'TRUSTED_WRITE_APPROVAL_ACCEPTED',
            summary: 'The application-owned decision approved the bounded write proposal.',
          },
        ],
        'ADVANCED',
        patch,
      );
    }
    if (trustedDecision.decision === 'DENIED') {
      return block(
        snapshot,
        operation,
        [
          {
            code: 'TRUSTED_WRITE_APPROVAL_DENIED',
            summary: 'The application-owned decision denied the bounded write proposal.',
          },
        ],
        patch,
      );
    }
    return cancel(
      snapshot,
      operation,
      [
        {
          code: 'TRUSTED_WRITE_APPROVAL_CANCELLED',
          summary: 'The application-owned decision cancelled the bounded write proposal.',
        },
      ],
      patch,
    );
  }

  const controller = {
    createCase(input: unknown): SyntheticDebugOrchestrationCreateResult {
      let parsed;
      try {
        parsed = parseModelSyntheticDebugRecord(input);
      } catch {
        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          error: error(
            'MALFORMED_MODEL_RECORD',
            'CREATE_CASE',
            'Expected a strict model-safe synthetic debug record',
            null,
          ),
        });
      }
      if (parsed.recordKind !== 'INTAKE') {
        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          error: error(
            'UNSUPPORTED_RECORD_KIND',
            'CREATE_CASE',
            `Record kind ${parsed.recordKind} is not accepted at case creation`,
            null,
          ),
        });
      }
      const intake = deepFreeze(parsed);
      return Object.freeze({
        ok: true,
        status: 'CREATED',
        snapshot: deepFreeze({
          schemaVersion: '1.0' as const,
          workflowKind: 'synthetic' as const,
          caseId: intake.caseId,
          projectId: intake.projectId,
          machine: createSyntheticDebugMachine(),
          intake,
          discovery: null,
          baselineMode: 'KNOWN_GOOD' as const,
          knownGoodBaseline: null,
          defectReference: null,
          reproducibleDefectEvidence: [],
          rootCause: null,
          implementationGate: null,
          writeProposal: null,
          writeApprovalDecision: null,
          workerExecution: null,
          verificationDecision: null,
          independentReviewPackage: null,
          independentReview: null,
          finalDelivery: null,
        }),
      });
    },

    startDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'START_DISCOVERY', 'INTAKE');
      if (invalid !== null) return invalid;
      return apply(
        snapshot,
        'START_DISCOVERY',
        'START_DISCOVERY',
        [{ code: 'INTAKE_ACCEPTED', summary: 'The model-safe synthetic intake was accepted.' }],
        'ADVANCED',
      );
    },

    async completeDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'COMPLETE_DISCOVERY', 'DISCOVERY');
      if (invalid !== null) return invalid;
      if (capability === undefined) {
        return block(snapshot, 'COMPLETE_DISCOVERY', [
          {
            code: 'READ_ONLY_DISCOVERY_CAPABILITY_MISSING',
            summary: 'The trusted read-only Task D capability was not injected.',
          },
        ]);
      }

      const operationRequest = request(snapshot, 'READ_ONLY_DISCOVERY');
      const authorization = await authorize(capability, operationRequest);
      if (authorization === 'ERROR') {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'DISCOVERY_AUTHORIZATION_ERROR',
          'The injected Task D capability returned an invalid authorization result.',
        );
      }
      if (authorization === 'DENIED') {
        return block(snapshot, 'COMPLETE_DISCOVERY', [
          {
            code: 'DISCOVERY_AUTHORIZATION_DENIED',
            summary: 'Read-only synthetic discovery was not authorized.',
          },
        ]);
      }

      let repositoryInput: unknown;
      let memoryInput: unknown;
      try {
        repositoryInput = await capability.readRepositoryDiscovery(operationRequest);
        memoryInput = await capability.readAuthorizedMemoryEvidence(operationRequest);
      } catch {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'DISCOVERY_DEPENDENCY_ERROR',
          'The injected read-only Task D capability failed.',
        );
      }
      const repository = repositoryDiscoverySchema.safeParse(repositoryInput);
      const memory = authorizedMemoryDiscoverySchema.safeParse(memoryInput);
      if (!repository.success || !memory.success) {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'MALFORMED_DISCOVERY_RESULT',
          'The injected read-only Task D capability returned invalid data.',
        );
      }
      const discovery = discoverySummary(snapshot.projectId, repository.data, memory.data);
      if (discovery === null) {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'CROSS_PROJECT_DISCOVERY_EVIDENCE',
          'Read-only discovery returned evidence outside the requested project.',
        );
      }
      return apply(
        snapshot,
        'COMPLETE_DISCOVERY',
        'MARK_EVIDENCE_READY',
        [
          {
            code: 'READ_ONLY_DISCOVERY_COMPLETED',
            summary: 'Repository and pre-authorized memory discovery completed read-only.',
          },
        ],
        'ADVANCED',
        { discovery },
      );
    },

    async resolveTrustedBaseline(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'RESOLVE_TRUSTED_BASELINE', 'EVIDENCE_READY');
      if (invalid !== null) return invalid;
      if (capability === undefined) {
        return block(snapshot, 'RESOLVE_TRUSTED_BASELINE', [
          {
            code: 'TRUSTED_BASELINE_CAPABILITY_MISSING',
            summary: 'The trusted application baseline capability was not injected.',
          },
        ]);
      }

      const operationRequest = request(snapshot, 'RESOLVE_TRUSTED_BASELINE');
      const authorization = await authorize(capability, operationRequest);
      if (authorization === 'ERROR') {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'BASELINE_AUTHORIZATION_ERROR',
          'The injected Task D capability returned an invalid authorization result.',
        );
      }
      if (authorization === 'DENIED') {
        return block(snapshot, 'RESOLVE_TRUSTED_BASELINE', [
          {
            code: 'BASELINE_AUTHORIZATION_DENIED',
            summary: 'Trusted baseline resolution was not authorized.',
          },
        ]);
      }

      let baselineInput: unknown;
      try {
        baselineInput = await capability.readTrustedBaseline(operationRequest);
      } catch {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'TRUSTED_BASELINE_DEPENDENCY_ERROR',
          'The injected trusted baseline capability failed.',
        );
      }

      let baseline: TrustedSyntheticDebugBaselineRecord | null = null;
      if (baselineInput !== null && baselineInput !== undefined) {
        try {
          baseline = parseTrustedSyntheticDebugBaselineRecord(baselineInput);
        } catch {
          return fail(
            snapshot,
            'RESOLVE_TRUSTED_BASELINE',
            'MALFORMED_TRUSTED_BASELINE',
            'The injected trusted baseline capability returned an invalid record.',
          );
        }
        if (baseline.caseId !== snapshot.caseId || baseline.projectId !== snapshot.projectId) {
          return fail(
            snapshot,
            'RESOLVE_TRUSTED_BASELINE',
            'TRUSTED_BASELINE_SCOPE_MISMATCH',
            'The injected baseline did not match the active case and project.',
          );
        }
      }
      if (snapshot.discovery === null) {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'DISCOVERY_INVARIANT_MISSING',
          'A discovery summary is required before baseline resolution.',
        );
      }

      const blockers = baselineBlockers(snapshot.discovery, baseline);
      if (blockers.length > 0) {
        return block(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          blockers as [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
        );
      }
      if (baseline === null) {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'BASELINE_RESOLUTION_INVARIANT',
          'Baseline resolution passed without a trusted baseline record.',
        );
      }
      return apply(
        snapshot,
        'RESOLVE_TRUSTED_BASELINE',
        'MARK_BASELINE_READY',
        [
          {
            code: 'OWNER_VERIFIED_BASELINE_RESOLVED',
            summary: 'The exact owner-verified baseline matched authorized discovery evidence.',
          },
        ],
        'ADVANCED',
        {
          baselineMode: 'KNOWN_GOOD',
          knownGoodBaseline: deepFreeze(baseline),
          defectReference: null,
        },
      );
    },

    async authorizeDefectReference(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'AUTHORIZE_DEFECT_REFERENCE';
      const invalid = requireState(snapshot, operation, 'EVIDENCE_READY');
      if (invalid !== null) return invalid;
      if (capability?.readTrustedDefectReference === undefined) {
        return reject(
          snapshot,
          operation,
          'DEFECT_REFERENCE_ENTRY_REQUIREMENTS_NOT_MET',
          'A trusted application DEFECT_REFERENCE capability is required.',
        );
      }

      const operationRequest = request(snapshot, 'RESOLVE_TRUSTED_DEFECT_REFERENCE');
      const authorization = await authorize(capability, operationRequest);
      if (authorization === 'ERROR') {
        return fail(
          snapshot,
          operation,
          'DEFECT_REFERENCE_AUTHORIZATION_ERROR',
          'The injected trusted capability returned an invalid authorization result.',
        );
      }
      if (authorization === 'DENIED') {
        return reject(
          snapshot,
          operation,
          'DEFECT_REFERENCE_ENTRY_REQUIREMENTS_NOT_MET',
          'Trusted DEFECT_REFERENCE authorization was denied.',
        );
      }

      let referenceInput: unknown;
      try {
        referenceInput = await capability.readTrustedDefectReference(operationRequest);
      } catch {
        return fail(
          snapshot,
          operation,
          'TRUSTED_DEFECT_REFERENCE_DEPENDENCY_ERROR',
          'The injected trusted DEFECT_REFERENCE capability failed.',
        );
      }

      let reference: TrustedSyntheticDebugDefectReferenceRecord;
      try {
        reference = parseTrustedSyntheticDebugDefectReferenceRecord(referenceInput);
      } catch {
        return reject(
          snapshot,
          operation,
          'MALFORMED_TRUSTED_DEFECT_REFERENCE',
          'The trusted application returned an incomplete DEFECT_REFERENCE entry contract.',
        );
      }
      if (reference.caseId !== snapshot.caseId || reference.projectId !== snapshot.projectId) {
        return reject(
          snapshot,
          operation,
          'TRUSTED_DEFECT_REFERENCE_SCOPE_MISMATCH',
          'The trusted DEFECT_REFERENCE did not match the active case and project.',
        );
      }
      const blockers = defectReferenceBlockers(snapshot, reference);
      if (blockers.length > 0) {
        return reject(
          snapshot,
          operation,
          'DEFECT_REFERENCE_ENTRY_REQUIREMENTS_NOT_MET',
          'The trusted DEFECT_REFERENCE did not satisfy the exception entry contract.',
        );
      }

      const rootCauseAlreadyRecorded = snapshot.rootCause !== null;
      return apply(
        snapshot,
        operation,
        rootCauseAlreadyRecorded
          ? 'MARK_DEFECT_REFERENCE_AND_ROOT_CAUSE_READY'
          : 'MARK_DEFECT_REFERENCE_READY',
        [
          {
            code: 'TRUSTED_DEFECT_REFERENCE_AUTHORIZED',
            summary:
              'The application authorized an explicit DEFECT_REFERENCE that is not owner-verified known-good.',
          },
        ],
        'ADVANCED',
        {
          baselineMode: 'DEFECT_REFERENCE',
          knownGoodBaseline: null,
          defectReference: deepFreeze(reference),
          implementationGate: null,
        },
      );
    },

    recordEvidenceAndRootCause(
      snapshot: SyntheticDebugOrchestrationSnapshot,
      rootCauseInput: unknown,
    ) {
      const operation = 'RECORD_EVIDENCE_AND_ROOT_CAUSE';
      const readOnlyBeforeReference =
        snapshot.machine.state === 'EVIDENCE_READY' &&
        snapshot.baselineMode === 'KNOWN_GOOD' &&
        snapshot.knownGoodBaseline === null &&
        snapshot.defectReference === null &&
        snapshot.discovery?.knownGoodResolution.status === 'MISSING';
      if (!readOnlyBeforeReference) {
        const invalid = requireState(snapshot, operation, 'BASELINE_READY');
        if (invalid !== null) return invalid;
      }

      if (
        snapshot.intake.caseId !== snapshot.caseId ||
        snapshot.intake.projectId !== snapshot.projectId
      ) {
        return reject(
          snapshot,
          operation,
          'EVIDENCE_SCOPE_MISMATCH',
          'The evidence container does not match the active case and project',
        );
      }

      if (rootCauseInput === null || rootCauseInput === undefined) {
        if (readOnlyBeforeReference) {
          return reject(
            snapshot,
            operation,
            'MALFORMED_MODEL_RECORD',
            'Read-only root-cause analysis requires a strict evidence-linked record.',
          );
        }
        const evidence = reproducibleEvidenceFor(
          snapshot.intake,
          snapshot.intake.evidenceReferences.map(({ evidenceId }) => evidenceId),
        );
        const decision = deepFreeze(implementationDecision(snapshot, evidence, null));
        return block(snapshot, operation, gateBlockers(decision), {
          reproducibleDefectEvidence: evidence,
          rootCause: null,
          implementationGate: decision,
        });
      }

      let parsed;
      try {
        parsed = parseModelSyntheticDebugRecord(rootCauseInput);
      } catch {
        return reject(
          snapshot,
          operation,
          'MALFORMED_MODEL_RECORD',
          'Expected a strict model-safe synthetic root-cause record',
        );
      }
      if (parsed.recordKind !== 'ROOT_CAUSE') {
        return reject(
          snapshot,
          operation,
          'UNSUPPORTED_RECORD_KIND',
          `Record kind ${parsed.recordKind} is not accepted for Task E`,
        );
      }
      if (parsed.caseId !== snapshot.caseId || parsed.projectId !== snapshot.projectId) {
        return reject(
          snapshot,
          operation,
          'ROOT_CAUSE_SCOPE_MISMATCH',
          'The root-cause record does not match the active case and project',
        );
      }

      const evidenceCounts = new Map<string, number>();
      for (const evidence of snapshot.intake.evidenceReferences) {
        evidenceCounts.set(evidence.evidenceId, (evidenceCounts.get(evidence.evidenceId) ?? 0) + 1);
      }
      const unresolvedEvidence = parsed.evidenceReferences.filter(
        (evidenceId) => evidenceCounts.get(evidenceId) !== 1,
      );
      if (unresolvedEvidence.length > 0) {
        return reject(
          snapshot,
          operation,
          'EVIDENCE_SCOPE_MISMATCH',
          `Root-cause evidence is absent or ambiguous in the active case: ${unresolvedEvidence.join(', ')}`,
        );
      }

      const rootCause = deepFreeze(parsed);
      const evidence = deepFreeze(
        reproducibleEvidenceFor(snapshot.intake, rootCause.evidenceReferences),
      );
      return apply(
        snapshot,
        operation,
        readOnlyBeforeReference ? 'RECORD_READ_ONLY_ROOT_CAUSE' : 'MARK_ROOT_CAUSE_READY',
        [
          {
            code: readOnlyBeforeReference
              ? 'READ_ONLY_ROOT_CAUSE_RECORDED'
              : 'EVIDENCE_AND_ROOT_CAUSE_RECORDED',
            summary: readOnlyBeforeReference
              ? `Recorded read-only root-cause evidence with ${String(evidence.length)} reproducible item(s); mutation remains blocked pending a trusted reference.`
              : `Recorded the root cause with ${String(evidence.length)} reproducible defect-evidence item(s).`,
          },
        ],
        'ADVANCED',
        {
          reproducibleDefectEvidence: evidence,
          rootCause,
          implementationGate: null,
        },
      );
    },

    evaluateImplementationGate(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'EVALUATE_IMPLEMENTATION_GATE';
      const invalid = requireState(snapshot, operation, 'ROOT_CAUSE_READY');
      if (invalid !== null) return invalid;

      const decision = deepFreeze(
        implementationDecision(snapshot, snapshot.reproducibleDefectEvidence, snapshot.rootCause),
      );
      if (!decision.allowed) {
        return block(snapshot, operation, gateBlockers(decision), {
          implementationGate: decision,
        });
      }
      return apply(
        snapshot,
        operation,
        'MARK_IMPLEMENTATION_READY',
        [
          {
            code: 'IMPLEMENTATION_GATE_PASSED',
            summary: 'The existing implementation gate accepted every Task E precondition.',
          },
        ],
        'ADVANCED',
        { implementationGate: decision },
      );
    },

    requestWriteApproval(
      snapshot: SyntheticDebugOrchestrationSnapshot,
      implementationPlanInput: unknown,
    ) {
      const operation = 'REQUEST_WRITE_APPROVAL';
      const invalid = requireState(snapshot, operation, 'IMPLEMENTATION_READY');
      if (invalid !== null) return invalid;
      if (snapshot.writeProposal !== null || snapshot.writeApprovalDecision !== null) {
        return reject(
          snapshot,
          operation,
          'WRITE_PROPOSAL_ALREADY_EXISTS',
          'The active case already contains a write proposal or approval decision.',
        );
      }

      let parsed;
      try {
        parsed = parseModelSyntheticDebugRecord(implementationPlanInput);
      } catch {
        return reject(
          snapshot,
          operation,
          'MALFORMED_MODEL_RECORD',
          'Expected a strict model-safe synthetic implementation plan',
        );
      }
      if (parsed.recordKind !== 'IMPLEMENTATION_PLAN') {
        return reject(
          snapshot,
          operation,
          'UNSUPPORTED_RECORD_KIND',
          `Record kind ${parsed.recordKind} is not accepted for Task F`,
        );
      }
      if (parsed.caseId !== snapshot.caseId || parsed.projectId !== snapshot.projectId) {
        return reject(
          snapshot,
          operation,
          'IMPLEMENTATION_PLAN_SCOPE_MISMATCH',
          'The implementation plan does not match the active case and project.',
        );
      }
      const currentGate = implementationDecision(
        snapshot,
        snapshot.reproducibleDefectEvidence,
        snapshot.rootCause,
      );
      const referenceSha = selectedReferenceSha(snapshot);
      if (
        referenceSha === null ||
        snapshot.implementationGate?.allowed !== true ||
        !currentGate.allowed
      ) {
        return reject(
          snapshot,
          operation,
          'IMPLEMENTATION_GATE_INVARIANT',
          'A current passing implementation gate and trusted baseline/reference are required.',
        );
      }
      if (parsed.rollbackSha.toLowerCase() !== referenceSha) {
        return reject(
          snapshot,
          operation,
          'IMPLEMENTATION_PLAN_BASELINE_MISMATCH',
          snapshot.baselineMode === 'KNOWN_GOOD'
            ? 'The implementation plan rollback SHA does not match the verified baseline.'
            : 'The implementation plan rollback SHA does not match the approved DEFECT_REFERENCE.',
        );
      }
      if (containsSensitiveWriteProposalContent(parsed)) {
        return reject(
          snapshot,
          operation,
          'SENSITIVE_WRITE_PROPOSAL',
          'The implementation plan contains data that is not safe for a public write proposal.',
        );
      }

      const proposal = buildWriteProposal(snapshot, parsed);
      const proposalKey = caseBindingKey(snapshot);
      const existing = writeProposalResults.get(proposalKey);
      if (existing !== undefined) {
        if (existing.ok && existing.snapshot.writeProposal?.proposalId === proposal.proposalId) {
          return existing;
        }
        return reject(
          snapshot,
          operation,
          'WRITE_PROPOSAL_ALREADY_EXISTS',
          'The active case already produced a different bounded write proposal.',
        );
      }

      const result = apply(
        snapshot,
        operation,
        'REQUEST_WRITE_APPROVAL',
        [
          {
            code: 'BOUNDED_WRITE_PROPOSAL_CREATED',
            summary: 'A deterministic bounded proposal now awaits an application-owned decision.',
          },
        ],
        'ADVANCED',
        { writeProposal: proposal, writeApprovalDecision: null },
      );
      if (result.ok) writeProposalResults.set(proposalKey, result);
      return result;
    },

    async resolveWriteApproval(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'RESOLVE_WRITE_APPROVAL';
      const invalid = requireState(snapshot, operation, 'AWAITING_WRITE_APPROVAL');
      if (invalid !== null) return invalid;
      const proposal = snapshot.writeProposal;
      if (proposal === null || !pendingWriteProposalMatchesSnapshot(snapshot, proposal)) {
        return reject(
          snapshot,
          operation,
          'WRITE_PROPOSAL_INTEGRITY_MISMATCH',
          'The pending write proposal is missing or no longer matches its sealed case snapshot.',
        );
      }

      const bindingKey = writeApprovalBindingKey(snapshot, proposal);
      const existing = writeApprovalResults.get(bindingKey);
      if (existing !== undefined) return await existing;

      const resolution = resolvePendingWriteApproval(snapshot, proposal, bindingKey);
      writeApprovalResults.set(bindingKey, resolution);
      return await resolution;
    },

    async executeApprovedImplementation(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'EXECUTE_APPROVED_IMPLEMENTATION';
      const invalid = requireState(snapshot, operation, 'IMPLEMENTING');
      if (invalid !== null) return invalid;

      const proposal = snapshot.writeProposal;
      const decisionInput = snapshot.writeApprovalDecision;
      if (proposal === null || decisionInput === null || snapshot.workerExecution !== null) {
        return reject(
          snapshot,
          operation,
          'WORKER_EXECUTION_INTEGRITY_MISMATCH',
          'Worker execution requires one sealed proposal and its bound trusted approval.',
        );
      }

      if (typeof proposal.baselineSha !== 'string' || !isFullCommitSha(proposal.baselineSha)) {
        return transitionWorkerExecution(
          snapshot,
          adaptSyntheticDebugWorkerError(
            new Error('Worker execution requires a full 40-character baseline SHA.'),
            proposal,
          ),
        );
      }

      const parsedProposal = syntheticDebugWriteProposalSchema.safeParse(proposal);
      const parsedDecision = trustedSyntheticDebugApprovalDecisionSchema.safeParse(decisionInput);
      if (!parsedProposal.success || !parsedDecision.success) {
        return reject(
          snapshot,
          operation,
          'WORKER_EXECUTION_INTEGRITY_MISMATCH',
          'Worker execution requires strict sealed proposal and trusted approval records.',
        );
      }
      const decision = parsedDecision.data;
      if (!approvedWriteProposalMatchesSnapshot(snapshot, proposal, decision)) {
        return reject(
          snapshot,
          operation,
          'WORKER_EXECUTION_INTEGRITY_MISMATCH',
          'The approved write proposal no longer matches its sealed case snapshot.',
        );
      }

      const approvalBinding = writeApprovalBindingKey(snapshot, proposal);
      const recordedApproval = approvalDecisionBindings.get(decision.decisionReferenceId);
      if (
        recordedApproval?.bindingKey !== approvalBinding ||
        recordedApproval.decision !== 'APPROVED'
      ) {
        return reject(
          snapshot,
          operation,
          'WORKER_EXECUTION_INTEGRITY_MISMATCH',
          'The trusted approval decision was not issued and bound by this active controller.',
        );
      }

      const bindingKey = workerExecutionBindingKey(snapshot, proposal, decision);
      const existing = workerExecutionResults.get(bindingKey);
      if (existing !== undefined) return await existing;

      const execution = executePendingWorker(snapshot, proposal, decision);
      workerExecutionResults.set(bindingKey, execution);
      return await execution;
    },

    async evaluateVerification(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'EVALUATE_VERIFICATION';
      const invalid = requireState(snapshot, operation, 'VERIFYING');
      if (invalid !== null) return invalid;

      const proposal = snapshot.writeProposal;
      const decisionInput = snapshot.writeApprovalDecision;
      if (
        proposal === null ||
        decisionInput === null ||
        snapshot.workerExecution === null ||
        snapshot.verificationDecision !== null
      ) {
        return fail(
          snapshot,
          operation,
          'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
          'Verification requires one unevaluated cached C3.6 Worker execution.',
        );
      }

      const parsedProposal = syntheticDebugWriteProposalSchema.safeParse(proposal);
      const parsedDecision = trustedSyntheticDebugApprovalDecisionSchema.safeParse(decisionInput);
      if (!parsedProposal.success || !parsedDecision.success) {
        return fail(
          snapshot,
          operation,
          'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
          'Verification requires the strict sealed proposal and trusted approval records.',
        );
      }
      const decision = parsedDecision.data;
      if (!approvedWriteProposalMatchesSnapshot(snapshot, proposal, decision)) {
        return fail(
          snapshot,
          operation,
          'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
          'Verification rejected a proposal or approval outside the active sealed case.',
        );
      }

      const approvalBinding = writeApprovalBindingKey(snapshot, proposal);
      const recordedApproval = approvalDecisionBindings.get(decision.decisionReferenceId);
      if (
        recordedApproval?.bindingKey !== approvalBinding ||
        recordedApproval.decision !== 'APPROVED'
      ) {
        return fail(
          snapshot,
          operation,
          'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
          'Verification requires the controller-bound application approval decision.',
        );
      }

      const bindingKey = workerExecutionBindingKey(snapshot, proposal, decision);
      const trustedExecution = workerExecutionResults.get(bindingKey);
      if (trustedExecution === undefined) {
        return fail(
          snapshot,
          operation,
          'VERIFICATION_EXECUTION_INTEGRITY_MISMATCH',
          'Verification could not resolve a cached trusted C3.6 Worker result.',
        );
      }
      return await evaluatePendingVerification(
        snapshot,
        proposal,
        decision,
        bindingKey,
        trustedExecution,
      );
    },

    async evaluateIndependentReview(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'EVALUATE_INDEPENDENT_REVIEW';
      const invalid = requireState(snapshot, operation, 'REVIEWING');
      if (invalid !== null) return invalid;

      const proposal = snapshot.writeProposal;
      const decisionInput = snapshot.writeApprovalDecision;
      if (
        proposal === null ||
        decisionInput === null ||
        snapshot.workerExecution === null ||
        snapshot.verificationDecision === null
      ) {
        return block(snapshot, operation, [
          {
            code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
            summary: 'Independent review requires one cached passing C3.7 decision.',
          },
        ]);
      }

      const parsedProposal = syntheticDebugWriteProposalSchema.safeParse(proposal);
      const parsedDecision = trustedSyntheticDebugApprovalDecisionSchema.safeParse(decisionInput);
      if (!parsedProposal.success || !parsedDecision.success) {
        return block(snapshot, operation, [
          {
            code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
            summary: 'Independent review rejected an invalid cached proposal binding.',
          },
        ]);
      }

      const bindingKey = workerExecutionBindingKey(snapshot, proposal, parsedDecision.data);
      const trustedVerification = verificationResults.get(bindingKey);
      if (trustedVerification === undefined) {
        return block(snapshot, operation, [
          {
            code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
            summary: 'Independent review could not resolve the cached trusted C3.7 result.',
          },
        ]);
      }

      const existing = independentReviewResults.get(bindingKey);
      if (existing !== undefined) {
        return await resolveIndependentReviewReplay(snapshot, existing, trustedVerification);
      }

      const trustedVerificationResult = await trustedVerification;
      const trustedSnapshot = trustedReviewPrerequisites(trustedVerificationResult);
      if (trustedSnapshot === null || !serializedEqual(snapshot, trustedSnapshot)) {
        const preserved = trustedSnapshot ?? snapshot;
        return block(preserved, operation, [
          {
            code: 'REVIEW_VERIFICATION_INTEGRITY_MISMATCH',
            summary: 'Independent review rejected evidence outside the cached trusted C3.7 result.',
          },
        ]);
      }

      const concurrent = independentReviewResults.get(bindingKey);
      if (concurrent !== undefined) {
        return await resolveIndependentReviewReplay(snapshot, concurrent, trustedVerification);
      }
      const resolution = resolvePendingIndependentReview(snapshot, bindingKey, trustedVerification);
      independentReviewResults.set(bindingKey, resolution);
      return await resolution;
    },

    async evaluateFinalDelivery(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const operation = 'EVALUATE_FINAL_DELIVERY';
      const proposal = snapshot.writeProposal;
      const approval = snapshot.writeApprovalDecision;
      if (proposal === null || approval === null) {
        const invalid = requireState(snapshot, operation, 'REVIEWING');
        return (
          invalid ??
          fail(
            snapshot,
            operation,
            'FINAL_DELIVERY_INTEGRITY_MISMATCH',
            'Final delivery requires the complete cached trusted C3 evidence package.',
          )
        );
      }
      const bindingKey = workerExecutionBindingKey(snapshot, proposal, approval);
      const cachedFinal = finalDeliveryResults.get(bindingKey);
      if (cachedFinal !== undefined) {
        if (
          JSON.stringify(snapshot) === cachedFinal.inputFingerprint ||
          (cachedFinal.result.ok && serializedEqual(snapshot, cachedFinal.result.snapshot))
        ) {
          return cachedFinal.result;
        }
        return reject(
          snapshot,
          operation,
          'FINAL_DELIVERY_INTEGRITY_MISMATCH',
          'Conflicting final delivery evidence was rejected without replacing the first decision.',
        );
      }

      const invalid = requireState(snapshot, operation, 'REVIEWING');
      if (invalid !== null) return invalid;
      const cachedReviewPromise = independentReviewResults.get(bindingKey);
      if (cachedReviewPromise === undefined) {
        return block(snapshot, operation, [
          {
            code: 'FINAL_DELIVERY_INTEGRITY_MISMATCH',
            summary: 'Final delivery could not resolve the cached trusted C3.8 review result.',
          },
        ]);
      }
      const cachedReview = await cachedReviewPromise;
      if (
        !cachedReview.ok ||
        cachedReview.status !== 'ADVANCED' ||
        cachedReview.snapshot.machine.state !== 'REVIEWING' ||
        cachedReview.snapshot.independentReview?.disposition !== 'pass' ||
        !serializedEqual(snapshot, cachedReview.snapshot)
      ) {
        return block(snapshot, operation, [
          {
            code: 'FINAL_DELIVERY_INTEGRITY_MISMATCH',
            summary:
              'Final delivery rejected mismatched case, proposal, execution, verification, or review evidence.',
          },
        ]);
      }

      const report = buildFinalDeliveryReport(cachedReview.snapshot);
      if (report === null) {
        return fail(
          cachedReview.snapshot,
          operation,
          'FINAL_DELIVERY_INTEGRITY_MISMATCH',
          'The cached trusted C3 evidence package is incomplete or corrupt.',
        );
      }
      const patch = { finalDelivery: report } as const;
      const result = report.gate.allowed
        ? apply(
            cachedReview.snapshot,
            operation,
            'MARK_TEST_READY',
            [
              {
                code: 'FINAL_DELIVERY_GATE_ALLOWED',
                summary:
                  'The authoritative final delivery gate allowed the synthetic test candidate.',
              },
            ],
            'ADVANCED',
            patch,
          )
        : block(
            cachedReview.snapshot,
            operation,
            report.gate.blockers.map((summary) => ({
              code: 'FINAL_DELIVERY_GATE_BLOCKER',
              summary,
            })) as [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
            patch,
          );
      finalDeliveryResults.set(
        bindingKey,
        Object.freeze({ inputFingerprint: JSON.stringify(snapshot), result }),
      );
      return result;
    },
  };
  Object.defineProperty(controller, 'evaluateIndependentReview', { enumerable: false });
  Object.defineProperty(controller, 'evaluateFinalDelivery', { enumerable: false });
  return Object.freeze(controller);
}
