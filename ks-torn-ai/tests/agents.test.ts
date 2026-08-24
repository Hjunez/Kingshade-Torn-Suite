import { describe, expect, it } from 'vitest';

import { createKsLeslieAgent } from '../src/agents.js';
import type { KsLeslieConfig } from '../src/config.js';
import type { RepositoryReader } from '../src/repository/reader.js';
import { REPOSITORY_TOOL_NAMES } from '../src/repository/tools.js';
import { WORKER_AGENT_TOOL_NAMES, WorkerAgentService } from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';

const config: KsLeslieConfig = {
  openAiModel: 'gpt-5.6-sol',
  specialistModel: 'gpt-5.6-terra',
  stateDir: '.state',
  githubRepository: 'Hjunez/Kingshade-Torn-Suite',
};

const reader: RepositoryReader = {
  resolveRef() {
    return Promise.resolve('a'.repeat(40));
  },
  readFile(path) {
    return Promise.resolve({ path, sha: 'blob', content: '' });
  },
  listCommits() {
    return Promise.resolve([]);
  },
  compareRefs() {
    return Promise.resolve({
      status: 'identical',
      aheadBy: 0,
      behindBy: 0,
      totalCommits: 0,
      files: [],
    });
  },
};

describe('createKsLeslieAgent', () => {
  it('wires injected repository intelligence tools into the coordinator without network access', () => {
    const agent = createKsLeslieAgent(config, { repositoryReader: reader });
    const toolNames = agent.tools.map((agentTool) => agentTool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'research_torn',
        'analyze_torn_engineering',
        'review_torn_change',
        ...REPOSITORY_TOOL_NAMES,
      ]),
    );
    expect(toolNames).not.toEqual(expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]));
  });

  it('wires only an explicitly trusted Worker service into the coordinator', () => {
    const workerAgentService = new WorkerAgentService({
      policies: new WorkerPolicyRegistry([
        {
          projectId: 'synthetic',
          repositoryRoot: 'C:/trusted/synthetic',
          readablePaths: ['fixture.txt'],
          writablePaths: ['fixture.txt'],
          allowedTestProfileIds: ['suite-layout'],
          requiredWriteTestProfileIds: ['suite-layout'],
          branchPrefix: 'ks-leslie/synthetic/',
        },
      ]),
      approvals: new WriteApprovalStore(),
    });
    const agent = createKsLeslieAgent(config, { repositoryReader: reader, workerAgentService });

    expect(agent.tools.map((agentTool) => agentTool.name)).toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]),
    );
  });
});
