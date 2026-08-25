import { createHash } from 'node:crypto';

import { redactRepositorySecrets } from '../repository/validation.js';
import { isFullCommitSha } from './gates.js';
import {
  parseTrustedSyntheticDebugReviewRecord,
  type SyntheticDebugEvidenceReference,
  type SyntheticDebugIntakeRecord,
  type SyntheticDebugRootCauseRecord,
  type SyntheticDebugWriteProposal,
  type TrustedSyntheticDebugBaselineRecord,
  type TrustedSyntheticDebugReviewRecord,
} from './records.js';
import type { IndependentReviewRecord } from './report.js';
import type { SyntheticDebugVerificationDecision } from './verification.js';

const MAX_SAFE_TEXT_INPUT = 10_000;
const MAX_SAFE_TEXT = 2_000;
const OPAQUE_APPROVAL_SECRET = /\b[0-9a-f]{64}\b/i;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface SyntheticDebugReviewEvidenceReference {
  readonly evidenceId: string;
  readonly kind: SyntheticDebugEvidenceReference['kind'];
  readonly reference: string;
}

export interface SyntheticDebugReviewRootCause {
  readonly rootCauseId: string;
  readonly explanation: string;
  readonly evidenceReferences: readonly string[];
  readonly status: SyntheticDebugRootCauseRecord['status'];
  readonly confidence: SyntheticDebugRootCauseRecord['confidence'];
}

export interface SyntheticDebugReviewProfileOutcome {
  readonly profileId: string;
  readonly status: 'passed' | 'failed' | 'error' | 'skipped';
}

export interface SyntheticDebugReviewWorkerActionOutcome {
  readonly actionIndex: number;
  readonly kind: SyntheticDebugVerificationDecision['workerActions'][number]['kind'];
  readonly status: SyntheticDebugVerificationDecision['workerActions'][number]['status'];
  readonly profileId: string | null;
}

export interface SyntheticDebugIndependentReviewPackage {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly packageKind: 'INDEPENDENT_REVIEW_PACKAGE';
  readonly sourceBoundary: 'TRUSTED_VERIFIED_EVIDENCE';
  readonly reviewPackageId: string;
  readonly caseId: string;
  readonly projectId: string;
  readonly verifiedBaselineSha: string;
  readonly candidateSha: string;
  readonly rollbackSha: string;
  readonly rollbackRef: string;
  readonly problemSummary: string;
  readonly problemEvidence: readonly SyntheticDebugReviewEvidenceReference[];
  readonly rootCause: SyntheticDebugReviewRootCause;
  readonly boundedChangeSummary: string;
  readonly approvedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly affectedSurfaces: readonly string[];
  readonly requiredVerificationOutcomes: readonly SyntheticDebugReviewProfileOutcome[];
  readonly unresolvedUncertainty: readonly string[];
  readonly workerSummary: {
    readonly status: 'SUCCEEDED';
    readonly isolatedExecution: true;
    readonly retainedWorkspaceEvidence: true;
    readonly actions: readonly SyntheticDebugReviewWorkerActionOutcome[];
  };
  readonly verificationSummary: {
    readonly verificationDecisionId: string;
    readonly status: 'PASSED';
  };
  readonly evidenceReferences: readonly [string];
}

export interface SyntheticDebugIndependentReviewPackageInput {
  readonly caseId: string;
  readonly projectId: string;
  readonly intake: DeepReadonly<SyntheticDebugIntakeRecord>;
  readonly knownGoodBaseline: DeepReadonly<TrustedSyntheticDebugBaselineRecord>;
  readonly problemEvidence: readonly DeepReadonly<SyntheticDebugEvidenceReference>[];
  readonly rootCause: DeepReadonly<SyntheticDebugRootCauseRecord>;
  readonly proposal: DeepReadonly<SyntheticDebugWriteProposal>;
  readonly verification: DeepReadonly<SyntheticDebugVerificationDecision>;
}

type ReviewPackageContent = Omit<
  SyntheticDebugIndependentReviewPackage,
  'reviewPackageId' | 'evidenceReferences'
>;

export type SyntheticDebugIndependentReviewRejectionCode =
  | 'INDEPENDENT_REVIEW_NOT_RUN'
  | 'MALFORMED_INDEPENDENT_REVIEW'
  | 'SENSITIVE_INDEPENDENT_REVIEW'
  | 'INDEPENDENT_REVIEW_SCOPE_MISMATCH'
  | 'INDEPENDENT_REVIEW_CANDIDATE_MISMATCH'
  | 'INDEPENDENT_REVIEW_PACKAGE_MISMATCH'
  | 'INDEPENDENT_REVIEW_EVIDENCE_MISMATCH';

export interface SyntheticDebugIndependentReviewRejected {
  readonly ok: false;
  readonly code: SyntheticDebugIndependentReviewRejectionCode;
  readonly summary: string;
}

