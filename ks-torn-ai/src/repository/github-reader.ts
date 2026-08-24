import { z } from 'zod';

import type { GitCommitObservation } from './evidence-adapters.js';
import type { RepositoryBackend } from './reader.js';
import {
  MAX_COMPARE_FILES,
  MAX_GITHUB_RESPONSE_BYTES,
  MAX_HISTORY_COMMITS,
  MAX_REPOSITORY_FILE_BYTES,
  normalizeCommitObservation,
  normalizeRepositoryPath,
  validateGitHubRepository,
  validateHistoryLimit,
  validateRepositoryRef,
} from './validation.js';

export interface GitHubFileObservation {
  path: string;
  sha: string;
  content: string;
}

export interface GitHubCompareFile {
  filename: string;
  previousFilename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
}

export interface GitHubCompareObservation {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: readonly GitHubCompareFile[];
}

export interface GitHubRepositoryReaderOptions {
  repository: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

const GITHUB_API_ORIGIN = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BASE64_CHARS = Math.ceil((MAX_REPOSITORY_FILE_BYTES * 4) / 3) + 8;

const contentsResponseSchema = z.object({
  type: z.string().max(32),
  path: z.string().min(1).max(1_024),
  sha: z.string().min(1).max(128),
  encoding: z.string().max(32).optional(),
  content: z.string().max(MAX_BASE64_CHARS).optional(),
});

const resolvedCommitResponseSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
});

const commitResponseSchema = z
  .array(
    z.object({
      sha: z.string().min(1).max(128),
      commit: z.object({
        message: z.string().max(100_000),
        committer: z
          .object({ date: z.string().max(64).nullable().optional() })
          .nullable()
          .optional(),
        author: z
          .object({ date: z.string().max(64).nullable().optional() })
          .nullable()
          .optional(),
      }),
    }),
  )
  .max(MAX_HISTORY_COMMITS);

const compareResponseSchema = z.object({
  status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  total_commits: z.number().int().nonnegative(),
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(1_024),
        previous_filename: z.string().min(1).max(1_024).optional(),
        status: z.enum([
          'added',
          'removed',
          'modified',
          'renamed',
          'copied',
          'changed',
          'unchanged',
        ]),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        changes: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_COMPARE_FILES)
    .optional(),
});

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > MAX_REPOSITORY_FILE_BYTES) {
    throw new Error('GitHub file exceeds repository read limit');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodePath(value: string): string {
  const normalized = normalizeRepositoryPath(value);
  if (normalized === null) {
    throw new Error(`Invalid repository path: ${value}`);
  }
  return normalized.split('/').map(encodeURIComponent).join('/');
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_GITHUB_RESPONSE_BYTES) {
      throw new Error('GitHub response exceeds repository read limit');
    }
    return raw;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    byteLength += value.byteLength;
    if (byteLength > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('GitHub response exceeds repository read limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('GitHub returned invalid UTF-8');
  }
}

export class GitHubRepositoryReader {
  readonly #repository: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRepositoryReaderOptions) {
    validateGitHubRepository(options.repository);
    this.#repository = options.repository;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  describeBackend(): Promise<RepositoryBackend> {
    return Promise.resolve('github');
  }

  async #requestJson(path: string): Promise<unknown> {
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN) {
      throw new Error('GitHub read attempted to use an untrusted host');
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KS-Leslie',
    };
    if (this.#token !== undefined) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    const response = await this.#fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub read failed with HTTP ${String(response.status)}`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_RESPONSE_BYTES) {
      throw new Error('GitHub response exceeds repository read limit');
    }
    const raw = await readBoundedResponse(response);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error('GitHub returned invalid JSON');
    }
  }

  async resolveRef(ref: string): Promise<string> {
    validateRepositoryRef(ref);
    const encodedRef = encodeURIComponent(ref);
    const data = resolvedCommitResponseSchema.parse(
      await this.#requestJson(`/repos/${this.#repository}/commits/${encodedRef}`),
    );
    return data.sha.toLowerCase();
  }

  async readFile(path: string, ref: string): Promise<GitHubFileObservation> {
    const encodedPath = encodePath(path);
    validateRepositoryRef(ref);
    const query = new URLSearchParams({ ref }).toString();
    const data = contentsResponseSchema.parse(
      await this.#requestJson(`/repos/${this.#repository}/contents/${encodedPath}?${query}`),
    );
    if (
      data.type !== 'file' ||
      data.path !== path ||
      data.encoding !== 'base64' ||
      data.content === undefined
    ) {
      throw new Error(`GitHub path is not the requested base64 file: ${path}`);
    }
    return {
      path: data.path,
      sha: data.sha,
      content: decodeBase64Utf8(data.content),
    };
  }

  async listCommits(options: {
    ref: string;
    path?: string;
    limit?: number;
  }): Promise<readonly GitCommitObservation[]> {
    validateRepositoryRef(options.ref);
    const limit = options.limit ?? 20;
    validateHistoryLimit(limit);
    const query = new URLSearchParams({ sha: options.ref, per_page: String(limit) });
    if (options.path !== undefined) {
      const normalized = normalizeRepositoryPath(options.path);
      if (normalized === null) {
        throw new Error(`Invalid repository path: ${options.path}`);
      }
      query.set('path', normalized);
    }
    const data = commitResponseSchema.parse(
      await this.#requestJson(`/repos/${this.#repository}/commits?${query.toString()}`),
    );

    return data.map((record) => {
      const committedAt = record.commit.committer?.date ?? record.commit.author?.date ?? null;
      if (committedAt === null) {
        throw new Error(`GitHub commit has no timestamp: ${record.sha}`);
      }
      return normalizeCommitObservation({
        sha: record.sha,
        message: record.commit.message,
        committedAt,
      });
    });
  }

  async compareRefs(baseRef: string, headRef: string): Promise<GitHubCompareObservation> {
    validateRepositoryRef(baseRef);
    validateRepositoryRef(headRef);
    const base = encodeURIComponent(baseRef);
    const head = encodeURIComponent(headRef);
    const data = compareResponseSchema.parse(
      await this.#requestJson(`/repos/${this.#repository}/compare/${base}...${head}`),
    );
    return {
      status: data.status,
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      totalCommits: data.total_commits,
      files: (data.files ?? []).map((file) => ({
        filename: file.filename,
        ...(file.previous_filename === undefined
          ? {}
          : { previousFilename: file.previous_filename }),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    };
  }
}
