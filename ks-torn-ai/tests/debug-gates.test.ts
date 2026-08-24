import { describe, expect, it } from 'vitest';

import { canDeliverTestCandidate, canStartImplementation } from '../src/debug/gates.js';

describe('Debug MVP gates', () => {
  it('blocks implementation until baseline, defect evidence and root cause are present', () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: null,
        evidenceItems: 0,
        rootCauseRecorded: false,
      }),
    ).toEqual({
      allowed: false,
      blockers: [
        'no explicitly verified known-good baseline',
        'no defect evidence collected',
        'root cause has not been recorded',
      ],
    });
  });

  it('allows implementation only when the regression preconditions are satisfied', () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: 'known-good',
        evidenceItems: 2,
        rootCauseRecorded: true,
      }).allowed,
    ).toBe(true);
  });

  it('blocks delivery if a required test failed or review was not passed', () => {
    const decision = canDeliverTestCandidate({
      isolatedBranch: 'fix/regression',
      rollbackRef: 'known-good',
      changedPaths: ['KS_Torn_War_Dibs.user.js'],
      relevantTestsRun: 4,
      requiredTestsFailed: 1,
      independentReview: 'not_run',
      unresolvedBlockingUncertainty: [],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'one or more required tests failed',
      'independent review was not run',
    ]);
  });

  it('allows TEST delivery only after the full bounded verification contract passes', () => {
    expect(
      canDeliverTestCandidate({
        isolatedBranch: 'fix/regression',
        rollbackRef: 'known-good',
        changedPaths: ['KS_Torn_War_Dibs.user.js'],
        relevantTestsRun: 4,
        requiredTestsFailed: 0,
        independentReview: 'passed',
        unresolvedBlockingUncertainty: [],
      }).allowed,
    ).toBe(true);
  });
});
