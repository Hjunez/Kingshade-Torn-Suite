import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WriteApprovalStore } from '../src/worker/approval.js';
import type { WorkerJob } from '../src/worker/contracts.js';
import { executeLocalWorkerJob } from '../src/worker/local-worker.js';
import { runProcess } from '../src/worker/process-runner.js';
import type { TestProfile } from '../src/worker/test-profiles.js';

const cleanupPaths: string[] = [];

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'git exited ' + String(result.exitCode));
  }
  return result.stdout.trim();
}

async function createRepository(): Promise<{
  holder: string;
  root: string;
  workspaces: string;
  head: string;
  branch: string;
}> {
  const holder = await mkdtemp(join(tmpdir(), 'ks-leslie-worker-test-'));
  cleanupPaths.push(holder);
  const root = join(holder, 'repo');
  const workspaces = join(holder, 'workspaces');
  await mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'ks-leslie-test@example.invalid']);
  await git(root, ['config', 'user.name', 'KS Leslie Test']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'script.js'), 'alpha\n', 'utf8');
  await git(root, ['add', 'script.js']);
  await git(root, ['commit', '-m', 'baseline']);
  return {
    holder,
    root,
    workspaces,
    head: await git(root, ['rev-parse', 'HEAD']),
    branch: await git(root, ['branch', '--show-current']),
  };
}

function patchValue(value: string): string {
  return [
    'diff --git a/script.js b/script.js',
    '--- a/script.js',
    '+++ b/script.js',
    '@@ -1 +1 @@',
    '-alpha',
    '+' + value,
    '',
  ].join('\n');
}

