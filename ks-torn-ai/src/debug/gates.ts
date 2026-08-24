import { isPathAllowed } from '../worker/path-policy.js';

export interface ImplementationGateInput {
  knownGoodBaselineSha: string | null;
  baselineOwnerVerified: boolean;
  evidenceItems: number;
  rootCauseRecorded: boolean;
  unresolvedBaselineBlocker?: string | null;
}

export interface DeliveryVerification {
  profileId: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
}

export interface DeliveryGateInput {
  baselineSha: string | null;
  baselineOwnerVerified: boolean;
  candidateSha: string | null;
  isolatedBranch: string | null;
  rollbackRef: string | null;
  rollbackSha: string | null;
  problemEvidenceItems: number;
  rootCauseRecorded: boolean;
  approvedPaths: readonly string[];
  changedPaths: readonly string[];
  requiredProfileIds: readonly string[];
  verification: readonly DeliveryVerification[];
  independentReview: 'passed' | 'failed' | 'not_run';
  independentReviewId: string | null;
  independentReviewSummary: string;
  unresolvedBlockingUncertainty: readonly string[];
}

export interface GateDecision {
  allowed: boolean;
  blockers: readonly string[];
}

export function isFullCommitSha(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40}$/i.test(value);
}

export function canStartImplementation(input: ImplementationGateInput): GateDecision {
  const blockers: string[] = [];
  if (!isFullCommitSha(input.knownGoodBaselineSha)) {
    blockers.push('no exact 40-character known-good baseline');
  }
  if (!input.baselineOwnerVerified) {
    blockers.push('baseline lacks explicit owner verification');
  }
  if (!Number.isSafeInteger(input.evidenceItems) || input.evidenceItems < 1) {
    blockers.push('no reproducible defect evidence collected');
  }
  if (!input.rootCauseRecorded) {
    blockers.push('root cause has not been recorded');
  }
  if (input.unresolvedBaselineBlocker !== undefined && input.unresolvedBaselineBlocker !== null) {
    blockers.push('baseline blocker: ' + input.unresolvedBaselineBlocker);
  }
  return { allowed: blockers.length === 0, blockers };
}

function requiredProfileBlockers(input: DeliveryGateInput): readonly string[] {
  if (input.requiredProfileIds.length === 0) {
    return ['no required test profiles were declared'];
  }
  const blockers: string[] = [];
  for (const profileId of new Set(input.requiredProfileIds)) {
    const records = input.verification.filter((record) => record.profileId === profileId);
    if (records.length !== 1) {
      blockers.push(
        records.length === 0
          ? 'required test profile was not executed: ' + profileId
          : 'required test profile has ambiguous duplicate evidence: ' + profileId,
      );
      continue;
    }
    if (records[0]?.status !== 'passed') {
      blockers.push('required test profile did not pass: ' + profileId);
    }
  }
  return blockers;
}

export function canDeliverTestCandidate(input: DeliveryGateInput): GateDecision {
  const blockers: string[] = [];
  if (!isFullCommitSha(input.baselineSha)) {
    blockers.push('delivery baseline is not an exact commit SHA');
  }
  if (!input.baselineOwnerVerified) {
    blockers.push('delivery baseline lacks explicit owner verification');
  }
  if (!isFullCommitSha(input.candidateSha)) {
    blockers.push('candidate commit SHA is missing or invalid');
  } else if (
    input.baselineSha !== null &&
    input.candidateSha.toLowerCase() === input.baselineSha.toLowerCase()
  ) {
    blockers.push('candidate commit is identical to the baseline');
  }
  if (input.isolatedBranch === null || input.isolatedBranch.trim().length === 0) {
    blockers.push('no isolated branch or workspace');
  }
  if (input.rollbackRef === null || input.rollbackRef.trim().length === 0) {
    blockers.push('rollback reference is missing');
  }
  if (!isFullCommitSha(input.rollbackSha)) {
    blockers.push('rollback commit SHA is missing or invalid');
  } else if (
    input.baselineSha !== null &&
    input.rollbackSha.toLowerCase() !== input.baselineSha.toLowerCase()
  ) {
    blockers.push('rollback commit does not match the verified baseline');
  }
  if (!Number.isSafeInteger(input.problemEvidenceItems) || input.problemEvidenceItems < 1) {
    blockers.push('no reproducible problem evidence recorded');
  }
  if (!input.rootCauseRecorded) {
    blockers.push('root cause has not been recorded');
  }
  if (input.approvedPaths.length === 0) {
    blockers.push('approved path scope is missing');
  }
  if (input.changedPaths.length === 0) {
    blockers.push('no bounded code change recorded');
  } else {
    const escaped = input.changedPaths.filter((path) => !isPathAllowed(path, input.approvedPaths));
    if (escaped.length > 0) {
      blockers.push('candidate changed paths outside approval: ' + escaped.join(', '));
    }
  }
  blockers.push(...requiredProfileBlockers(input));
  if (
    input.verification.some((record) => record.status === 'failed' || record.status === 'error')
  ) {
    blockers.push('one or more executed verification profiles failed');
  }
  if (input.independentReview !== 'passed') {
    blockers.push(
      input.independentReview === 'failed'
        ? 'independent review failed'
        : 'independent review was not run',
    );
  }
  if (input.independentReviewId === null || input.independentReviewId.trim().length === 0) {
    blockers.push('independent review evidence id is missing');
  }
  if (input.independentReviewSummary.trim().length === 0) {
    blockers.push('independent review summary is missing');
  }
  blockers.push(
    ...input.unresolvedBlockingUncertainty.map((item) => 'blocking uncertainty: ' + item),
  );
  return { allowed: blockers.length === 0, blockers: [...new Set(blockers)] };
}
