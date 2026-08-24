import { realpath } from 'node:fs/promises';

import type { GitCommitObservation } from './evidence-adapters.js';
import type {
  GitHubCompareFile,
  GitHubCompareObservation,
  GitHubFileObservation,
} from './github-reader.js';
import type { RepositoryBackend, RepositoryReader } from './reader.js';
import {
  MAX_COMPARE_FILES,
  MAX_GITHUB_RESPONSE_BYTES,
  MAX_REPOSITORY_FILE_BYTES,
  normalizeCommitObservation,
  normalizeRepositoryPath,
  validateGitHubRepository,
  validateHistoryLimit,
  validateRepositoryRef,
} from './validation.js';
import { runProcess, type ProcessRunResult } from '../worker/process-runner.js';

export interface LocalGitRepositoryReaderOptions {
  repositoryRoot: string;
  expectedGitHubRepository: string;
}

interface FileStats {
  additions: number;
  deletions: number;
}

const GIT_TIMEOUT_MS = 30_000;

function normalizedFilesystemPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function git(
  root: string,
  args: readonly string[],
  maxOutputBytes = MAX_GITHUB_RESPONSE_BYTES,
): Promise<ProcessRunResult> {
  return await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes,
  });
}

function requireGitSuccess(result: ProcessRunResult, operation: string): string {
  if (result.timedOut) {
    throw new Error(`${operation} timed out`);
  }
  if (result.outputTruncated) {
    throw new Error(`${operation} exceeded the repository read limit`);
  }
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
    throw new Error(`${operation} failed: ${detail}`);
  }
  return result.stdout;
}

function remoteRepository(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/\/$/, '')
    .replace(/\.git$/i, '');
  let repository: string | null = null;

  const scpMatch = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(trimmed);
  if (scpMatch?.[1] !== undefined) {
    repository = scpMatch[1];
  } else {
    try {
      const url = new URL(trimmed);
      if (
        url.hostname.toLowerCase() !== 'github.com' ||
        (url.protocol !== 'https:' && url.protocol !== 'ssh:') ||
        url.port.length > 0 ||
        url.password.length > 0 ||
        (url.protocol === 'https:' && url.username.length > 0) ||
        (url.protocol === 'ssh:' && url.username !== 'git') ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return null;
      }
      repository = url.pathname.replace(/^\//, '');
    } catch {
      return null;
    }
  }

  return isRepositoryIdentifier(repository) ? repository : null;
}

function isRepositoryIdentifier(value: string): boolean {
  try {
    validateGitHubRepository(value);
    return true;
  } catch {
    return false;
  }
}

function validatedPath(value: string): string {
  const normalized = normalizeRepositoryPath(value);
  if (normalized === null) {
    throw new Error(`Invalid repository path: ${value}`);
  }
  return normalized;
}

function parseHistory(value: string): readonly GitCommitObservation[] {
  if (value.length === 0) {
    return [];
  }
  const fields = value.split('\0');
  const observations: GitCommitObservation[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]?.trim();
    const committedAt = fields[index + 1]?.trim();
    const message = fields[index + 2]?.trimEnd();
    if (
      sha === undefined ||
      committedAt === undefined ||
      message === undefined ||
      sha.length === 0
    ) {
      continue;
    }
    observations.push(normalizeCommitObservation({ sha, committedAt, message }));
  }
  return observations;
}

function parseCount(value: string): number {
  if (value === '-') {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Git diff returned invalid line counts');
  }
  return parsed;
}

function parseNumstat(value: string): ReadonlyMap<string, FileStats> {
  const stats = new Map<string, FileStats>();
  for (const record of value.split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const match = /^([^\t]+)\t([^\t]+)\t(.+)$/.exec(record);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new Error('Git diff returned invalid numstat output');
    }
    const path = validatedPath(match[3]);
    stats.set(path, { additions: parseCount(match[1]), deletions: parseCount(match[2]) });
  }
  return stats;
}

function gitStatus(value: string): GitHubCompareFile['status'] {
  switch (value[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'modified';
  }
}

function parseNameStatus(
  value: string,
  stats: ReadonlyMap<string, FileStats>,
): GitHubCompareFile[] {
  const tokens = value.split('\0');
  const files: GitHubCompareFile[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index++];
    if (statusToken === undefined || statusToken.length === 0) {
      continue;
    }
    const renamed = statusToken.startsWith('R') || statusToken.startsWith('C');
    const previousFilename = renamed ? validatedPath(tokens[index++] ?? '') : undefined;
    const filename = validatedPath(tokens[index++] ?? '');
    const currentStats = stats.get(filename) ?? { additions: 0, deletions: 0 };
    const previousStats = previousFilename === undefined ? undefined : stats.get(previousFilename);
    const additions = currentStats.additions;
    const deletions = previousStats?.deletions ?? currentStats.deletions;
    files.push({
      filename,
      ...(previousFilename === undefined ? {} : { previousFilename }),
      status: gitStatus(statusToken),
      additions,
      deletions,
      changes: additions + deletions,
    });
    if (files.length > MAX_COMPARE_FILES) {
      throw new Error('Git comparison exceeds the repository file limit');
    }
  }
  return files;
}

