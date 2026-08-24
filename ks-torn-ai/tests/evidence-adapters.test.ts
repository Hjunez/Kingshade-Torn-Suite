import { describe, expect, it } from 'vitest';

import { selectKnownGoodBaseline, type BaselineEvidence } from '../src/repository/baseline.js';
import {
  regressionEvidenceFromRun,
  releaseEvidenceFromCommit,
} from '../src/repository/evidence-adapters.js';

describe('repository evidence adapters', () => {
  it('extracts release history as supporting candidate evidence only', () => {
    const release = releaseEvidenceFromCommit('war-dibs', {
      sha: 'release',
      message: 'Release KS Torn War Dibs v1.5.138',
      committedAt: '2026-08-22T20:00:00Z',
    });

    expect(release?.version).toBe('1.5.138');
    expect(release?.state).toBe('candidate');
    expect(selectKnownGoodBaseline(release === null ? [] : [release], 'war-dibs').baseline).toBeNull();
  });

  it('lets a later regression failure invalidate owner verification', () => {
    const owner: BaselineEvidence = {
      project: 'war-dibs',
      commitSha: 'release',
      version: '1.5.138',
      state: 'verified_good',
      source: 'owner_verification',
      observedAt: '2026-08-22T20:10:00Z',
    };
    const failed = regressionEvidenceFromRun('war-dibs', {
      commitSha: 'release',
      profileId: 'browser-regression',
      status: 'failed',
      finishedAt: '2026-08-22T20:20:00Z',
    });

    const evidence = failed === null ? [owner] : [owner, failed];
    expect(selectKnownGoodBaseline(evidence, 'war-dibs').baseline).toBeNull();
  });

  it('ignores skipped test runs instead of fabricating evidence', () => {
    expect(
      regressionEvidenceFromRun('war-dibs', {
        commitSha: 'candidate',
        profileId: 'browser-regression',
        status: 'skipped',
        finishedAt: '2026-08-22T20:20:00Z',
      }),
    ).toBeNull();
  });
});
