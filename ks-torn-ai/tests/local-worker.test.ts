import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerJob } from '../src/worker/contracts.js';
import { executeLocalWorkerJob } from '../src/worker/local-worker.js';
import { runProcess } from '../src/worker/process-runner.js';

const cleanupPaths: string[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited ${String(result.exitCode)}`);
  }
  return result.stdout.trim();
}

async function createRepository(): Promise<{ root: string; head: string; branch: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ks-leslie-worker-test-'));
  cleanupPaths.push(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'ks-leslie-test@example.invalid']);
  await git(root, ['config', 'user.name', 'KS Leslie Test']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'script.js'), 'alpha\n', 'utf8');
  await git(root, ['add', 'script.js']);
  await git(root, ['commit', '-m', 'baseline']);
  return {
    root,
    head: await git(root, ['rev-parse', 'HEAD']),
    branch: await git(root, ['branch', '--show-current']),
  };
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe('executeLocalWorkerJob', () => {
  it('performs read-only inspection without changing the source worktree', async () => {
    const repository = await createRepository();
    const job: WorkerJob = {
      jobId: 'read-only',
      mode: 'read_only',
      scope: {
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: repository.head,
      },
      approvedWrite: false,
      actions: [
        { kind: 'inspect_file', path: 'script.js' },
        { kind: 'search_text', query: 'alpha', paths: ['script.js'] },
      ],
    };

    const result = await executeLocalWorkerJob(job);

    expect(result.workspacePath).toBeUndefined();
    expect(result.changedPaths).toEqual([]);
    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'passed']);
    expect(result.actions[0]?.output).toBe('alpha\n');
    expect(await git(repository.root, ['branch', '--show-current'])).toBe(repository.branch);
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
  });

  it('applies an approved patch only inside an isolated worktree', async () => {
    const repository = await createRepository();
    const workspaces = await mkdtemp(join(tmpdir(), 'ks-leslie-workspaces-test-'));
    cleanupPaths.push(workspaces);
    const branch = 'ks-leslie/test-isolated-write';
    const patch = [
      'diff --git a/script.js b/script.js',
      '--- a/script.js',
      '+++ b/script.js',
      '@@ -1 +1 @@',
      '-alpha',
      '+beta',
      '',
    ].join('\n');
    const job: WorkerJob = {
      jobId: 'isolated-write',
      mode: 'controlled_write',
      scope: {
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: repository.head,
        branch,
      },
      approvedWrite: true,
      actions: [
        {
          kind: 'apply_patch',
          patchId: 'change-1',
          expectedBaseSha: repository.head,
        },
        { kind: 'inspect_file', path: 'script.js' },
      ],
    };

    const result = await executeLocalWorkerJob(job, {
      patches: new Map([['change-1', patch]]),
      workspaceBaseDir: workspaces,
    });

    expect(result.workspaceBranch).toBe(branch);
    expect(result.workspacePath).toBeDefined();
    expect(result.changedPaths).toEqual(['script.js']);
    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'passed']);
    expect(result.actions[1]?.output).toBe('beta\n');
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
    expect(await git(repository.root, ['branch', '--show-current'])).toBe(repository.branch);
  });

  it('rejects controlled writes without a full baseline SHA', async () => {
    const repository = await createRepository();
    const job: WorkerJob = {
      jobId: 'short-baseline',
      mode: 'controlled_write',
      scope: {
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: repository.head.slice(0, 12),
        branch: 'ks-leslie/rejected',
      },
      approvedWrite: true,
      actions: [
        {
          kind: 'apply_patch',
          patchId: 'change-1',
          expectedBaseSha: repository.head.slice(0, 12),
        },
      ],
    };

    await expect(executeLocalWorkerJob(job)).rejects.toThrow(
      'controlled writes require a full 40-character baseline commit SHA',
    );
  });
});
