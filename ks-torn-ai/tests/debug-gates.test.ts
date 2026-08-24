import { describe, expect, it } from 'vitest';

import {
  canDeliverTestCandidate,
  canStartImplementation,
  type DeliveryGateInput,
} from '../src/debug/gates.js';

const baseline = 'a'.repeat(40);
const candidate = 'b'.repeat(40);

const delivery: DeliveryGateInput = {
  baselineSha: baseline,
  baselineOwnerVerified: true,
  candidateSha: candidate,
  isolatedBranch: 'ks-leslie/synthetic/pass',
  rollbackRef: baseline,
  rollbackSha: baseline,
  problemEvidenceItems: 1,
  rootCauseRecorded: true,
  approvedPaths: ['fixture.txt'],
  changedPaths: ['fixture.txt'],
  requiredProfileIds: ['synthetic-check'],
  verification: [{ profileId: 'synthetic-check', status: 'passed' }],
  independentReview: 'passed',
  independentReviewId: 'review-1',
  independentReviewSummary: 'No blocking findings.',
  unresolvedBlockingUncertainty: [],
};

describe('Debug MVP gates', () => {
  it('blocks implementation until exact owner baseline, evidence and root cause exist', () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: null,
        baselineOwnerVerified: false,
        evidenceItems: 0,
        rootCauseRecorded: false,
        unresolvedBaselineBlocker: 'owner verification missing',
      }),
    ).toEqual({
      allowed: false,
      blockers: [
        'no exact 40-character known-good baseline',
        'baseline lacks explicit owner verification',
        'no reproducible defect evidence collected',
        'root cause has not been recorded',
        'baseline blocker: owner verification missing',
      ],
    });
  });

  it('allows implementation only when all regression preconditions are satisfied', () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: baseline,
        baselineOwnerVerified: true,
        evidenceItems: 2,
        rootCauseRecorded: true,
      }).allowed,
    ).toBe(true);
  });

  it('blocks failed or skipped required tests and missing independent review evidence', () => {
    const decision = canDeliverTestCandidate({
      ...delivery,
      verification: [{ profileId: 'synthetic-check', status: 'skipped' }],
      independentReview: 'not_run',
      independentReviewId: null,
      independentReviewSummary: '',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'required test profile did not pass: synthetic-check',
      'independent review was not run',
      'independent review evidence id is missing',
      'independent review summary is missing',
    ]);
  });

  it('blocks missing candidates and changed paths outside the approved scope', () => {
    const decision = canDeliverTestCandidate({
      ...delivery,
      candidateSha: null,
      changedPaths: ['fixture.txt', 'outside.txt'],
    });
    expect(decision.blockers).toContain('candidate commit SHA is missing or invalid');
    expect(decision.blockers).toContain('candidate changed paths outside approval: outside.txt');
  });

  it('allows delivery only after the complete evidence contract passes', () => {
    expect(canDeliverTestCandidate(delivery)).toEqual({ allowed: true, blockers: [] });
  });
});
