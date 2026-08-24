import { describe, expect, it } from 'vitest';

import { RepositoryIntelligenceService } from '../src/repository/intelligence.js';
import type { RepositoryReader } from '../src/repository/reader.js';

const source = `// ==UserScript==\n// @name KS Torn War Dibs\n// @version 1.5.138\n// ==/UserScript==\nline5\nline6`;

const reader: RepositoryReader = {
  readFile(path, ref) {
    return Promise.resolve({ path, sha: `blob-${ref}`, content: source });
  },
  listCommits() {
    return Promise.resolve([
      {
        sha: 'c1',
        message: 'Release KS Torn War Dibs v1.5.138',
        committedAt: '2026-08-22T00:00:00Z',
      },
    ]);
  },
  compareRefs() {
    return Promise.resolve({
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      files: [
        {
          filename: 'KS_Torn_War_Dibs.user.js',
          status: 'modified',
          additions: 2,
          deletions: 1,
          changes: 3,
        },
        {
          filename: 'unrelated.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
        },
      ],
    });
  },
};

describe('RepositoryIntelligenceService', () => {
  it('resolves project aliases, inspects metadata and collects supporting release evidence', async () => {
    const service = new RepositoryIntelligenceService(reader);
    const inspection = await service.inspectProject('Dibs');

    expect(inspection.project.id).toBe('war-dibs');
    expect(inspection.userscript.metadata.version).toBe('1.5.138');
    expect(inspection.releaseEvidence[0]?.state).toBe('candidate');
  });

  it('filters a ref comparison to the selected project files', async () => {
    const service = new RepositoryIntelligenceService(reader);
    const comparison = await service.compareProjectRefs('Dibs', 'main', 'feature/x');

    expect(comparison.relevantFiles).toHaveLength(1);
    expect(comparison.relevantFiles[0]?.filename).toBe('KS_Torn_War_Dibs.user.js');
  });

  it('caps source reads so the model cannot request an entire large script accidentally', async () => {
    const service = new RepositoryIntelligenceService(reader);

    await expect(
      service.readSourceChunk({ project: 'Dibs', startLine: 1, endLine: 401 }),
    ).rejects.toThrow('at most 400 lines');
    await expect(
      service.readSourceChunk({ project: 'Dibs', startLine: 5, endLine: 6 }),
    ).resolves.toBe('line5\nline6');
  });
});
