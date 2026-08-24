import { describe, expect, it, vi } from 'vitest';

import { GitHubRepositoryReader } from '../src/repository/github-reader.js';

describe('GitHubRepositoryReader', () => {
  it('reads files, commit history and comparisons through read-only endpoints', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/contents/')) {
        return new Response(
          JSON.stringify({
            type: 'file',
            path: 'KS_Torn_War_Dibs.user.js',
            sha: 'blob',
            encoding: 'base64',
            content: btoa('hello'),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/commits?')) {
        return new Response(
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
        );
      }
      return new Response(
        JSON.stringify({
          status: 'ahead',
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          files: [
            {
              filename: 'KS_Torn_War_Dibs.user.js',
              status: 'modified',
              additions: 2,
              deletions: 1,
              changes: 3,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const reader = new GitHubRepositoryReader({
      repository: 'Hjunez/Kingshade-Torn-Suite',
      token: 'secret',
      fetchImpl,
    });

    expect((await reader.readFile('KS_Torn_War_Dibs.user.js', 'main')).content).toBe('hello');
    expect((await reader.listCommits({ ref: 'main' }))[0]?.sha).toBe('c1');
    expect((await reader.compareRefs('main', 'feature/x')).files[0]?.changes).toBe(3);

    const firstInit = fetchImpl.mock.calls[0]?.[1];
    expect((firstInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('rejects repository strings that could redirect reads to another host', () => {
    expect(
      () =>
        new GitHubRepositoryReader({
          repository: 'https://evil.example/repo',
          fetchImpl: vi.fn<typeof fetch>(),
        }),
    ).toThrow('owner/name');
  });
});
