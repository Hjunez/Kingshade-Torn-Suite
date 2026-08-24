import { describe, expect, it } from 'vitest';

import { parseWorkerJob, type WorkerJob, validateWorkerJob } from '../src/worker/contracts.js';
import { inspectPatch } from '../src/worker/patch-policy.js';
import { isPathAllowed, normalizeRelativeWorkerPath } from '../src/worker/path-policy.js';

const baseline = 'a'.repeat(40);

function job(overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: 'job',
    mode: 'read_only',
    scope: {
      projectId: 'synthetic',
      repositoryRoot: 'C:\\repo',
      allowedPaths: ['src'],
      baselineRef: baseline,
    },
    actions: [{ kind: 'inspect_file', path: 'src/file.ts' }],
    ...overrides,
  };
}

describe('Worker safety policy', () => {
  it('normalizes safe paths and rejects escapes, ADS, devices and control characters', () => {
    expect(normalizeRelativeWorkerPath('src\\worker\\contracts.ts')).toBe(
      'src/worker/contracts.ts',
    );
    for (const unsafe of [
      '../.env',
      'C:\\secret',
      'C:secret',
      '\\\\server\\share',
      'src/file.txt:stream',
      'src/CON.txt',
      'src/LPT9',
      'src/trailing.',
      'src/bad?.txt',
      'src/line\nbreak',
    ]) {
      expect(normalizeRelativeWorkerPath(unsafe), unsafe).toBeNull();
    }
    expect(isPathAllowed('src/worker/contracts.ts', ['src'])).toBe(true);
    expect(isPathAllowed('tests/worker.test.ts', ['src'])).toBe(false);
  });

  it('runtime-validates jobs and rejects model-supplied command fields', () => {
    expect(() =>
      parseWorkerJob({
        ...job(),
        command: 'powershell',
        executable: 'cmd.exe',
      }),
    ).toThrow();
  });

  it('blocks writes in read-only mode and without an approval token', () => {
    const errors = validateWorkerJob(
      job({
        actions: [{ kind: 'apply_patch', patchId: 'patch', expectedBaseSha: baseline }],
      }),
    );
    expect(errors).toEqual([
      'read_only jobs cannot contain write actions',
      'write actions require an application-issued approval token',
      'controlled_write jobs require an isolated branch',
    ]);
  });

  it('blocks stale patch bases and malformed controlled-write sequences', () => {
    const errors = validateWorkerJob(
      job({
        mode: 'controlled_write',
        scope: {
          projectId: 'synthetic',
          repositoryRoot: 'C:\\repo',
          allowedPaths: ['src'],
          baselineRef: baseline,
          branch: 'ks-leslie/test',
        },
        approvalToken: 'f'.repeat(64),
        actions: [
          {
            kind: 'apply_patch',
            patchId: 'patch',
            expectedBaseSha: 'b'.repeat(40),
          },
          { kind: 'finalize_candidate' },
          { kind: 'inspect_file', path: 'src/file.ts' },
        ],
      }),
    );
    expect(errors).toEqual([
      'candidate finalization must be the final Worker action',
      'patch expected base does not match worker baseline',
    ]);
  });

  it('preflights every Git patch section and rejects scope escapes', () => {
    const patch = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      '-safe',
      '+secret',
      '',
    ].join('\n');
    expect(inspectPatch(patch, ['src'])).toEqual({
      changedPaths: ['.env', 'src/file.ts'],
      errors: ['patch path is outside worker scope: .env'],
    });
    expect(
      inspectPatch(
        ['diff --git a/src/file.ts b/src/file.ts', 'old mode 100644', 'new mode 100755'].join('\n'),
        ['src'],
      ).errors,
    ).toContain('patch section 1 has no supported file path headers');
  });
});
