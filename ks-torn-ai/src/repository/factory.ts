import { GitHubRepositoryReader } from './github-reader.js';
import { LocalGitRepositoryReader } from './local-reader.js';
import type { RepositoryBackend, RepositoryReader } from './reader.js';

export interface ConfiguredRepositoryReaderOptions {
  repository: string;
  token?: string;
  localRepositoryRoot?: string;
  fetchImpl?: typeof fetch;
}

class LocalFirstRepositoryReader implements RepositoryReader {
  readonly #local: LocalGitRepositoryReader;
  readonly #fallback: RepositoryReader;
  #selectedPromise: Promise<RepositoryReader> | undefined;

  constructor(local: LocalGitRepositoryReader, fallback: RepositoryReader) {
    this.#local = local;
    this.#fallback = fallback;
  }

  async #select(): Promise<RepositoryReader> {
    this.#selectedPromise ??= this.#local
      .verify()
      .then(() => this.#local)
      .catch(() => this.#fallback);
    return await this.#selectedPromise;
  }

  async describeBackend(): Promise<RepositoryBackend> {
    return (await this.#select()) === this.#local ? 'local' : 'github_fallback';
  }

  async readFile(path: string, ref: string) {
    return await (await this.#select()).readFile(path, ref);
  }

  async resolveRef(ref: string) {
    return await (await this.#select()).resolveRef(ref);
  }

  async listCommits(options: { ref: string; path?: string; limit?: number }) {
    return await (await this.#select()).listCommits(options);
  }

  async compareRefs(baseRef: string, headRef: string) {
    return await (await this.#select()).compareRefs(baseRef, headRef);
  }
}

export function createConfiguredRepositoryReader(
  options: ConfiguredRepositoryReaderOptions,
): RepositoryReader {
  const github = new GitHubRepositoryReader({
    repository: options.repository,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (options.localRepositoryRoot === undefined) {
    return github;
  }

  const local = new LocalGitRepositoryReader({
    repositoryRoot: options.localRepositoryRoot,
    expectedGitHubRepository: options.repository,
  });
  return new LocalFirstRepositoryReader(local, github);
}
