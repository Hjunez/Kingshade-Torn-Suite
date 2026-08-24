import { describe, expect, it } from 'vitest';

import { WriteApprovalStore } from '../src/worker/approval.js';
import type { WorkerJob } from '../src/worker/contracts.js';

const BASELINE = 'a'.repeat(40);
const TOKEN_ONE = '1'.repeat(64);
const TOKEN_TWO = '2'.repeat(64);
const PATCH = [
  'diff --git a/script.js b/script.js',
  '--- a/script.js',
  '+++ b/script.js',
  '@@ -1 +1 @@',
  '-alpha',
  '+beta',
  '',
].join('\n');

function writeJob(overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: 'approval-test',
    mode: 'controlled_write',
    scope: {
      projectId: 'synthetic',
      repositoryRoot: 'C:/trusted/repository',
      allowedPaths: ['script.js'],
      baselineRef: BASELINE,
      branch: 'ks-leslie/approval-test',
    },
    actions: [
      { kind: 'apply_patch', patchId: 'patch-1', expectedBaseSha: BASELINE },
      { kind: 'run_test_profile', profileId: 'synthetic-check' },
      { kind: 'finalize_candidate' },
    ],
    approvalToken: TOKEN_ONE,
    ...overrides,
  };
}

describe('WriteApprovalStore', () => {
  it('binds an approval to the exact project, repository, SHA, branch, paths and patch', () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    const store = new WriteApprovalStore({ now: () => now, tokenFactory: () => TOKEN_ONE });
    const grant = store.issue({
      projectId: 'synthetic',
      repositoryRoot: 'C:/trusted/repository',
      baselineSha: BASELINE,
      branch: 'ks-leslie/approval-test',
      allowedPaths: ['script.js'],
      patchId: 'patch-1',
      patch: PATCH,
      expiresAt: new Date('2026-08-24T10:05:00.000Z'),
    });

    (grant.allowedPaths as string[])[0] = 'attacker.js';

    const consumed = store.consumeForJob(grant.token, writeJob());
    expect(consumed.patch).toBe(PATCH);
    expect(consumed.grant.allowedPaths).toEqual(['script.js']);
    expect(consumed.grant.patchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => store.consumeForJob(grant.token, writeJob())).toThrow('already been used');
  });

  it('consumes a mismatched approval and never permits retry with altered scope', () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    const store = new WriteApprovalStore({ now: () => now, tokenFactory: () => TOKEN_TWO });
    const grant = store.issue({
      projectId: 'synthetic',
      repositoryRoot: 'C:/trusted/repository',
      baselineSha: BASELINE,
      branch: 'ks-leslie/approval-test',
      allowedPaths: ['script.js'],
      patchId: 'patch-1',
      patch: PATCH,
      expiresAt: new Date('2026-08-24T10:05:00.000Z'),
    });
    const wrongScope = writeJob({
      scope: {
        projectId: 'synthetic',
        repositoryRoot: 'C:/trusted/repository',
        allowedPaths: ['other.js'],
        baselineRef: BASELINE,
        branch: 'ks-leslie/approval-test',
      },
      approvalToken: grant.token,
    });

    expect(() => store.consumeForJob(grant.token, wrongScope)).toThrow('path scope');
    expect(() => store.consumeForJob(grant.token, writeJob())).toThrow('already been used');
  });

  it('rejects expired approvals', () => {
    let now = new Date('2026-08-24T10:00:00.000Z');
    const store = new WriteApprovalStore({ now: () => now, tokenFactory: () => TOKEN_ONE });
    const grant = store.issue({
      projectId: 'synthetic',
      repositoryRoot: 'C:/trusted/repository',
      baselineSha: BASELINE,
      branch: 'ks-leslie/approval-test',
      allowedPaths: ['script.js'],
      patchId: 'patch-1',
      patch: PATCH,
      expiresAt: new Date('2026-08-24T10:01:00.000Z'),
    });
    now = new Date('2026-08-24T10:02:00.000Z');

    expect(() => store.consumeForJob(grant.token, writeJob())).toThrow('expired');
  });
});
