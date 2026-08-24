import { canDeliverTestCandidate, type GateDecision } from './gates.js';

export type VerificationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface VerificationRecord {
  profileId: string;
  status: VerificationStatus;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  summary: string;
}

export interface IndependentReviewRecord {
  status: 'passed' | 'failed' | 'not_run';
  summary: string;
}

export interface DebugDeliveryInput {
  projectId: string;
  baselineSha: string;
  candidateSha: string | null;
  isolatedBranch: string | null;
  rollbackRef: string | null;
  rootCause: string;
  changedPaths: readonly string[];
  verification: readonly VerificationRecord[];
  review: IndependentReviewRecord;
  unresolvedBlockingUncertainty: readonly string[];
  unresolvedNonBlockingUncertainty: readonly string[];
}

export interface DebugDeliveryReport extends DebugDeliveryInput {
  status: 'TEST_READY' | 'BLOCKED';
  gate: GateDecision;
}

export function buildDebugDeliveryReport(input: DebugDeliveryInput): DebugDeliveryReport {
  const relevantTests = input.verification.filter((record) => record.status !== 'skipped');
  const failedTests = relevantTests.filter(
    (record) => record.status === 'failed' || record.status === 'error',
  );
  const gate = canDeliverTestCandidate({
    isolatedBranch: input.isolatedBranch,
    rollbackRef: input.rollbackRef,
    changedPaths: input.changedPaths,
    relevantTestsRun: relevantTests.length,
    requiredTestsFailed: failedTests.length,
    independentReview: input.review.status,
    unresolvedBlockingUncertainty: input.unresolvedBlockingUncertainty,
  });

  return {
    ...input,
    status: gate.allowed ? 'TEST_READY' : 'BLOCKED',
    gate,
  };
}
