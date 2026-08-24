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

export interface BaselineDecision {
  baseline: BaselineEvidence | null;
  reason: 'verified_good_found' | 'no_verified_good_evidence';
  consideredCommits: number;
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

export function selectKnownGoodBaseline(
  evidence: readonly BaselineEvidence[],
  project: string,
): BaselineDecision {
  const projectEvidence = evidence.filter((record) => record.project === project);
  const byCommit = new Map<string, BaselineEvidence[]>();

  for (const record of projectEvidence) {
    const list = byCommit.get(record.commitSha) ?? [];
    list.push(record);
    byCommit.set(record.commitSha, list);
  }

  const currentCommitStates = [...byCommit.values()].map((records) =>
    [...records].sort(compareEvidenceNewestFirst)[0],
  );

  const verified = currentCommitStates
    .filter(
      (record): record is BaselineEvidence =>
        record !== undefined && record.state === 'verified_good',
    )
    .sort(compareEvidenceNewestFirst);

  return {
    baseline: verified[0] ?? null,
    reason: verified.length > 0 ? 'verified_good_found' : 'no_verified_good_evidence',
    consideredCommits: byCommit.size,
  };
}