export class LocalGitRepositoryReader implements RepositoryReader {
  readonly #requestedRoot: string;
  readonly #expectedRepository: string;
  #verifiedRootPromise: Promise<string> | undefined;

  constructor(options: LocalGitRepositoryReaderOptions) {
    validateGitHubRepository(options.expectedGitHubRepository);
    this.#requestedRoot = options.repositoryRoot;
    this.#expectedRepository = options.expectedGitHubRepository;
  }

  async #verifyRoot(): Promise<string> {
    const requested = await realpath(this.#requestedRoot);
    const top = requireGitSuccess(
      await git(requested, ['rev-parse', '--show-toplevel']),
      'verify local repository root',
    ).trim();
    const canonicalTop = await realpath(top);
    if (normalizedFilesystemPath(requested) !== normalizedFilesystemPath(canonicalTop)) {
      throw new Error(`Local repository root must be the Git top-level directory: ${canonicalTop}`);
    }

    const origin = requireGitSuccess(
      await git(canonicalTop, ['remote', 'get-url', 'origin']),
      'verify local repository origin',
    ).trim();
    const actualRepository = remoteRepository(origin);
    if (
      actualRepository === null ||
      actualRepository.toLowerCase() !== this.#expectedRepository.toLowerCase()
    ) {
      throw new Error('Local repository origin does not match the configured GitHub repository');
    }
    return canonicalTop;
  }

  async #root(): Promise<string> {
    this.#verifiedRootPromise ??= this.#verifyRoot();
    return await this.#verifiedRootPromise;
  }

  async #resolveCommit(root: string, ref: string): Promise<string> {
    validateRepositoryRef(ref);
    const commit = requireGitSuccess(
      await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]),
      `resolve Git ref ${ref}`,
    ).trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`Git ref did not resolve to a full commit SHA: ${ref}`);
    }
    return commit;
  }

  async verify(): Promise<void> {
    await this.#root();
  }

  describeBackend(): Promise<RepositoryBackend> {
    return Promise.resolve('local');
  }

  async resolveRef(ref: string): Promise<string> {
    return await this.#resolveCommit(await this.#root(), ref);
  }

  async readFile(path: string, ref: string): Promise<GitHubFileObservation> {
    const root = await this.#root();
    const normalizedPath = validatedPath(path);
    const commit = await this.#resolveCommit(root, ref);
    const blob = requireGitSuccess(
      await git(root, ['rev-parse', '--verify', `${commit}:${normalizedPath}`]),
      `resolve repository file ${normalizedPath}`,
    ).trim();
    const content = requireGitSuccess(
      await git(root, ['show', `${commit}:${normalizedPath}`], MAX_REPOSITORY_FILE_BYTES),
      `read repository file ${normalizedPath}`,
    );
    return { path: normalizedPath, sha: blob, content };
  }

  async listCommits(options: {
    ref: string;
    path?: string;
    limit?: number;
  }): Promise<readonly GitCommitObservation[]> {
    const root = await this.#root();
    const limit = options.limit ?? 20;
    validateHistoryLimit(limit);
    const commit = await this.#resolveCommit(root, options.ref);
    const paths = options.path === undefined ? [] : [validatedPath(options.path)];
    const output = requireGitSuccess(
      await git(root, [
        'log',
        `--max-count=${String(limit)}`,
        '--format=%H%x00%cI%x00%B%x00',
        commit,
        '--',
        ...paths,
      ]),
      'read local Git history',
    );
    return parseHistory(output);
  }

  async compareRefs(baseRef: string, headRef: string): Promise<GitHubCompareObservation> {
    const root = await this.#root();
    const base = await this.#resolveCommit(root, baseRef);
    const head = await this.#resolveCommit(root, headRef);
    const [countsOutput, statusOutput, numstatOutput] = await Promise.all([
      git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`]),
      git(root, [
        'diff',
        '--name-status',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '-z',
        base,
        head,
        '--',
      ]),
      git(root, [
        'diff',
        '--numstat',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '-z',
        base,
        head,
        '--',
      ]),
    ]);
    const counts = requireGitSuccess(countsOutput, 'count local Git comparison')
      .trim()
      .split(/\s+/);
    const behindBy = Number(counts[0]);
    const aheadBy = Number(counts[1]);
    if (!Number.isSafeInteger(aheadBy) || !Number.isSafeInteger(behindBy)) {
      throw new Error('Git comparison returned invalid commit counts');
    }

    const stats = parseNumstat(requireGitSuccess(numstatOutput, 'read local Git numstat'));
    const files = parseNameStatus(
      requireGitSuccess(statusOutput, 'read local Git changed files'),
      stats,
    );
    const status =
      aheadBy === 0 && behindBy === 0
        ? 'identical'
        : behindBy === 0
          ? 'ahead'
          : aheadBy === 0
            ? 'behind'
            : 'diverged';
    return {
      status,
      aheadBy,
      behindBy,
      totalCommits: aheadBy + behindBy,
      files,
    };
  }
}
