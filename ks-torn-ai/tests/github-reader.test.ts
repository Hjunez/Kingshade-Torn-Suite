import { describe, expect, it, vi } from 'vitest';

import { GitHubRepositoryReader } from '../src/repository/github-reader.js';
import { MAX_GITHUB_RESPONSE_BYTES } from '../src/repository/validation.js';

const RESOLVED_MAIN = 'a'.repeat(40);

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe('GitHubRepositoryReader', () => {
  it('reads files, commit history and comparisons through read-only endpoints', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = inputUrl(input);
      if (url.includes('/contents/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'file',
              path: 'KS_Torn_War_Dibs.user.js',
              sha: 'blob',
              encoding: 'base64',
              content: btoa('hello'),
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes('/commits?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                sha: 'c1',
                commit: {
                  message: 'Release v1.2.3',
                  committer: { date: '2026-08-24T00:00:00Z' },
                },
              },
            ]),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/commits/main')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: RESOLVED_MAIN }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'ahead',
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            files: [
              {
                filename: 'KS_Torn_War_Dibs_Renamed.user.js',
                previous_filename: 'KS_Torn_War_Dibs.user.js',
                status: 'renamed',
                additions: 2,
                deletions: 1,
                changes: 3,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });

    const reader = new GitHubRepositoryReader({
      repository: 'Hjunez/Kingshade-Torn-Suite',
      token: 'secret',
      fetchImpl,
    });

    expect((await reader.readFile('KS_Torn_War_Dibs.user.js', 'main')).content).toBe('hello');
    expect(await reader.resolveRef('main')).toBe(RESOLVED_MAIN);
    expect((await reader.listCommits({ ref: 'main' }))[0]?.sha).toBe('c1');
    expect((await reader.compareRefs('main', 'feature/x')).files[0]?.changes).toBe(3);
    expect((await reader.compareRefs('main', 'feature/x')).files[0]?.previousFilename).toBe(
      'KS_Torn_War_Dibs.user.js',
    );

    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('Expected a GitHub API request');
    }
    const firstInit = firstCall[1];
    expect((firstInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(firstInit?.method).toBe('GET');
    expect(inputUrl(firstCall[0])).toMatch(/^https:\/\/api\.github\.com\//);
  });

  it('rejects repository strings that could redirect reads to another host', () => {
    expect(
      () =>
        new GitHubRepositoryReader({
          repository: 'https://evil.example/repo',
          fetchImpl: vi.fn<typeof fetch>(),
        }),
    ).toThrow('safe owner/name');
    expect(
      () =>
        new GitHubRepositoryReader({
          repository: '../repo',
          fetchImpl: vi.fn<typeof fetch>(),
        }),
    ).toThrow('safe owner/name');
    expect(
      () =>
        new GitHubRepositoryReader({
          repository: 'owner/..',
          fetchImpl: vi.fn<typeof fetch>(),
        }),
    ).toThrow('safe owner/name');
  });

  it('rejects malformed remote payloads and invalid refs before returning evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ type: 'file' }), { status: 200 })),
    );
    const reader = new GitHubRepositoryReader({
      repository: 'Hjunez/Kingshade-Torn-Suite',
      fetchImpl,
    });

    await expect(reader.readFile('KS_Torn_War_Dibs.user.js', 'main')).rejects.toThrow();
    await expect(reader.readFile('KS_Torn_War_Dibs.user.js', '../main')).rejects.toThrow(
      'Invalid repository ref',
    );
    await expect(reader.listCommits({ ref: 'main', limit: 51 })).rejects.toThrow('History limit');
  });

  it('stops reading a streamed response once the byte limit is exceeded', async () => {
    const oversized = new Uint8Array(MAX_GITHUB_RESPONSE_BYTES + 1);
    const reader = new GitHubRepositoryReader({
      repository: 'Hjunez/Kingshade-Torn-Suite',
      fetchImpl: vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(oversized, { status: 200 })),
      ),
    });

    await expect(reader.resolveRef('main')).rejects.toThrow(
      'response exceeds repository read limit',
    );
  });
});
