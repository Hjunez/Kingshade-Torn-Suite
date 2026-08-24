import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConfiguredKsLeslieApplication } from '../src/application.js';
import type { KsLeslieConfig } from '../src/config.js';
import {
  MEMORY_PROPOSAL_TOOL_NAME,
  MEMORY_RETRIEVAL_TOOL_NAME,
} from '../src/memory/agent-tools.js';
import { REPOSITORY_TOOL_NAMES } from '../src/repository/tools.js';
import { runProcess } from '../src/worker/process-runner.js';
import { WORKER_AGENT_TOOL_NAMES } from '../src/worker/agent-tools.js';

const cleanupPaths: string[] = [];

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runProcess({ executable: 'git', args, cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Git fixture command failed');
  }
}

async function createRepository(
  origin = 'https://github.com/Hjunez/Kingshade-Torn-Suite.git',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ks-leslie-configured-worker-test-'));
  cleanupPaths.push(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'configured-worker@example.invalid']);
  await git(root, ['config', 'user.name', 'Configured Worker Test']);
  await git(root, ['remote', 'add', 'origin', origin]);
  await writeFile(join(root, 'fixture.txt'), 'fixture\n', 'utf8');
  await git(root, ['add', 'fixture.txt']);
  await git(root, ['commit', '-m', 'configured Worker fixture']);
  return root;
}

async function createStateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ks-leslie-configured-state-test-'));
  cleanupPaths.push(root);
  return root;
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

function config(stateDir: string, localRepositoryRoot?: string): KsLeslieConfig {
  return {
    openAiModel: 'gpt-5.6-sol',
    specialistModel: 'gpt-5.6-terra',
    stateDir,
    githubRepository: 'Hjunez/Kingshade-Torn-Suite',
    ...(localRepositoryRoot === undefined ? {} : { localRepositoryRoot }),
  };
}

describe('configured KS Leslie application', () => {
  it('creates the Core without a local Worker while preserving read-only evidence boundaries', async () => {
    const stateDirectory = await createStateDirectory();
    const application = await createConfiguredKsLeslieApplication(config(stateDirectory));

    expect(application.workerDoctor).toBeNull();
    expect(application.workerAgentService).toBeNull();
    expect(application.agent).toBe(application.agents.coordinator);
    expect(application.agents.coordinator.tools.map((tool) => tool.name)).toEqual([
      'research_torn',
      'analyze_torn_engineering',
      'review_torn_change',
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
      MEMORY_PROPOSAL_TOOL_NAME,
    ]);
    expect(application.agents.coordinator.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]),
    );
    expect(application.agents.engineering.tools.map((tool) => tool.name)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
    ]);
    expect(application.agents.review.tools.map((tool) => tool.name)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
    ]);
    expect(application.agents.research.tools.map((tool) => tool.name)).toEqual([
      'web_search',
      MEMORY_RETRIEVAL_TOOL_NAME,
    ]);
    expect(application.memoryStore.filePath).toBe(join(stateDirectory, 'memory-v1.json'));
    expect(application.memoryStore.filePath).not.toBe(join(stateDirectory, 'conversation.json'));
    expect(await application.memoryStore.listRecords()).toEqual([]);
    expect(application.memoryOwnerContext).toMatchObject({
      actorId: 'local-owner',
      role: 'OWNER_DEVELOPER',
    });
  });

  it('attaches Doctor-verified Worker tools to Engineering only', async () => {
    const root = await createRepository();
    const stateDirectory = await createStateDirectory();
    const application = await createConfiguredKsLeslieApplication(config(stateDirectory, root));

    expect(application.workerDoctor?.readyForLocalWorker).toBe(true);
    expect(application.workerAgentService).not.toBeNull();
    expect(application.agent).toBe(application.agents.coordinator);
    expect(application.agents.engineering.tools.map((tool) => tool.name)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
      ...WORKER_AGENT_TOOL_NAMES,
    ]);
    expect(application.agents.coordinator.tools.map((tool) => tool.name)).toEqual([
      'research_torn',
      'analyze_torn_engineering',
      'review_torn_change',
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
      MEMORY_PROPOSAL_TOOL_NAME,
    ]);
    expect(application.agents.research.tools.map((tool) => tool.name)).toEqual([
      'web_search',
      MEMORY_RETRIEVAL_TOOL_NAME,
    ]);
    expect(application.agents.review.tools.map((tool) => tool.name)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      MEMORY_RETRIEVAL_TOOL_NAME,
    ]);
  }, 30_000);

  it('fails closed before Core creation when the configured root fails Worker Doctor', async () => {
    const root = await createRepository('https://github.com/example/not-kingshade.git');
    const stateDirectory = await createStateDirectory();

    await expect(createConfiguredKsLeslieApplication(config(stateDirectory, root))).rejects.toThrow(
      'Local Worker Doctor failed: Kingshade repository identity',
    );
  }, 30_000);
});
