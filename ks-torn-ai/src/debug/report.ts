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

export interface DebugDeliveryInput {
  workflowKind: 'production' | 'synthetic';
  caseId?: string;
  workerJobId: string;
  projectId: string;
  baselineSha: string | null;
  baselineOwnerVerified: boolean;
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
  status: 'TEST_READY' | 'BLOCKED';
  gate: GateDecision;
}

export function buildDebugDeliveryReport(input: DebugDeliveryInput): DebugDeliveryReport {
  const gate = canDeliverTestCandidate({
    baselineSha: input.baselineSha,
    baselineOwnerVerified: input.baselineOwnerVerified,
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
