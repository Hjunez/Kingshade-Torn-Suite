import { describe, expect, it } from 'vitest';

import {
  selectKnownGoodBaseline,
  type BaselineEvidence,
} from '../src/repository/baseline.js';

describe('selectKnownGoodBaseline', () => {
  it('does not promote a newer candidate above an older verified baseline', () => {
    const evidence: BaselineEvidence[] = [
      {
        project: 'war-dibs',
        commitSha: 'verified-old',
        version: '1.5.138',
        state: 'verified_good',
        source: 'owner_verification',
        observedAt: '2026-08-22T20:00:00Z',
      },
      {
        project: 'war-dibs',
        commitSha: 'new-candidate',
        version: '1.5.144',
        state: 'candidate',
        source: 'regression_suite',
        observedAt: '2026-08-24T04:00:00Z',
      },
    ];

    expect(selectKnownGoodBaseline(evidence, 'war-dibs').baseline?.commitSha).toBe(
      'verified-old',
    );
  });

  it('invalidates an earlier verification when newer evidence marks the same commit failed', () => {
    const evidence: BaselineEvidence[] = [
      {
        project: 'war-dibs',
        commitSha: 'same-commit',
        state: 'verified_good',
        source: 'owner_verification',
        observedAt: '2026-08-22T20:00:00Z',
      },
      {
        project: 'war-dibs',
        commitSha: 'same-commit',
        state: 'failed',
        source: 'owner_verification',
        observedAt: '2026-08-24T05:00:00Z',
      },
    ];

    expect(selectKnownGoodBaseline(evidence, 'war-dibs').baseline).toBeNull();
  });

  it('fails safe when there is no verified-good evidence', () => {
    const decision = selectKnownGoodBaseline([], 'war-dibs');

    expect(decision.baseline).toBeNull();
    expect(decision.reason).toBe('no_verified_good_evidence');
  });
});
