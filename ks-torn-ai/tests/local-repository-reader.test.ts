import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfiguredRepositoryReader } from '../src/repository/factory.js';
import { LocalGitRepositoryReader } from '../src/repository/local-reader.js';
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

async function createRepository(): Promise<{
  root: string;
  base: string;
  head: string;
  dirtyContent: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ks-leslie-repository-reader-test-'));
  cleanupPaths.push(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'ks-leslie-test@example.invalid']);
  await git(root, ['config', 'user.name', 'KS Leslie Test']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, [
    'remote',
    'add',
    'origin',
    'https://github.com/Hjunez/Kingshade-Torn-Suite.git',
  ]);

  const originalPath = join(root, 'KS_Torn_War_Dibs.user.js');
  await writeFile(originalPath, 'baseline\nshared-a\nshared-b\nshared-c\n', 'utf8');
  await git(root, ['add', 'KS_Torn_War_Dibs.user.js']);
  await git(root, ['commit', '-m', 'Release War Dibs v1.0.0']);
  const base = await git(root, ['rev-parse', 'HEAD']);

  await git(root, ['switch', '-c', 'feature/rename']);
  await git(root, ['mv', 'KS_Torn_War_Dibs.user.js', 'War_Dibs_Renamed.user.js']);
  await writeFile(
    join(root, 'War_Dibs_Renamed.user.js'),
    'renamed\nshared-a\nshared-b\nshared-c\n',
    'utf8',
  );
  await git(root, ['add', 'War_Dibs_Renamed.user.js']);
  await git(root, ['commit', '-m', 'Rename fixture', '-m', 'Release body marker v9.9.9']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  const dirtyContent = 'uncommitted owner work\n';
  await writeFile(join(root, 'War_Dibs_Renamed.user.js'), dirtyContent, 'utf8');

  return { root, base, head, dirtyContent };
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

describe('LocalGitRepositoryReader', () => {
  it('reads exact refs and structured history without touching dirty owner work', async () => {
    const repository = await createRepository();
    const reader = new LocalGitRepositoryReader({
      repositoryRoot: repository.root,
      expectedGitHubRepository: 'Hjunez/Kingshade-Torn-Suite',
    });

    const file = await reader.readFile('KS_Torn_War_Dibs.user.js', repository.base);
    const history = await reader.listCommits({
      ref: repository.base,
      path: 'KS_Torn_War_Dibs.user.js',
      limit: 10,
    });

    expect(file.content).toBe('baseline\nshared-a\nshared-b\nshared-c\n');
    expect(await reader.resolveRef(repository.base)).toBe(repository.base);
    expect(await reader.describeBackend()).toBe('local');
    expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(history[0]?.message).toBe('Release War Dibs v1.0.0');
    expect(await readFile(join(repository.root, 'War_Dibs_Renamed.user.js'), 'utf8')).toBe(
      repository.dirtyContent,
    );
  }, 20_000);

  it('uses full commit messages consistently with the GitHub history backend', async () => {
    const repository = await createRepository();
    const reader = new LocalGitRepositoryReader({
      repositoryRoot: repository.root,
      expectedGitHubRepository: 'Hjunez/Kingshade-Torn-Suite',
    });

    const history = await reader.listCommits({
      ref: repository.head,
      path: 'War_Dibs_Renamed.user.js',
      limit: 1,
    });

    expect(history[0]?.message).toContain('Rename fixture');
    expect(history[0]?.message).toContain('Release body marker v9.9.9');
  }, 20_000);

  it('reports a primary-file rename using old and new paths', async () => {
    const repository = await createRepository();
    const reader = new LocalGitRepositoryReader({
      repositoryRoot: repository.root,
      expectedGitHubRepository: 'Hjunez/Kingshade-Torn-Suite',
    });

    const comparison = await reader.compareRefs(repository.base, repository.head);

    expect(comparison.status).toBe('ahead');
    expect(comparison.files).toEqual([
      expect.objectContaining({
        filename: 'War_Dibs_Renamed.user.js',
        previousFilename: 'KS_Torn_War_Dibs.user.js',
        status: 'renamed',
      }),
    ]);
  }, 20_000);

  it('disables configured external diff helpers during comparisons', async () => {
    const repository = await createRepository();
    const marker = join(repository.root, 'external-diff-ran');
    await writeFile(
      join(repository.root, 'external-diff.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      'utf8',
    );
    await git(repository.root, ['config', 'diff.external', 'node external-diff.mjs']);
    const reader = new LocalGitRepositoryReader({
      repositoryRoot: repository.root,
      expectedGitHubRepository: 'Hjunez/Kingshade-Torn-Suite',
    });

    await reader.compareRefs(repository.base, repository.head);

    await expect(access(marker)).rejects.toThrow();
  }, 20_000);

  it('rejects an untrusted local origin', async () => {
    const repository = await createRepository();
    const reader = new LocalGitRepositoryReader({
      repositoryRoot: repository.root,
      expectedGitHubRepository: 'Other/Repository',
    });

    await expect(reader.verify()).rejects.toThrow('origin does not match');
  }, 20_000);

  it('falls back to fixed-host GitHub reads when the configured local root is unavailable', async () => {
    const holder = await mkdtemp(join(tmpdir(), 'ks-leslie-repository-fallback-test-'));
    cleanupPaths.push(holder);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'file',
            path: 'KS_Torn_War_Dibs.user.js',
            sha: 'remote-blob',
            encoding: 'base64',
            content: btoa('remote\n'),
          }),
          { status: 200 },
        ),
      ),
    );
    const reader = createConfiguredRepositoryReader({
      repository: 'Hjunez/Kingshade-Torn-Suite',
      localRepositoryRoot: join(holder, 'missing'),
      fetchImpl,
    });

    await expect(reader.readFile('KS_Torn_War_Dibs.user.js', 'main')).resolves.toMatchObject({
      sha: 'remote-blob',
      content: 'remote\n',
    });
    await expect(reader.describeBackend?.()).resolves.toBe('github_fallback');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
