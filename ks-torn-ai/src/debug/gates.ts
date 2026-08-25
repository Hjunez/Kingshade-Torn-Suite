import { isPathAllowed } from '../worker/path-policy.js';
import {
  resolvedSyntheticDebugBaselineMode,
  type SyntheticDebugBaselineMode,
} from './baseline-mode.js';

export interface ImplementationGateInput {
  baselineMode?: SyntheticDebugBaselineMode;
  knownGoodBaselineSha: string | null;
  baselineOwnerVerified: boolean;
  defectReferenceSha?: string | null;
  defectReferenceOwnerAcknowledged?: boolean;
  defectReferenceEntryRequirementsSatisfied?: boolean;
  evidenceItems: number;
  rootCauseRecorded: boolean;
  unresolvedBaselineBlocker?: string | null;
  unresolvedBlockingUncertainty?: readonly string[];
}

export interface DeliveryVerification {
  profileId: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
}

export interface TestCandidateVerificationInput {
  baselineMode?: SyntheticDebugBaselineMode;
  baselineSha: string | null;
  baselineOwnerVerified: boolean;
  defectReferenceOwnerAcknowledged?: boolean;
  defectReferenceEntryRequirementsSatisfied?: boolean;
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
}

export interface DeliveryGateInput extends TestCandidateVerificationInput {
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
  const baselineMode = resolvedSyntheticDebugBaselineMode(input.baselineMode);
  if (baselineMode === 'KNOWN_GOOD') {
    if (!isFullCommitSha(input.knownGoodBaselineSha)) {
      blockers.push('no exact 40-character known-good baseline');
    }
    if (!input.baselineOwnerVerified) {
      blockers.push('baseline lacks explicit owner verification');
    }
    if (input.defectReferenceSha !== undefined && input.defectReferenceSha !== null) {
      blockers.push('KNOWN_GOOD mode cannot use a DEFECT_REFERENCE SHA');
    }
  } else {
    if (!isFullCommitSha(input.defectReferenceSha ?? null)) {
      blockers.push('no exact 40-character DEFECT_REFERENCE SHA');
    }
    if (input.defectReferenceOwnerAcknowledged !== true) {
      blockers.push('DEFECT_REFERENCE lacks explicit trusted owner acknowledgement');
    }
    if (input.defectReferenceEntryRequirementsSatisfied !== true) {
      blockers.push('DEFECT_REFERENCE entry contract is incomplete');
    }
    if (input.knownGoodBaselineSha !== null || input.baselineOwnerVerified) {
      blockers.push('DEFECT_REFERENCE must not be represented as owner-verified known-good');
    }
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
  blockers.push(
    ...(input.unresolvedBlockingUncertainty ?? []).map((item) => 'blocking uncertainty: ' + item),
  );
  return { allowed: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function requiredProfileBlockers(input: TestCandidateVerificationInput): readonly string[] {
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

export function canVerifyTestCandidate(input: TestCandidateVerificationInput): GateDecision {
  const blockers: string[] = [];
  const baselineMode = resolvedSyntheticDebugBaselineMode(input.baselineMode);
  if (!isFullCommitSha(input.baselineSha)) {
    blockers.push('delivery baseline is not an exact commit SHA');
  }
  if (baselineMode === 'KNOWN_GOOD') {
    if (!input.baselineOwnerVerified) {
      blockers.push('delivery baseline lacks explicit owner verification');
    }
  } else {
    if (input.baselineOwnerVerified) {
      blockers.push('DEFECT_REFERENCE must not be marked owner-verified known-good');
    }
    if (input.defectReferenceOwnerAcknowledged !== true) {
      blockers.push('delivery DEFECT_REFERENCE lacks trusted owner acknowledgement');
    }
    if (input.defectReferenceEntryRequirementsSatisfied !== true) {
      blockers.push('delivery DEFECT_REFERENCE entry contract is incomplete');
    }
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
    blockers.push(
      baselineMode === 'KNOWN_GOOD'
        ? 'rollback commit does not match the verified baseline'
        : 'rollback commit does not match the approved DEFECT_REFERENCE',
    );
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
  return { allowed: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export function canDeliverTestCandidate(input: DeliveryGateInput): GateDecision {
  const blockers = [...canVerifyTestCandidate(input).blockers];
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