export interface SyntheticDebugIndependentReviewAccepted {
  readonly ok: true;
  readonly record: DeepReadonly<TrustedSyntheticDebugReviewRecord>;
}

export type SyntheticDebugIndependentReviewAdaptation =
  | SyntheticDebugIndependentReviewAccepted
  | SyntheticDebugIndependentReviewRejected;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function safeText(value: string, maximum = MAX_SAFE_TEXT): string {
  const bounded = value.slice(0, MAX_SAFE_TEXT_INPUT);
  const repositoryRedacted = redactRepositorySecrets(bounded).value;
  const approvalRedacted = repositoryRedacted.replace(
    /\b[0-9a-f]{64}\b/gi,
    '[REDACTED APPROVAL SECRET]',
  );
  if (approvalRedacted.length <= maximum) return approvalRedacted;
  const marker = '[truncated]';
  return approvalRedacted.slice(0, maximum - marker.length) + marker;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function packageInputIsTrusted(input: SyntheticDebugIndependentReviewPackageInput): boolean {
  const verification = input.verification;
  return (
    input.intake.caseId === input.caseId &&
    input.intake.projectId === input.projectId &&
    input.knownGoodBaseline.caseId === input.caseId &&
    input.knownGoodBaseline.projectId === input.projectId &&
    input.knownGoodBaseline.ownerVerification.status === 'OWNER_VERIFIED' &&
    input.rootCause.caseId === input.caseId &&
    input.rootCause.projectId === input.projectId &&
    input.rootCause.status === 'verified' &&
    input.proposal.caseId === input.caseId &&
    input.proposal.projectId === input.projectId &&
    verification.caseId === input.caseId &&
    verification.projectId === input.projectId &&
    verification.proposalId === input.proposal.proposalId &&
    verification.status === 'PASSED' &&
    verification.workerStatus === 'SUCCEEDED' &&
    verification.isolatedExecution &&
    verification.retainedWorkspaceEvidence &&
    verification.blockers.length === 0 &&
    isFullCommitSha(verification.baselineSha) &&
    isFullCommitSha(verification.candidateSha) &&
    isFullCommitSha(verification.rollbackSha) &&
    verification.baselineSha.toLowerCase() === input.knownGoodBaseline.commitSha.toLowerCase() &&
    verification.baselineSha.toLowerCase() === input.proposal.baselineSha.toLowerCase() &&
    verification.rollbackSha.toLowerCase() === input.proposal.rollbackSha.toLowerCase() &&
    verification.rollbackRef === input.proposal.rollbackRef &&
    sameStrings(verification.approvedPaths, input.proposal.approvedPaths) &&
    sameStrings(verification.requiredProfileIds, input.proposal.requiredTestProfileIds) &&
    verification.profileResults
      .filter(({ required }) => required)
      .every(({ status }) => status === 'passed')
  );
}

function packageIdentifier(content: DeepReadonly<ReviewPackageContent>): string {
  return `review-package-${createHash('sha256')
    .update(JSON.stringify(content), 'utf8')
    .digest('hex')}`;
}

export function buildSyntheticDebugIndependentReviewPackage(
  input: SyntheticDebugIndependentReviewPackageInput,
): DeepReadonly<SyntheticDebugIndependentReviewPackage> {
  if (!packageInputIsTrusted(input)) {
    throw new Error('Independent review requires one matching trusted passed C3.7 decision.');
  }

  const verification = input.verification;
  const requiredProfiles = new Set(verification.requiredProfileIds);
  const content = deepFreeze({
    schemaVersion: '1.0' as const,
    workflowKind: 'synthetic' as const,
    packageKind: 'INDEPENDENT_REVIEW_PACKAGE' as const,
    sourceBoundary: 'TRUSTED_VERIFIED_EVIDENCE' as const,
    caseId: safeText(input.caseId, 128),
    projectId: safeText(input.projectId, 80),
    verifiedBaselineSha: verification.baselineSha?.toLowerCase() ?? '',
    candidateSha: verification.candidateSha?.toLowerCase() ?? '',
    rollbackSha: verification.rollbackSha?.toLowerCase() ?? '',
    rollbackRef: safeText(verification.rollbackRef ?? '', 1_000),
    problemSummary: safeText(input.intake.problem),
    problemEvidence: input.problemEvidence.map((evidence) => ({
      evidenceId: safeText(evidence.evidenceId, 128),
      kind: evidence.kind,
      reference: safeText(evidence.reference, 1_000),
    })),
    rootCause: {
      rootCauseId: safeText(input.rootCause.rootCauseId, 128),
      explanation: safeText(input.rootCause.explanation),
      evidenceReferences: input.rootCause.evidenceReferences.map((reference) =>
        safeText(reference, 128),
      ),
      status: input.rootCause.status,
      confidence: input.rootCause.confidence,
    },
    boundedChangeSummary: safeText(input.proposal.boundedChangeSummary),
    approvedPaths: verification.approvedPaths.map((path) => safeText(path, 500)),
    changedPaths: verification.changedPaths.map((path) => safeText(path, 500)),
    affectedSurfaces: input.intake.affectedSurfaces.map((surface) => safeText(surface, 500)),
    requiredVerificationOutcomes: verification.profileResults
      .filter(({ profileId }) => requiredProfiles.has(profileId))
      .map(({ profileId, status }) => ({ profileId: safeText(profileId, 100), status })),
    unresolvedUncertainty: input.rootCause.unresolvedUncertainty.map((uncertainty) =>
      safeText(uncertainty, 500),
    ),
    workerSummary: {
      status: 'SUCCEEDED' as const,
      isolatedExecution: true as const,
      retainedWorkspaceEvidence: true as const,
      actions: verification.workerActions.map(({ actionIndex, kind, status, profileId }) => ({
        actionIndex,
        kind,
        status,
        profileId: profileId === null ? null : safeText(profileId, 100),
      })),
    },
    verificationSummary: {
      verificationDecisionId: verification.verificationDecisionId,
      status: 'PASSED' as const,
    },
  } satisfies ReviewPackageContent);
  const reviewPackageId = packageIdentifier(content);
  return deepFreeze({
    ...content,
    reviewPackageId,
    evidenceReferences: [reviewPackageId],
  });
}

function reviewContainsSensitiveContent(record: TrustedSyntheticDebugReviewRecord): boolean {
  if (/^[0-9a-f]{64}$/i.test(record.reviewId)) return true;
  const freeText = [record.reviewId, record.summary, ...record.findings, ...record.blockers];
  return freeText.some(
    (value) =>
      OPAQUE_APPROVAL_SECRET.test(value) || redactRepositorySecrets(value).redactionCount > 0,
  );
}

function rejected(
  code: SyntheticDebugIndependentReviewRejectionCode,
  summary: string,
): SyntheticDebugIndependentReviewRejected {
  return deepFreeze({ ok: false as const, code, summary });
}

export function adaptSyntheticDebugIndependentReview(
  input: unknown,
  reviewPackage: DeepReadonly<SyntheticDebugIndependentReviewPackage>,
): SyntheticDebugIndependentReviewAdaptation {
  if (input === null || input === undefined) {
    return rejected(
      'INDEPENDENT_REVIEW_NOT_RUN',
      'The independent review service returned no review result.',
    );
  }

  let parsed: TrustedSyntheticDebugReviewRecord;
  try {
    parsed = parseTrustedSyntheticDebugReviewRecord(input);
  } catch {
    return rejected(
      'MALFORMED_INDEPENDENT_REVIEW',
      'The independent review service returned an invalid strict review record.',
    );
  }
  if (reviewContainsSensitiveContent(parsed)) {
    return rejected(
      'SENSITIVE_INDEPENDENT_REVIEW',
      'The independent review result contained content outside the safe review boundary.',
    );
  }
  if (parsed.caseId !== reviewPackage.caseId || parsed.projectId !== reviewPackage.projectId) {
    return rejected(
      'INDEPENDENT_REVIEW_SCOPE_MISMATCH',
      'The independent review result did not match the active case and project.',
    );
  }
  if (parsed.candidateSha.toLowerCase() !== reviewPackage.candidateSha.toLowerCase()) {
    return rejected(
      'INDEPENDENT_REVIEW_CANDIDATE_MISMATCH',
      'The independent review result did not match the verified candidate.',
    );
  }
  if (parsed.reviewPackageId !== reviewPackage.reviewPackageId) {
    return rejected(
      'INDEPENDENT_REVIEW_PACKAGE_MISMATCH',
      'The independent review result did not match the trusted review package.',
    );
  }
  if (!sameStrings(parsed.evidenceInspected, reviewPackage.evidenceReferences)) {
    return rejected(
      'INDEPENDENT_REVIEW_EVIDENCE_MISMATCH',
      'The independent review result did not inspect the complete trusted review package.',
    );
  }

  return deepFreeze({
    ok: true as const,
    record: {
      ...parsed,
      candidateSha: parsed.candidateSha.toLowerCase(),
      findings: [...parsed.findings],
      blockers: [...parsed.blockers],
      evidenceInspected: [...parsed.evidenceInspected],
    },
  });
}

export function independentReviewForDelivery(
  record: DeepReadonly<TrustedSyntheticDebugReviewRecord> | null,
): Readonly<IndependentReviewRecord> {
  if (record === null) {
    return Object.freeze({ reviewId: null, status: 'not_run', summary: '' });
  }
  return Object.freeze({
    reviewId: record.reviewId,
    status: record.disposition === 'pass' ? 'passed' : 'failed',
    summary: record.summary,
  });
}
