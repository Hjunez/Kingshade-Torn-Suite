import { describe, expect, it } from 'vitest';

import {
  createKsLeslieAgent,
  createKsLeslieAgentBundle,
  engineeringSpecialistOutputSchema,
  researchSpecialistOutputSchema,
  reviewSpecialistOutputSchema,
} from '../src/agents.js';
import type { KsLeslieConfig } from '../src/config.js';
import {
  MEMORY_PROPOSAL_TOOL_NAME,
  MEMORY_RETRIEVAL_TOOL_NAME,
} from '../src/memory/agent-tools.js';
import { createLocalOwnerMemoryRuntime } from '../src/memory/runtime.js';
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

const DELEGATION_TOOL_NAMES = [
  'research_torn',
  'analyze_torn_engineering',
  'review_torn_change',
] as const;
const COORDINATOR_TOOL_NAMES = [...DELEGATION_TOOL_NAMES, ...REPOSITORY_TOOL_NAMES];
const COORDINATOR_MEMORY_TOOL_NAMES = [
  MEMORY_RETRIEVAL_TOOL_NAME,
  MEMORY_PROPOSAL_TOOL_NAME,
] as const;
const READ_ONLY_MEMORY_TOOL_NAMES = [MEMORY_RETRIEVAL_TOOL_NAME] as const;
const GENERIC_EXECUTION_TOOL_TYPES = ['shell', 'computer', 'apply_patch'] as const;
const GENERIC_EXECUTION_TOOL_NAMES = [
  'shell',
  'computer_use_preview',
  'apply_patch',
  'code_interpreter',
  'exec',
  'execute',
  'process',
  'run_command',
] as const;

