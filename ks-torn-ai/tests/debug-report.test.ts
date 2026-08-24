import { describe, expect, it } from 'vitest';

import {
  buildDebugDeliveryReport,
  serializeDebugDeliveryReport,
  type DebugDeliveryInput,
} from '../src/debug/report.js';

const baseline = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const base: DebugDeliveryInput = {
  workflowKind: 'synthetic',
  workerJobId: 'worker-1',
  projectId: 'synthetic',
  baselineSha: baseline,
  baselineOwnerVerified: true,
  candidateSha: candidate,
  isolatedBranch: 'ks-leslie/synthetic/pass',
  workspacePath: 'C:\\temp\\candidate',
  rollbackRef: baseline,
  rollbackSha: baseline,
  problemEvidence: [
    {
      evidenceId: 'fixture-reproduction',
      classification: 'SYNTHETIC',
      summary: 'Fixture starts with the incorrect value.',
    },
  ],
  rootCause: 'Fixture contains the wrong deterministic value.',
  approvedPaths: ['fixture.txt'],
  changedPaths: ['fixture.txt'],
  affectedSurfaces: ['synthetic fixture'],
  requiredProfileIds: ['synthetic-check'],
  verification: [
    {
      profileId: 'synthetic-check',
      required: true,
      status: 'passed',
      exitCode: 0,
      startedAt: '2026-08-24T00:00:00Z',
      finishedAt: '2026-08-24T00:01:00Z',
      summary: 'fixture check passed',
    },
  ],
  review: {
    reviewId: 'review-1',
    status: 'passed',
    summary: 'Independent synthetic review passed.',
  },
  unresolvedBlockingUncertainty: [],
  unresolvedNonBlockingUncertainty: ['Synthetic exercise does not prove Torn PDA behavior.'],
};

describe('Debug delivery reporting', () => {
  it('uses a distinct accepted status for a complete synthetic exercise', () => {
    const report = buildDebugDeliveryReport(base);
    expect(report.status).toBe('SYNTHETIC_ACCEPTED');
    expect(report.gate.allowed).toBe(true);
    expect(JSON.parse(serializeDebugDeliveryReport(report))).toEqual(report);
  });

  it('cannot describe an empty root cause or missing candidate as ready', () => {
    const report = buildDebugDeliveryReport({
      ...base,
      candidateSha: null,
      rootCause: ' ',
    });
    expect(report.status).toBe('BLOCKED');
    expect(report.gate.blockers).toContain('candidate commit SHA is missing or invalid');
    expect(report.gate.blockers).toContain('root cause has not been recorded');
  });

  it('cannot hide a failed verification behind an unrelated pass', () => {
    const report = buildDebugDeliveryReport({
      ...base,
      verification: [
        ...base.verification,
        {
          profileId: 'optional-check',
          required: false,
          status: 'failed',
          exitCode: 1,
          startedAt: '2026-08-24T00:00:00Z',
          finishedAt: '2026-08-24T00:01:00Z',
          summary: 'optional verification exposed a regression',
        },
      ],
    });
    expect(report.status).toBe('BLOCKED');
    expect(report.gate.blockers).toContain('one or more executed verification profiles failed');
  });
});