function passingProfile(): TestProfile {
  return {
    id: 'synthetic-check',
    purpose: 'Check the isolated fixture value without shell execution.',
    source: 'test fixture',
    availability: 'available',
    steps: [
      {
        executable: 'node',
        args: [
          '-e',
          "const fs=require('node:fs');process.exit(fs.readFileSync('script.js','utf8')==='beta\\n'&&!process.env.OPENAI_API_KEY?0:1)",
        ],
        workingDirectory: '.',
        timeoutMs: 10_000,
      },
    ],
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
        projectId: 'synthetic',
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: repository.head,
      },
      actions: [
        { kind: 'inspect_file', path: 'script.js' },
        { kind: 'search_text', query: 'alpha', paths: ['script.js'] },
      ],
    };
    const result = await executeLocalWorkerJob(job);
    expect(result.workspacePath).toBeUndefined();
    expect(result.workspaceRetained).toBe(false);
    expect(result.changedPaths).toEqual([]);
    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'passed']);
    expect(result.actions[0]?.output).toBe('alpha\n');
    expect(await git(repository.root, ['branch', '--show-current'])).toBe(repository.branch);
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
  }, 30_000);

  it('scopes ref comparisons to the trusted project paths', async () => {
    const repository = await createRepository();
    const externalDiffMarker = join(repository.holder, 'external-diff-ran');
    const externalDiffDriver = join(repository.holder, 'external-diff.mjs');
    await writeFile(
      externalDiffDriver,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(externalDiffMarker)}, 'ran');\n`,
      'utf8',
    );
    await git(repository.root, [
      'config',
      'diff.external',
      `"${process.execPath}" "${externalDiffDriver}"`,
    ]);
    const base = repository.head;
    await writeFile(join(repository.root, 'script.js'), 'beta\n', 'utf8');
    await writeFile(join(repository.root, 'outside.txt'), 'outside\n', 'utf8');
    await git(repository.root, ['add', '.']);
    await git(repository.root, ['commit', '-m', 'change inside and outside scope']);
    const head = await git(repository.root, ['rev-parse', 'HEAD']);

    const result = await executeLocalWorkerJob({
      jobId: 'scoped-compare',
      mode: 'read_only',
      scope: {
        projectId: 'synthetic',
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: head,
      },
      actions: [{ kind: 'compare_refs', baseRef: base, headRef: head }],
    });

    expect(result.actions[0]?.status).toBe('passed');
    expect(result.actions[0]?.output).toContain('script.js');
    expect(result.actions[0]?.output).not.toContain('outside.txt');
    await expect(readFile(externalDiffMarker, 'utf8')).rejects.toThrow();
  }, 30_000);

  it('runs test profiles in a disposable worktree with secrets removed', async () => {
    const repository = await createRepository();
    const sideEffectProfile: TestProfile = {
      id: 'isolated-side-effect',
      purpose: 'Prove profile writes cannot reach the source worktree.',
      source: 'test fixture',
      availability: 'available',
      steps: [
        {
          executable: 'node',
          args: [
            '-e',
            "const fs=require('node:fs');if(process.env.OPENAI_API_KEY)process.exit(2);fs.writeFileSync('profile-output.tmp','isolated\\n')",
          ],
          workingDirectory: '.',
          timeoutMs: 10_000,
        },
      ],
    };
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      const result = await executeLocalWorkerJob(
        {
          jobId: 'isolated-profile',
          mode: 'read_only',
          scope: {
            projectId: 'synthetic',
            repositoryRoot: repository.root,
            allowedPaths: ['.'],
            baselineRef: repository.head,
          },
          actions: [{ kind: 'run_test_profile', profileId: sideEffectProfile.id }],
        },
        {
          testProfiles: [sideEffectProfile],
          workspaceBaseDir: repository.workspaces,
        },
      );
      expect(result.isolatedExecution).toBe(true);
      expect(result.workspaceRetained).toBe(false);
      expect(result.actions[0]?.status).toBe('passed');
      await expect(readFile(join(repository.root, 'profile-output.tmp'), 'utf8')).rejects.toThrow();
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousSecret;
      }
    }
  }, 30_000);

  it('applies, tests and finalizes an approved patch only in an isolated worktree', async () => {
    const repository = await createRepository();
    const branch = 'ks-leslie/test-isolated-write';
    const patch = patchValue('beta');
    const approvals = new WriteApprovalStore();
    const grant = approvals.issue({
      projectId: 'synthetic',
      repositoryRoot: repository.root,
      baselineSha: repository.head,
      branch,
      allowedPaths: ['script.js'],
      patchId: 'change-1',
      patch,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const job: WorkerJob = {
      jobId: 'isolated-write',
      mode: 'controlled_write',
      scope: {
        projectId: 'synthetic',
        repositoryRoot: repository.root,
        allowedPaths: ['script.js'],
        baselineRef: repository.head,
        branch,
      },
      approvalToken: grant.token,
      actions: [
        { kind: 'apply_patch', patchId: 'change-1', expectedBaseSha: repository.head },
        { kind: 'run_test_profile', profileId: 'synthetic-check' },
        { kind: 'finalize_candidate' },
      ],
    };
    const result = await executeLocalWorkerJob(job, {
      approvalStore: approvals,
      testProfiles: [passingProfile()],
      workspaceBaseDir: repository.workspaces,
    });
    expect(result.workspaceBranch).toBe(branch);
    expect(result.workspacePath).toBeDefined();
    expect(result.workspaceRetained).toBe(true);
    expect(result.changedPaths).toEqual(['script.js']);
    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'passed', 'passed']);
    expect(result.headShaAfter).not.toBe(repository.head);
    expect(await readFile(join(result.workspacePath ?? '', 'script.js'), 'utf8')).toBe('beta\n');
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
    expect(await git(repository.root, ['branch', '--show-current'])).toBe(repository.branch);
    await expect(
      executeLocalWorkerJob(job, {
        approvalStore: approvals,
        testProfiles: [passingProfile()],
        workspaceBaseDir: repository.workspaces,
      }),
    ).rejects.toThrow('already been used');
  }, 30_000);

  it('rejects an approval after the source HEAD advances', async () => {
    const repository = await createRepository();
    const patch = patchValue('beta');
    const approvals = new WriteApprovalStore();
    const grant = approvals.issue({
      projectId: 'synthetic',
      repositoryRoot: repository.root,
      baselineSha: repository.head,
      branch: 'ks-leslie/stale',
      allowedPaths: ['script.js'],
      patchId: 'stale-change',
      patch,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await writeFile(join(repository.root, 'other.txt'), 'advance\n', 'utf8');
    await git(repository.root, ['add', 'other.txt']);
    await git(repository.root, ['commit', '-m', 'advance source']);
    await expect(
      executeLocalWorkerJob(
        {
          jobId: 'stale',
          mode: 'controlled_write',
          scope: {
            projectId: 'synthetic',
            repositoryRoot: repository.root,
            allowedPaths: ['script.js'],
            baselineRef: repository.head,
            branch: 'ks-leslie/stale',
          },
          approvalToken: grant.token,
          actions: [
            {
              kind: 'apply_patch',
              patchId: 'stale-change',
              expectedBaseSha: repository.head,
            },
          ],
        },
        {
          approvalStore: approvals,
          workspaceBaseDir: repository.workspaces,
        },
      ),
    ).rejects.toThrow('stale baseline');
  }, 30_000);

  it('rolls back and removes a candidate when a test writes outside approval', async () => {
    const repository = await createRepository();
    const branch = 'ks-leslie/test-scope-rollback';
    const patch = patchValue('beta');
    const approvals = new WriteApprovalStore();
    const grant = approvals.issue({
      projectId: 'synthetic',
      repositoryRoot: repository.root,
      baselineSha: repository.head,
      branch,
      allowedPaths: ['script.js'],
      patchId: 'scope-escape',
      patch,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const escapingProfile: TestProfile = {
      id: 'scope-escape-check',
      purpose: 'Attempt an out-of-scope test side effect.',
      source: 'test fixture',
      availability: 'available',
      steps: [
        {
          executable: 'node',
          args: ['-e', "require('node:fs').writeFileSync('outside.tmp','escape\\n')"],
          workingDirectory: '.',
          timeoutMs: 10_000,
        },
      ],
    };
    const result = await executeLocalWorkerJob(
      {
        jobId: 'scope-rollback',
        mode: 'controlled_write',
        scope: {
          projectId: 'synthetic',
          repositoryRoot: repository.root,
          allowedPaths: ['script.js'],
          baselineRef: repository.head,
          branch,
        },
        approvalToken: grant.token,
        actions: [
          {
            kind: 'apply_patch',
            patchId: 'scope-escape',
            expectedBaseSha: repository.head,
          },
          { kind: 'run_test_profile', profileId: escapingProfile.id },
          { kind: 'finalize_candidate' },
        ],
      },
      {
        approvalStore: approvals,
        testProfiles: [escapingProfile],
        workspaceBaseDir: repository.workspaces,
      },
    );

    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'error']);
    expect(result.actions[1]?.summary).toContain('post-operation scope violation: outside.tmp');
    expect(result.workspaceRetained).toBe(false);
    expect(result.workspacePath).toBeUndefined();
    expect(result.changedPaths).toEqual([]);
    expect(await git(repository.root, ['branch', '--list', branch])).toBe('');
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
    await expect(readFile(join(repository.root, 'outside.tmp'), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('rolls back when a test changes content inside the approved path scope', async () => {
    const repository = await createRepository();
    const branch = 'ks-leslie/test-approved-content-integrity';
    const patch = patchValue('beta');
    const approvals = new WriteApprovalStore();
    const grant = approvals.issue({
      projectId: 'synthetic',
      repositoryRoot: repository.root,
      baselineSha: repository.head,
      branch,
      allowedPaths: ['script.js'],
      patchId: 'approved-beta-only',
      patch,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const mutatingProfile: TestProfile = {
      id: 'same-scope-mutation',
      purpose: 'Attempt to alter an approved file after patch application.',
      source: 'test fixture',
      availability: 'available',
      steps: [
        {
          executable: 'node',
          args: ['-e', "require('node:fs').writeFileSync('script.js','gamma\\n')"],
          workingDirectory: '.',
          timeoutMs: 10_000,
        },
      ],
    };

    const result = await executeLocalWorkerJob(
      {
        jobId: 'same-scope-integrity',
        mode: 'controlled_write',
        scope: {
          projectId: 'synthetic',
          repositoryRoot: repository.root,
          allowedPaths: ['script.js'],
          baselineRef: repository.head,
          branch,
        },
        approvalToken: grant.token,
        actions: [
          {
            kind: 'apply_patch',
            patchId: 'approved-beta-only',
            expectedBaseSha: repository.head,
          },
          { kind: 'run_test_profile', profileId: mutatingProfile.id },
          { kind: 'finalize_candidate' },
        ],
      },
      {
        approvalStore: approvals,
        testProfiles: [mutatingProfile],
        workspaceBaseDir: repository.workspaces,
      },
    );

    expect(result.actions.map((action) => action.status)).toEqual(['passed', 'error']);
    expect(result.actions[1]?.summary).toContain('changed approved candidate content');
    expect(result.workspaceRetained).toBe(false);
    expect(result.workspacePath).toBeUndefined();
    expect(result.changedPaths).toEqual([]);
    expect(await git(repository.root, ['branch', '--list', branch])).toBe('');
    expect(await readFile(join(repository.root, 'script.js'), 'utf8')).toBe('alpha\n');
  }, 30_000);
});
