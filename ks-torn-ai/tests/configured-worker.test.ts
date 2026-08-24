import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConfiguredKsLeslieApplication } from '../src/application.js';
import type { KsLeslieConfig } from '../src/config.js';
import { runProcess } from '../src/worker/process-runner.js';
import { WORKER_AGENT_TOOL_NAMES } from '../src/worker/agent-tools.js';

const cleanupPaths: string[] = [];

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runProcess({ executable: 'git', args, cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Git fixture command failed');
  }
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ks-leslie-configured-worker-test-'));
  cleanupPaths.push(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'configured-worker@example.invalid']);
  await git(root, ['config', 'user.name', 'Configured Worker Test']);
  await git(root, [
    'remote',
    'add',
    'origin',
    'https://github.com/Hjunez/Kingshade-Torn-Suite.git',
  ]);
  await writeFile(join(root, 'fixture.txt'), 'fixture\n', 'utf8');
  await git(root, ['add', 'fixture.txt']);
  await git(root, ['commit', '-m', 'configured Worker fixture']);
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

function config(localRepositoryRoot?: string): KsLeslieConfig {
  return {
    openAiModel: 'gpt-5.6-sol',
    specialistModel: 'gpt-5.6-terra',
    stateDir: '.state',
    githubRepository: 'Hjunez/Kingshade-Torn-Suite',
    ...(localRepositoryRoot === undefined ? {} : { localRepositoryRoot }),
  };
}

describe('configured KS Leslie application', () => {
  it('keeps Worker tools absent without an explicit local repository root', async () => {
    const application = await createConfiguredKsLeslieApplication(config());

    expect(application.workerDoctor).toBeNull();
    expect(application.workerAgentService).toBeNull();
    expect(application.agent.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]),
    );
  });

  it('attaches the trusted Worker tools only after the configured root passes Doctor', async () => {
    const root = await createRepository();
    const application = await createConfiguredKsLeslieApplication(config(root));

    expect(application.workerDoctor?.readyForLocalWorker).toBe(true);
    expect(application.workerAgentService).not.toBeNull();
    expect(application.agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]),
    );
  }, 30_000);
});
