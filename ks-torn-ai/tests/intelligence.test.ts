import { describe, expect, it } from 'vitest';

import { RepositoryIntelligenceService } from '../src/repository/intelligence.js';
import type { RepositoryReader } from '../src/repository/reader.js';

const source = `// ==UserScript==\n// @name KS Torn War Dibs\n// @version 1.5.138\n// ==/UserScript==\nline5\nline6`;
const RESOLVED_MAIN = 'a'.repeat(40);
const RESOLVED_FEATURE = 'b'.repeat(40);

const reader: RepositoryReader = {
  resolveRef(ref) {
    return Promise.resolve(ref === 'main' ? RESOLVED_MAIN : RESOLVED_FEATURE);
  },
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
    expect(inspection.resolvedRef).toBe(RESOLVED_MAIN);
    expect(inspection.userscript.metadata.version).toBe('1.5.138');
    expect(inspection.releaseEvidence[0]?.state).toBe('candidate');
    expect(inspection.baselineDecision.baseline).toBeNull();
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
    ).resolves.toMatchObject({
      ref: 'main',
      filePath: 'KS_Torn_War_Dibs.user.js',
      resolvedRef: RESOLVED_MAIN,
      fileSha: `blob-${RESOLVED_MAIN}`,
      startLine: 5,
      endLine: 6,
      source: 'line5\nline6',
    });
  });

  it('rejects invalid refs, history limits and source chunks with oversized lines', async () => {
    const service = new RepositoryIntelligenceService(reader);

    await expect(service.getProjectHistory('Dibs', '../main', 10)).rejects.toThrow(
      'Invalid repository ref',
    );
    await expect(service.getProjectHistory('Dibs', 'main', 51)).rejects.toThrow('History limit');

    const oversizedReader: RepositoryReader = {
      ...reader,
      readFile(path) {
        return Promise.resolve({ path, sha: 'large-blob', content: 'x'.repeat(120_001) });
      },
    };
    const oversizedService = new RepositoryIntelligenceService(oversizedReader);
    await expect(
      oversizedService.readSourceChunk({ project: 'Dibs', startLine: 1, endLine: 1 }),
    ).rejects.toThrow('bounded output size');

    const expansionReader: RepositoryReader = {
      ...reader,
      readFile(path) {
        return Promise.resolve({
          path,
          sha: 'expanded-blob',
          content: Array.from({ length: 5_000 }, () => 'sk-abcdefghijklmnopqrst').join(' '),
        });
      },
    };
    await expect(
      new RepositoryIntelligenceService(expansionReader).readSourceChunk({
        project: 'Dibs',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow('Redacted source chunk exceeds');
  });

  it('keeps a renamed primary file in project-relevant comparison output', async () => {
    const renameReader: RepositoryReader = {
      ...reader,
      compareRefs() {
        return Promise.resolve({
          status: 'ahead',
          aheadBy: 1,
          behindBy: 0,
          totalCommits: 1,
          files: [
            {
              filename: 'renamed.user.js',
              previousFilename: 'KS_Torn_War_Dibs.user.js',
              status: 'renamed',
              additions: 1,
              deletions: 1,
              changes: 2,
            },
          ],
        });
      },
    };
    const service = new RepositoryIntelligenceService(renameReader);

    const comparison = await service.compareProjectRefs('Dibs', 'main', 'feature/rename');

    expect(comparison.relevantFiles[0]?.previousFilename).toBe('KS_Torn_War_Dibs.user.js');
  });

  it('resolves mutable refs once and uses only immutable commits for evidence reads', async () => {
    const observedRefs: string[] = [];
    const exactReader: RepositoryReader = {
      ...reader,
      resolveRef() {
        return Promise.resolve(RESOLVED_MAIN);
      },
      readFile(path, ref) {
        observedRefs.push(ref);
        return Promise.resolve({ path, sha: 'blob', content: source });
      },
      listCommits({ ref }) {
        observedRefs.push(ref);
        return Promise.resolve([]);
      },
    };

    const inspection = await new RepositoryIntelligenceService(exactReader).inspectProject('Dibs');

    expect(inspection.ref).toBe('main');
    expect(inspection.resolvedRef).toBe(RESOLVED_MAIN);
    expect(observedRefs).toEqual([RESOLVED_MAIN, RESOLVED_MAIN]);
  });
});
