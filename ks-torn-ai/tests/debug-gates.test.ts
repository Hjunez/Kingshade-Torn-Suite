import { describe, expect, it } from 'vitest';

import {
  canDeliverTestCandidate,
  canStartImplementation,
  canVerifyTestCandidate,
  type DeliveryGateInput,
  type TestCandidateVerificationInput,
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

const verification: TestCandidateVerificationInput = {
  baselineSha: delivery.baselineSha,
  baselineOwnerVerified: delivery.baselineOwnerVerified,
  candidateSha: delivery.candidateSha,
  isolatedBranch: delivery.isolatedBranch,
  rollbackRef: delivery.rollbackRef,
  rollbackSha: delivery.rollbackSha,
  problemEvidenceItems: delivery.problemEvidenceItems,
  rootCauseRecorded: delivery.rootCauseRecorded,
  approvedPaths: delivery.approvedPaths,
  changedPaths: delivery.changedPaths,
  requiredProfileIds: delivery.requiredProfileIds,
  verification: delivery.verification,
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

  it('preserves and blocks unresolved implementation uncertainty deterministically', () => {
    expect(
      canStartImplementation({
        knownGoodBaselineSha: baseline,
        baselineOwnerVerified: true,
        evidenceItems: 1,
        rootCauseRecorded: true,
        unresolvedBlockingUncertainty: [
          'The root-cause hypothesis is not verified.',
          'The root-cause hypothesis is not verified.',
          'The affected surface is still uncertain.',
        ],
      }),
    ).toEqual({
      allowed: false,
      blockers: [
        'blocking uncertainty: The root-cause hypothesis is not verified.',
        'blocking uncertainty: The affected surface is still uncertain.',
      ],
    });
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

describe('centralized pre-review verification policy', () => {
  it('accepts one exact passing required-profile record and bounded candidate facts', () => {
    expect(canVerifyTestCandidate(verification)).toEqual({ allowed: true, blockers: [] });
    expect(
      canVerifyTestCandidate({
        ...verification,
        baselineSha: baseline.toUpperCase(),
        rollbackSha: baseline,
        candidateSha: candidate.toUpperCase(),
        approvedPaths: ['src'],
        changedPaths: ['src/debug/verification.ts'],
      }),
    ).toEqual({ allowed: true, blockers: [] });
  });

  it.each([
    {
      label: 'an invalid baseline SHA',
      patch: { baselineSha: 'a'.repeat(39) },
      blocker: 'delivery baseline is not an exact commit SHA',
    },
    {
      label: 'a candidate equal to the baseline',
      patch: { candidateSha: baseline.toUpperCase() },
      blocker: 'candidate commit is identical to the baseline',
    },
    {
      label: 'a missing candidate SHA',
      patch: { candidateSha: null },
      blocker: 'candidate commit SHA is missing or invalid',
    },
    {
      label: 'an invalid candidate SHA',
      patch: { candidateSha: 'not-a-commit' },
      blocker: 'candidate commit SHA is missing or invalid',
    },
    {
      label: 'missing isolated branch evidence',
      patch: { isolatedBranch: ' ' },
      blocker: 'no isolated branch or workspace',
    },
    {
      label: 'a missing rollback reference',
      patch: { rollbackRef: null },
      blocker: 'rollback reference is missing',
    },
    {
      label: 'a rollback SHA mismatch',
      patch: { rollbackSha: candidate },
      blocker: 'rollback commit does not match the verified baseline',
    },
    {
      label: 'an empty approved path scope',
      patch: { approvedPaths: [] },
      blocker: 'approved path scope is missing',
    },
    {
      label: 'zero changed paths',
      patch: { changedPaths: [] },
      blocker: 'no bounded code change recorded',
    },
    {
      label: 'a changed path outside the approved scope',
      patch: { changedPaths: ['fixture.txt', 'outside.txt'] },
      blocker: 'candidate changed paths outside approval: outside.txt',
    },
  ] satisfies readonly {
    readonly label: string;
    readonly patch: Partial<TestCandidateVerificationInput>;
    readonly blocker: string;
  }[])('blocks $label', ({ patch, blocker }) => {
    const result = canVerifyTestCandidate({ ...verification, ...patch });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it.each([
    {
      label: 'zero required profiles',
      requiredProfileIds: [],
      records: [{ profileId: 'synthetic-check', status: 'passed' }],
      blockers: ['no required test profiles were declared'],
    },
    {
      label: 'a missing required profile',
      requiredProfileIds: ['synthetic-check'],
      records: [],
      blockers: ['required test profile was not executed: synthetic-check'],
    },
    {
      label: 'a skipped required profile',
      requiredProfileIds: ['synthetic-check'],
      records: [{ profileId: 'synthetic-check', status: 'skipped' }],
      blockers: ['required test profile did not pass: synthetic-check'],
    },
    {
      label: 'a failed required profile',
      requiredProfileIds: ['synthetic-check'],
      records: [{ profileId: 'synthetic-check', status: 'failed' }],
      blockers: [
        'required test profile did not pass: synthetic-check',
        'one or more executed verification profiles failed',
      ],
    },
    {
      label: 'an errored required profile',
      requiredProfileIds: ['synthetic-check'],
      records: [{ profileId: 'synthetic-check', status: 'error' }],
      blockers: [
        'required test profile did not pass: synthetic-check',
        'one or more executed verification profiles failed',
      ],
    },
    {
      label: 'duplicate required-profile evidence',
      requiredProfileIds: ['synthetic-check'],
      records: [
        { profileId: 'synthetic-check', status: 'passed' },
        { profileId: 'synthetic-check', status: 'passed' },
      ],
      blockers: ['required test profile has ambiguous duplicate evidence: synthetic-check'],
    },
    {
      label: 'an extra failed profile',
      requiredProfileIds: ['synthetic-check'],
      records: [
        { profileId: 'synthetic-check', status: 'passed' },
        { profileId: 'extra-check', status: 'failed' },
      ],
      blockers: ['one or more executed verification profiles failed'],
    },
    {
      label: 'an extra errored profile',
      requiredProfileIds: ['synthetic-check'],
      records: [
        { profileId: 'synthetic-check', status: 'passed' },
        { profileId: 'extra-check', status: 'error' },
      ],
      blockers: ['one or more executed verification profiles failed'],
    },
  ] satisfies readonly {
    readonly label: string;
    readonly requiredProfileIds: readonly string[];
    readonly records: TestCandidateVerificationInput['verification'];
    readonly blockers: readonly string[];
  }[])('blocks $label', ({ requiredProfileIds, records, blockers }) => {
    expect(
      canVerifyTestCandidate({
        ...verification,
        requiredProfileIds,
        verification: records,
      }),
    ).toEqual({ allowed: false, blockers });
  });

  it('allows extra passing or skipped non-required profile evidence', () => {
    for (const status of ['passed', 'skipped'] as const) {
      expect(
        canVerifyTestCandidate({
          ...verification,
          verification: [
            { profileId: 'synthetic-check', status: 'passed' },
            { profileId: 'extra-check', status },
          ],
        }),
      ).toEqual({ allowed: true, blockers: [] });
    }
  });
});
