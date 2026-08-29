import { describe, expect, it } from 'vitest';

import { selectKnownGoodBaseline, type BaselineEvidence } from '../src/repository/baseline.js';

describe('selectKnownGoodBaseline', () => {
  it('does not promote a newer candidate above an older owner-verified baseline', () => {
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

    expect(selectKnownGoodBaseline(evidence, 'war-dibs').baseline?.commitSha).toBe('verified-old');
  });

  it('does not treat passing automation or a release record as owner verification', () => {
    const evidence: BaselineEvidence[] = [
      {
        project: 'war-dibs',
        commitSha: 'automated-only',
        version: '1.5.145',
        state: 'verified_good',
        source: 'regression_suite',
        observedAt: '2026-08-24T04:00:00Z',
      },
      {
        project: 'war-dibs',
        commitSha: 'automated-only',
        version: '1.5.145',
        state: 'verified_good',
        source: 'release_record',
        observedAt: '2026-08-24T04:01:00Z',
      },
    ];

    const decision = selectKnownGoodBaseline(evidence, 'war-dibs');
    expect(decision.baseline).toBeNull();
    expect(decision.assessments[0]?.rejectionReason).toBe('no_owner_verification');
  });

  it('invalidates an earlier owner verification when newer evidence marks the same commit failed', () => {
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
        source: 'regression_suite',
        observedAt: '2026-08-24T05:00:00Z',
      },
    ];

    const decision = selectKnownGoodBaseline(evidence, 'war-dibs');
    expect(decision.baseline).toBeNull();
    expect(decision.assessments[0]?.rejectionReason).toBe('invalidated_after_verification');
  });

  it('fails safe when there is no verified-good evidence', () => {
    const decision = selectKnownGoodBaseline([], 'war-dibs');

    expect(decision.baseline).toBeNull();
    expect(decision.reason).toBe('no_verified_good_evidence');
  });
});
