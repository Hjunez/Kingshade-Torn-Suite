import type { BaselineEvidence } from './baseline.js';

export interface GitCommitObservation {
  sha: string;
  message: string;
  committedAt: string;
}

export interface TestRunObservation {
  commitSha: string;
  profileId: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  finishedAt: string;
  summary?: string;
}

const VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)\b/;

export function extractVersionFromText(value: string): string | null {
  return VERSION_PATTERN.exec(value)?.[1] ?? null;
}

export function releaseEvidenceFromCommit(
  project: string,
  commit: GitCommitObservation,
): BaselineEvidence | null {
  if (!/\b(?:release|publish)\b/i.test(commit.message)) {
    return null;
  }

  const version = extractVersionFromText(commit.message);
  return {
    project,
    commitSha: commit.sha,
    ...(version === null ? {} : { version }),
    state: 'candidate',
    source: 'release_record',
    observedAt: commit.committedAt,
    note: 'Release history is supporting evidence only; owner verification is still required.',
  };
}

export function regressionEvidenceFromRun(
  project: string,
  run: TestRunObservation,
): BaselineEvidence | null {
  if (run.status === 'skipped') {
    return null;
  }

  return {
    project,
    commitSha: run.commitSha,
    state: run.status === 'passed' ? 'candidate' : 'failed',
    source: 'regression_suite',
    observedAt: run.finishedAt,
    note: `${run.profileId}: ${run.summary ?? run.status}`,
  };
}
