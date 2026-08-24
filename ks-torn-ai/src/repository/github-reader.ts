import type { GitCommitObservation } from './evidence-adapters.js';

export interface GitHubFileObservation {
  path: string;
  sha: string;
  content: string;
}

export interface GitHubCompareFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface GitHubCompareObservation {
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  files: readonly GitHubCompareFile[];
}

export interface GitHubRepositoryReaderOptions {
  repository: string;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface GitHubContentsResponse {
  type: string;
  path: string;
  sha: string;
  encoding?: string;
  content?: string;
}

interface GitHubCommitResponse {
  sha: string;
  commit: {
    message: string;
    committer?: { date?: string | null } | null;
    author?: { date?: string | null } | null;
  };
}

interface GitHubCompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

function validateRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GitHub repository must be in owner/name form');
  }
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodePath(value: string): string {
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Invalid repository path: ${value}`);
  }
  return parts.map(encodeURIComponent).join('/');
}

export class GitHubRepositoryReader {
  readonly #repository: string;
  readonly #token: string | undefined;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRepositoryReaderOptions) {
    validateRepository(options.repository);
    this.#repository = options.repository;
    this.#token = options.token;
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #requestJson<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'KS-Leslie',
    };
    if (this.#token !== undefined) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, { headers });
    if (!response.ok) {
      throw new Error(`GitHub read failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async readFile(path: string, ref: string): Promise<GitHubFileObservation> {
    const encodedPath = encodePath(path);
    const query = new URLSearchParams({ ref }).toString();
    const data = await this.#requestJson<GitHubContentsResponse>(
      `/repos/${this.#repository}/contents/${encodedPath}?${query}`,
    );
    if (data.type !== 'file' || data.encoding !== 'base64' || data.content === undefined) {
      throw new Error(`GitHub path is not a base64 file: ${path}`);
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
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const query = new URLSearchParams({ sha: options.ref, per_page: String(limit) });
    if (options.path !== undefined) {
      query.set('path', options.path);
    }
    const data = await this.#requestJson<GitHubCommitResponse[]>(
      `/repos/${this.#repository}/commits?${query.toString()}`,
    );

    return data.map((record) => {
      const committedAt = record.commit.committer?.date ?? record.commit.author?.date ?? null;
      if (committedAt === null) {
        throw new Error(`GitHub commit has no timestamp: ${record.sha}`);
      }
      return {
        sha: record.sha,
        message: record.commit.message,
        committedAt,
      };
    });
  }

  async compareRefs(baseRef: string, headRef: string): Promise<GitHubCompareObservation> {
    const base = encodeURIComponent(baseRef);
    const head = encodeURIComponent(headRef);
    const data = await this.#requestJson<GitHubCompareResponse>(
      `/repos/${this.#repository}/compare/${base}...${head}`,
    );
    return {
      status: data.status,
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      totalCommits: data.total_commits,
      files: (data.files ?? []).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    };
  }
}
