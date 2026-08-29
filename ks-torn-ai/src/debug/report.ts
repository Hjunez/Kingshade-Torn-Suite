import {
  resolvedSyntheticDebugBaselineMode,
  type SyntheticDebugBaselineMode,
} from './baseline-mode.js';
import { canDeliverTestCandidate, type GateDecision } from './gates.js';

export type VerificationStatus = 'passed' | 'failed' | 'error' | 'skipped';
export type EvidenceClassification =
  | 'OFFICIAL_CURRENT'
  | 'USER_VERIFIED'
  | 'COMMUNITY'
  | 'INFERENCE'
  | 'SYNTHETIC';

export interface ProblemEvidenceRecord {
  evidenceId: string;
  classification: EvidenceClassification;
  summary: string;
}

export interface VerificationRecord {
  profileId: string;
  required: boolean;
  status: VerificationStatus;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export interface IndependentReviewRecord {
  reviewId: string | null;
  status: 'passed' | 'failed' | 'not_run';
  summary: string;
}

export interface DefectReferenceReportContext {
  referenceSha: string;
  referenceVersion: string | null;
  historicalSearchBoundary: string;
  defectEvidenceReferences: readonly string[];
  knownPreExistingDefects: readonly string[];
  knownUnrelatedFailures: readonly string[];
  reasonSelected: string;
  rollbackReferenceSemantics: string;
  ownerAcknowledgementReference: string;
  notOwnerVerifiedKnownGood: true;
  separateWriteApprovalRequired: true;
}

export interface DebugDeliveryInput {
  workflowKind: 'production' | 'synthetic';
  caseId?: string;
  workerJobId: string;
  projectId: string;
  baselineMode?: SyntheticDebugBaselineMode;
  baselineSha: string | null;
  baselineOwnerVerified: boolean;
  referenceWasOwnerVerifiedKnownGood?: boolean;
  defectReference?: DefectReferenceReportContext | null;
  candidateSha: string | null;
  isolatedBranch: string | null;
  workspacePath: string | null;
  rollbackRef: string | null;
  rollbackSha: string | null;
  problemEvidence: readonly ProblemEvidenceRecord[];
  rootCause: string;
  approvedPaths: readonly string[];
  changedPaths: readonly string[];
  affectedSurfaces: readonly string[];
  requiredProfileIds: readonly string[];
  verification: readonly VerificationRecord[];
  review: IndependentReviewRecord;
  unresolvedBlockingUncertainty: readonly string[];
  unresolvedNonBlockingUncertainty: readonly string[];
}

export interface DebugDeliveryReport extends DebugDeliveryInput {
  schemaVersion: '1.0';
  baselineMode: SyntheticDebugBaselineMode;
  referenceWasOwnerVerifiedKnownGood: boolean;
  defectReference: DefectReferenceReportContext | null;
  implementationBasis: string;
  productionReleaseStatus: 'OWNER_VERIFICATION_REQUIRED';
  status: 'TEST_READY' | 'BLOCKED';
  gate: GateDecision;
}

function completeDefectReferenceContext(
  input: DebugDeliveryInput,
  context: DefectReferenceReportContext | null,
): boolean {
  const runtimeFlags = context as null | {
    readonly notOwnerVerifiedKnownGood?: unknown;
    readonly separateWriteApprovalRequired?: unknown;
  };
  return (
    context !== null &&
    input.baselineSha !== null &&
    context.referenceSha.toLowerCase() === input.baselineSha.toLowerCase() &&
    context.historicalSearchBoundary.trim().length > 0 &&
    context.defectEvidenceReferences.length > 0 &&
    context.knownPreExistingDefects.length > 0 &&
    context.reasonSelected.trim().length > 0 &&
    context.rollbackReferenceSemantics.trim().length > 0 &&
    context.ownerAcknowledgementReference.trim().length > 0 &&
    runtimeFlags?.notOwnerVerifiedKnownGood === true &&
    runtimeFlags.separateWriteApprovalRequired === true &&
    !input.baselineOwnerVerified &&
    input.referenceWasOwnerVerifiedKnownGood !== true
  );
}

export function buildDebugDeliveryReport(input: DebugDeliveryInput): DebugDeliveryReport {
  const baselineMode = resolvedSyntheticDebugBaselineMode(input.baselineMode);
  const defectReference =
    baselineMode === 'DEFECT_REFERENCE' ? (input.defectReference ?? null) : null;
  const defectReferenceEntryComplete = completeDefectReferenceContext(input, defectReference);
  const baselineOwnerVerified = baselineMode === 'KNOWN_GOOD' && input.baselineOwnerVerified;
  const referenceWasOwnerVerifiedKnownGood = baselineMode === 'KNOWN_GOOD' && baselineOwnerVerified;
  const gate = canDeliverTestCandidate({
    baselineMode,
    baselineSha: input.baselineSha,
    baselineOwnerVerified,
    defectReferenceOwnerAcknowledged:
      (defectReference?.ownerAcknowledgementReference.trim().length ?? 0) > 0,
    defectReferenceEntryRequirementsSatisfied: defectReferenceEntryComplete,
    candidateSha: input.candidateSha,
    isolatedBranch: input.isolatedBranch,
    rollbackRef: input.rollbackRef,
    rollbackSha: input.rollbackSha,
    problemEvidenceItems: input.problemEvidence.length,
    rootCauseRecorded: input.rootCause.trim().length > 0,
    approvedPaths: input.approvedPaths,
    changedPaths: input.changedPaths,
    requiredProfileIds: input.requiredProfileIds,
    verification: input.verification,
    independentReview: input.review.status,
    independentReviewId: input.review.reviewId,
    independentReviewSummary: input.review.summary,
    unresolvedBlockingUncertainty: input.unresolvedBlockingUncertainty,
  });
  return deepFreeze({
    ...input,
    schemaVersion: '1.0',
    baselineMode,
    baselineOwnerVerified,
    referenceWasOwnerVerifiedKnownGood,
    defectReference,
    implementationBasis:
      baselineMode === 'KNOWN_GOOD'
        ? 'Implementation was based on an owner-verified KNOWN_GOOD baseline.'
        : 'Implementation was based on a DEFECT_REFERENCE that contained the documented pre-existing defect and was not owner-verified known-good.',
    productionReleaseStatus: 'OWNER_VERIFICATION_REQUIRED',
    status: gate.allowed ? 'TEST_READY' : 'BLOCKED',
    gate,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function serializeDebugDeliveryReport(report: DebugDeliveryReport): string {
  return JSON.stringify(report, null, 2);
}
