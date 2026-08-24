export type BaselineEvidenceState = 'verified_good' | 'failed' | 'candidate' | 'unknown';

export type BaselineEvidenceSource =
  | 'owner_verification'
  | 'regression_suite'
  | 'release_record'
  | 'manual_review';

export interface BaselineEvidence {
  project: string;
  commitSha: string;
  version?: string;
  state: BaselineEvidenceState;
  source: BaselineEvidenceSource;
  observedAt: string;
  note?: string;
}

export type BaselineRejectionReason =
  | 'no_owner_verification'
  | 'invalidated_after_verification';

export interface BaselineCandidateAssessment {
  commitSha: string;
  version?: string;
  ownerVerification?: BaselineEvidence;
  supportingEvidence: readonly BaselineEvidence[];
  invalidatingEvidence: readonly BaselineEvidence[];
  eligible: boolean;
  rejectionReason?: BaselineRejectionReason;
}

export interface BaselineDecision {
  baseline: BaselineEvidence | null;
  reason: 'verified_good_found' | 'no_verified_good_evidence';
  consideredCommits: number;
  assessments: readonly BaselineCandidateAssessment[];
}

function parseObservedAt(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid observedAt timestamp: ${value}`);
  }
  return timestamp;
}

function compareEvidenceNewestFirst(a: BaselineEvidence, b: BaselineEvidence): number {
  const timeDelta = parseObservedAt(b.observedAt) - parseObservedAt(a.observedAt);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return a.commitSha.localeCompare(b.commitSha);
}

function isAfter(record: BaselineEvidence, reference: BaselineEvidence): boolean {
  return parseObservedAt(record.observedAt) > parseObservedAt(reference.observedAt);
}

function assessCommit(records: readonly BaselineEvidence[]): BaselineCandidateAssessment {
  const sorted = [...records].sort(compareEvidenceNewestFirst);
  const newest = sorted[0];
  if (newest === undefined) {
    throw new Error('Cannot assess an empty evidence set');
  }

  const ownerVerification = sorted.find(
    (record) => record.source === 'owner_verification' && record.state === 'verified_good',
  );

  if (ownerVerification === undefined) {
    return {
      commitSha: newest.commitSha,
      ...(newest.version === undefined ? {} : { version: newest.version }),
      supportingEvidence: sorted,
      invalidatingEvidence: [],
      eligible: false,
      rejectionReason: 'no_owner_verification',
    };
  }

  const invalidatingEvidence = sorted.filter(
    (record) =>
      isAfter(record, ownerVerification) &&
      (record.state === 'failed' ||
        (record.source === 'owner_verification' && record.state !== 'verified_good')),
  );

  const supportingEvidence = sorted.filter(
    (record) => record !== ownerVerification && !invalidatingEvidence.includes(record),
  );

  return {
    commitSha: ownerVerification.commitSha,
    ...(ownerVerification.version === undefined ? {} : { version: ownerVerification.version }),
    ownerVerification,
    supportingEvidence,
    invalidatingEvidence,
    eligible: invalidatingEvidence.length === 0,
    ...(invalidatingEvidence.length === 0
      ? {}
      : { rejectionReason: 'invalidated_after_verification' as const }),
  };
}

export function selectKnownGoodBaseline(
  evidence: readonly BaselineEvidence[],
  project: string,
): BaselineDecision {
  const projectEvidence = evidence.filter((record) => record.project === project);
  const byCommit = new Map<string, BaselineEvidence[]>();

  for (const record of projectEvidence) {
    parseObservedAt(record.observedAt);
    const list = byCommit.get(record.commitSha) ?? [];
    list.push(record);
    byCommit.set(record.commitSha, list);
  }

  const assessments = [...byCommit.values()].map(assessCommit);
  const eligible = assessments
    .filter(
      (assessment): assessment is BaselineCandidateAssessment & {
        ownerVerification: BaselineEvidence;
      } => assessment.eligible && assessment.ownerVerification !== undefined,
    )
    .sort((a, b) => compareEvidenceNewestFirst(a.ownerVerification, b.ownerVerification));

  return {
    baseline: eligible[0]?.ownerVerification ?? null,
    reason: eligible.length > 0 ? 'verified_good_found' : 'no_verified_good_evidence',
    consideredCommits: byCommit.size,
    assessments,
  };
}
