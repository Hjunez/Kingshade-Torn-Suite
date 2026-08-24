import { describe, expect, it } from 'vitest';

import { buildDebugDeliveryReport, type DebugDeliveryInput } from '../src/debug/report.js';

const base: DebugDeliveryInput = {
  projectId: 'war-dibs',
  baselineSha: 'known-good',
  candidateSha: 'candidate',
  isolatedBranch: 'fix/regression',
  rollbackRef: 'known-good',
  rootCause: 'reproduced row-identity regression',
  changedPaths: ['KS_Torn_War_Dibs.user.js'],
  verification: [],
  review: { status: 'passed', summary: 'independent review passed' },
  unresolvedBlockingUncertainty: [],
  unresolvedNonBlockingUncertainty: [],
};

describe('Debug delivery reporting', () => {
  it('marks a candidate TEST_READY only from passed evidence', () => {
    const report = buildDebugDeliveryReport({
      ...base,
      verification: [
        {
          profileId: 'war-dibs-regression',
          status: 'passed',
          exitCode: 0,
          startedAt: '2026-08-24T00:00:00Z',
          finishedAt: '2026-08-24T00:01:00Z',
          summary: 'regression reproduced on baseline and fixed on candidate',
        },
      ],
    });

    expect(report.status).toBe('TEST_READY');
    expect(report.gate.allowed).toBe(true);
  });

  it('cannot describe a failing verification set as TEST_READY', () => {
    const report = buildDebugDeliveryReport({
      ...base,
      verification: [
        {
          profileId: 'war-dibs-regression',
          status: 'failed',
          exitCode: 1,
          startedAt: '2026-08-24T00:00:00Z',
          finishedAt: '2026-08-24T00:01:00Z',
          summary: 'regression remains',
        },
      ],
    });

    expect(report.status).toBe('BLOCKED');
    expect(report.gate.blockers).toContain('one or more required tests failed');
  });
});
