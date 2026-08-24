import { RunContext, type Tool } from '@openai/agents';
import { describe, expect, it } from 'vitest';

import { RepositoryIntelligenceService } from '../src/repository/intelligence.js';
import type { RepositoryReader } from '../src/repository/reader.js';
import { createRepositoryTools, REPOSITORY_TOOL_NAMES } from '../src/repository/tools.js';

const source = `// ==UserScript==\n// @name KS Torn War Dibs\n// @version 1.5.138\n// ==/UserScript==\nline5\nline6`;
const RESOLVED_MAIN = 'a'.repeat(40);
const RESOLVED_FEATURE = 'b'.repeat(40);
const REPOSITORY_SECRET = 'sk-proj-abcdefghijklmnopqrstuv';

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
        sha: 'release-commit',
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
          filename: 'renamed.user.js',
          previousFilename: 'KS_Torn_War_Dibs.user.js',
          status: 'renamed',
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

function requireFunctionTool(tools: readonly Tool[], name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (selected?.type !== 'function') {
    throw new Error(`Missing function tool: ${name}`);
  }
  return selected;
}

describe('repository intelligence agent tools', () => {
  it('exposes only the six explicit read-only repository operations', () => {
    const tools = createRepositoryTools(new RepositoryIntelligenceService(reader));

    expect(tools.map((repositoryTool) => repositoryTool.name)).toEqual(REPOSITORY_TOOL_NAMES);
    for (const repositoryTool of tools) {
      expect(repositoryTool.type).toBe('function');
      if (repositoryTool.type !== 'function') {
        throw new Error(`Unexpected repository tool type: ${repositoryTool.type}`);
      }
      expect(repositoryTool.name).not.toMatch(/write|patch|shell|command/i);
      expect(JSON.stringify(repositoryTool.parameters)).not.toMatch(
        /"(?:repository|path|url|token|command|executable)":/i,
      );
    }
  });

  it('resolves aliases and inspects current userscript metadata with provenance', async () => {
    const tools = createRepositoryTools(new RepositoryIntelligenceService(reader));
    const context = new RunContext();
    const resolved: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[0]).invoke(
      context,
      JSON.stringify({ project: 'Dibs' }),
    );
    const inspected: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[1]).invoke(
      context,
      JSON.stringify({ project: 'War Dibs', ref: 'main', historyLimit: 10 }),
    );

    expect(resolved).toMatchObject({
      dataClassification: 'untrusted_repository_evidence',
      project: { id: 'war-dibs' },
    });
    expect(inspected).toMatchObject({
      backend: 'injected',
      ref: 'main',
      resolvedRef: RESOLVED_MAIN,
      filePath: 'KS_Torn_War_Dibs.user.js',
      fileSha: `blob-${RESOLVED_MAIN}`,
      metadata: { version: '1.5.138' },
    });
  });

  it('returns bounded source, history, comparison and supporting-only baseline evidence', async () => {
    const tools = createRepositoryTools(new RepositoryIntelligenceService(reader));
    const context = new RunContext();
    const sourceChunk: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[2]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', startLine: 5, endLine: 6 }),
    );
    const history: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[3]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', historyLimit: 10 }),
    );
    const comparison: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[4]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', baseRef: 'main', headRef: 'feature/rename' }),
    );
    const baseline: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[5]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', historyLimit: 10 }),
    );

    expect(sourceChunk).toMatchObject({
      backend: 'injected',
      resolvedRef: RESOLVED_MAIN,
      startLine: 5,
      endLine: 6,
      source: 'line5\nline6',
    });
    expect(history).toMatchObject({
      backend: 'injected',
      resolvedRef: RESOLVED_MAIN,
      knownGoodCommitSha: null,
      baselineReason: 'no_verified_good_evidence',
      releaseEvidence: [{ state: 'candidate', source: 'release_record' }],
    });
    expect(comparison).toMatchObject({
      backend: 'injected',
      resolvedBaseSha: RESOLVED_MAIN,
      resolvedHeadSha: RESOLVED_FEATURE,
      relevantFiles: [
        {
          filename: 'renamed.user.js',
          previousFilename: 'KS_Torn_War_Dibs.user.js',
        },
      ],
    });
    expect(baseline).toMatchObject({
      backend: 'injected',
      resolvedRef: RESOLVED_MAIN,
      knownGoodCommitSha: null,
      requiresOwnerVerification: true,
      automatedEvidenceIsSupportingOnly: true,
    });
  });

  it('redacts repository secrets before returning source to an agent', async () => {
    const secretReader: RepositoryReader = {
      ...reader,
      readFile(path, ref) {
        return Promise.resolve({
          path,
          sha: `blob-${ref}`,
          content: `// ==UserScript==\nconst token = "${REPOSITORY_SECRET}";\n`,
        });
      },
    };
    const tools = createRepositoryTools(new RepositoryIntelligenceService(secretReader));
    const context = new RunContext();

    const result: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[2]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', startLine: 2, endLine: 2 }),
    );

    expect(result).toMatchObject({
      source: 'const token = "[REDACTED REPOSITORY SECRET]";',
      secretRedactions: 1,
    });
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('redacts metadata, history, rename paths, and repository-derived errors', async () => {
    const secretReader: RepositoryReader = {
      ...reader,
      readFile(path, ref) {
        return Promise.resolve({
          path,
          sha: `blob-${ref}`,
          content: `// ==UserScript==\n// @name ${REPOSITORY_SECRET}\n// ==/UserScript==\n`,
        });
      },
      listCommits() {
        return Promise.resolve([
          {
            sha: 'commit',
            message: `Release v1.0.0 credential ${REPOSITORY_SECRET}`,
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
              filename: `${REPOSITORY_SECRET}.user.js`,
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
    const tools = createRepositoryTools(new RepositoryIntelligenceService(secretReader));
    const context = new RunContext();
    const inspected: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[1]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', historyLimit: 10 }),
    );
    const history: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[3]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', ref: 'main', historyLimit: 10 }),
    );
    const comparison: unknown = await requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[4]).invoke(
      context,
      JSON.stringify({ project: 'Dibs', baseRef: 'main', headRef: 'feature/secret' }),
    );

    const output = JSON.stringify({ inspected, history, comparison });
    expect(output).not.toContain(REPOSITORY_SECRET);
    expect(output).toContain('[REDACTED REPOSITORY SECRET]');
    expect(comparison).toMatchObject({ secretRedactions: 1 });

    const failingReader: RepositoryReader = {
      ...secretReader,
      readFile() {
        return Promise.reject(new Error(`remote rejected ${REPOSITORY_SECRET}`));
      },
    };
    const failingTools = createRepositoryTools(new RepositoryIntelligenceService(failingReader));
    let failureMessage = '';
    try {
      await requireFunctionTool(failingTools, REPOSITORY_TOOL_NAMES[2]).invoke(
        context,
        JSON.stringify({ project: 'Dibs', ref: 'main', startLine: 1, endLine: 1 }),
      );
    } catch (error: unknown) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    expect(failureMessage).toContain('[REDACTED REPOSITORY SECRET]');
    expect(failureMessage).not.toContain(REPOSITORY_SECRET);
  });

  it('schema-rejects oversized ranges, invalid refs and model-selected repository surfaces', async () => {
    const tools = createRepositoryTools(new RepositoryIntelligenceService(reader));
    const context = new RunContext();
    const sourceTool = requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[2]);
    const baselineTool = requireFunctionTool(tools, REPOSITORY_TOOL_NAMES[5]);

    await expect(
      sourceTool.invoke(
        context,
        JSON.stringify({ project: 'Dibs', ref: 'main', startLine: 1, endLine: 401 }),
      ),
    ).rejects.toThrow('Invalid JSON input for tool');
    await expect(
      sourceTool.invoke(
        context,
        JSON.stringify({ project: 'Dibs', ref: '../main', startLine: 1, endLine: 2 }),
      ),
    ).rejects.toThrow('Invalid JSON input for tool');
    await expect(
      baselineTool.invoke(
        context,
        JSON.stringify({
          project: 'Dibs',
          ref: 'main',
          historyLimit: 10,
          repository: 'other/private-repo',
          ownerVerification: true,
        }),
      ),
    ).rejects.toThrow('Invalid JSON input for tool');
  });
});
