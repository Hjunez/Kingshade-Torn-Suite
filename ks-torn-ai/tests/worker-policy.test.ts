import { describe, expect, it } from 'vitest';

import { validateWorkerJob } from '../src/worker/contracts.js';
import { isPathAllowed, normalizeRelativeWorkerPath } from '../src/worker/path-policy.js';

describe('Worker safety policy', () => {
  it('normalizes safe relative paths and rejects escapes or absolute paths', () => {
    expect(normalizeRelativeWorkerPath('src\\worker\\contracts.ts')).toBe(
      'src/worker/contracts.ts',
    );
    expect(normalizeRelativeWorkerPath('../.env')).toBeNull();
    expect(normalizeRelativeWorkerPath('C:\\secret')).toBeNull();
    expect(isPathAllowed('src/worker/contracts.ts', ['src'])).toBe(true);
    expect(isPathAllowed('tests/worker.test.ts', ['src'])).toBe(false);
  });

  it('blocks writes in read-only mode and without explicit approval', () => {
    const baseline = 'a'.repeat(40);
    const errors = validateWorkerJob({
      jobId: 'job',
      mode: 'read_only',
      scope: {
        repositoryRoot: '/repo',
        allowedPaths: ['.'],
        baselineRef: baseline,
      },
      approvedWrite: false,
      actions: [{ kind: 'apply_patch', patchId: 'patch', expectedBaseSha: baseline }],
    });

    expect(errors).toEqual([
      'read_only jobs cannot contain write actions',
      'write actions require explicit approval',
    ]);
  });

  it('blocks writes without an isolated branch and against a stale base', () => {
    const errors = validateWorkerJob({
      jobId: 'job',
      mode: 'controlled_write',
      scope: {
        repositoryRoot: '/repo',
        allowedPaths: ['src'],
        baselineRef: 'a'.repeat(40),
      },
      approvedWrite: true,
      actions: [{ kind: 'apply_patch', patchId: 'patch', expectedBaseSha: 'b'.repeat(40) }],
    });

    expect(errors).toEqual([
      'controlled_write jobs require an isolated branch',
      'patch expected base does not match worker baseline',
    ]);
  });

  it('blocks repository reads that escape the approved path scope', () => {
    const errors = validateWorkerJob({
      jobId: 'job',
      mode: 'read_only',
      scope: {
        repositoryRoot: '/repo',
        allowedPaths: ['src'],
        baselineRef: 'base',
      },
      approvedWrite: false,
      actions: [{ kind: 'inspect_file', path: '../.env' }],
    });

    expect(errors).toEqual(['action path is outside worker scope: ../.env']);
  });
});