function createWorkerAgentService(): WorkerAgentService {
  return new WorkerAgentService({
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
}

function toolNames(agent: { tools: readonly { name: string }[] }): string[] {
  return agent.tools.map((tool) => tool.name);
}

function expectNoGenericExecutionPrimitives(
  agents: readonly { tools: readonly { name: string; type: string }[] }[],
): void {
  for (const agent of agents) {
    for (const tool of agent.tools) {
      expect(GENERIC_EXECUTION_TOOL_TYPES).not.toContain(tool.type);
      expect(GENERIC_EXECUTION_TOOL_NAMES).not.toContain(tool.name);
    }
  }
}

describe('KS Leslie Core agent topology', () => {
  it('constructs the exact read-only Core topology without a local Worker', () => {
    const bundle = createKsLeslieAgentBundle(config, { repositoryReader: reader });

    expect(toolNames(bundle.coordinator)).toEqual(COORDINATOR_TOOL_NAMES);
    expect(toolNames(bundle.research)).toEqual(['web_search']);
    expect(toolNames(bundle.engineering)).toEqual(REPOSITORY_TOOL_NAMES);
    expect(toolNames(bundle.review)).toEqual(REPOSITORY_TOOL_NAMES);

    expect(bundle.coordinator.tools[0]).toBe(bundle.delegations.research);
    expect(bundle.coordinator.tools[1]).toBe(bundle.delegations.engineering);
    expect(bundle.coordinator.tools[2]).toBe(bundle.delegations.review);
    expect(Object.values(bundle.delegations).map((delegation) => delegation.name)).toEqual(
      DELEGATION_TOOL_NAMES,
    );
    for (const delegation of Object.values(bundle.delegations)) {
      expect(delegation.type).toBe('function');
      expect(delegation.strict).toBe(true);
    }

    expect(bundle.coordinator.model).toBe(config.openAiModel);
    expect(bundle.research.model).toBe(config.specialistModel);
    expect(bundle.engineering.model).toBe(config.specialistModel);
    expect(bundle.review.model).toBe(config.specialistModel);

    for (const agent of [bundle.coordinator, bundle.research, bundle.engineering, bundle.review]) {
      expect(toolNames(agent)).not.toEqual(expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]));
    }
    expectNoGenericExecutionPrimitives([
      bundle.coordinator,
      bundle.research,
      bundle.engineering,
      bundle.review,
    ]);
  });

  it('adds optional vector search only to Torn Research', () => {
    const bundle = createKsLeslieAgentBundle(
      { ...config, vectorStoreId: 'vs_phase_c1_test' },
      { repositoryReader: reader },
    );

    expect(toolNames(bundle.research)).toEqual(['web_search', 'file_search']);
    expect(toolNames(bundle.coordinator)).toEqual(COORDINATOR_TOOL_NAMES);
    expect(toolNames(bundle.engineering)).toEqual(REPOSITORY_TOOL_NAMES);
    expect(toolNames(bundle.review)).toEqual(REPOSITORY_TOOL_NAMES);
  });

  it('confines an injected Worker tool layer to Torn Engineering', () => {
    const bundle = createKsLeslieAgentBundle(config, {
      repositoryReader: reader,
      workerAgentService: createWorkerAgentService(),
    });

    expect(toolNames(bundle.coordinator)).toEqual(COORDINATOR_TOOL_NAMES);
    expect(toolNames(bundle.research)).toEqual(['web_search']);
    expect(toolNames(bundle.engineering)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      ...WORKER_AGENT_TOOL_NAMES,
    ]);
    expect(toolNames(bundle.review)).toEqual(REPOSITORY_TOOL_NAMES);
    for (const agent of [bundle.coordinator, bundle.research, bundle.review]) {
      expect(toolNames(agent)).not.toEqual(expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]));
    }
    expectNoGenericExecutionPrimitives([
      bundle.coordinator,
      bundle.research,
      bundle.engineering,
      bundle.review,
    ]);
  });

  it('adds the exact memory topology without widening Worker or execution authority', () => {
    const memory = createLocalOwnerMemoryRuntime('.unused-memory-topology-state');
    const bundle = createKsLeslieAgentBundle(config, {
      repositoryReader: reader,
      memoryAgentServices: memory.agentServices,
      workerAgentService: createWorkerAgentService(),
    });

    expect(toolNames(bundle.coordinator)).toEqual([
      ...COORDINATOR_TOOL_NAMES,
      ...COORDINATOR_MEMORY_TOOL_NAMES,
    ]);
    expect(toolNames(bundle.research)).toEqual(['web_search', ...READ_ONLY_MEMORY_TOOL_NAMES]);
    expect(toolNames(bundle.engineering)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      ...READ_ONLY_MEMORY_TOOL_NAMES,
      ...WORKER_AGENT_TOOL_NAMES,
    ]);
    expect(toolNames(bundle.review)).toEqual([
      ...REPOSITORY_TOOL_NAMES,
      ...READ_ONLY_MEMORY_TOOL_NAMES,
    ]);

    for (const agent of [bundle.coordinator, bundle.research, bundle.engineering, bundle.review]) {
      expect(toolNames(agent)).toContain(MEMORY_RETRIEVAL_TOOL_NAME);
    }
    expect(toolNames(bundle.coordinator)).toContain(MEMORY_PROPOSAL_TOOL_NAME);
    for (const agent of [bundle.research, bundle.engineering, bundle.review]) {
      expect(toolNames(agent)).not.toContain(MEMORY_PROPOSAL_TOOL_NAME);
    }
    for (const agent of [bundle.coordinator, bundle.research, bundle.review]) {
      expect(toolNames(agent)).not.toEqual(expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]));
    }
    expectNoGenericExecutionPrimitives([
      bundle.coordinator,
      bundle.research,
      bundle.engineering,
      bundle.review,
    ]);
  });

  it('validates every structured specialist output without a model call', () => {
    const bundle = createKsLeslieAgentBundle(config, { repositoryReader: reader });
    const researchOutput = {
      findings: [
        {
          summary: 'The documented rule is current.',
          evidenceClassification: 'OFFICIAL_CURRENT' as const,
          basis: 'Current official Torn documentation.',
        },
      ],
      unresolvedQuestions: [],
    };
    const engineeringOutput = {
      problemInterpretation: 'Inspect the Core capability boundary.',
      repositoryEvidence: ['The coordinator exposes only read-only repository tools.'],
      rootCause: {
        status: 'verified' as const,
        summary: 'Worker tools are confined by construction.',
      },
      boundedAction: {
        status: 'completed' as const,
        summary: 'Constructed and inspected the agent bundle.',
      },
      tests: [
        {
          name: 'Core topology unit test',
          status: 'passed' as const,
          evidence: 'Exact tool lists matched.',
        },
      ],
      uncertainties: [],
      blockers: [],
    };
    const reviewOutput = {
      disposition: 'pass' as const,
      findings: ['The capability boundary is enforced by tool wiring.'],
      blockingIssues: [],
      nonBlockingRisks: [],
      missingEvidenceOrTests: [],
      independentFromImplementationApproval: true as const,
    };

    expect(bundle.research.outputType).toBe(researchSpecialistOutputSchema);
    expect(bundle.engineering.outputType).toBe(engineeringSpecialistOutputSchema);
    expect(bundle.review.outputType).toBe(reviewSpecialistOutputSchema);
    expect(bundle.research.processFinalOutput(JSON.stringify(researchOutput))).toEqual(
      researchOutput,
    );
    expect(bundle.engineering.processFinalOutput(JSON.stringify(engineeringOutput))).toEqual(
      engineeringOutput,
    );
    expect(bundle.review.processFinalOutput(JSON.stringify(reviewOutput))).toEqual(reviewOutput);

    expect(() =>
      bundle.research.processFinalOutput(
        JSON.stringify({
          ...researchOutput,
          findings: [
            {
              ...researchOutput.findings[0],
              evidenceClassification: 'UNCLASSIFIED',
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      bundle.engineering.processFinalOutput(
        JSON.stringify({ ...engineeringOutput, unexpectedApproval: true }),
      ),
    ).toThrow();
    expect(() =>
      bundle.review.processFinalOutput(
        JSON.stringify({ ...reviewOutput, independentFromImplementationApproval: false }),
      ),
    ).toThrow();
  });

  it('preserves the coordinator-only compatibility factory', () => {
    const coordinator = createKsLeslieAgent(config, { repositoryReader: reader });

    expect(coordinator.name).toBe('KS Leslie');
    expect(coordinator.model).toBe(config.openAiModel);
    expect(toolNames(coordinator)).toEqual(COORDINATOR_TOOL_NAMES);
    expect(coordinator.outputType).toBe('text');
  });
});
