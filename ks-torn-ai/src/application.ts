import { createKsLeslieAgentBundle } from './agents.js';
import type { KsLeslieConfig } from './config.js';
import { createLocalOwnerMemoryRuntime } from './memory/runtime.js';
import {
  createConfiguredWorkerService,
  type ConfiguredWorkerService,
} from './worker/configured-service.js';

export async function createConfiguredKsLeslieApplication(config: KsLeslieConfig) {
  const worker: ConfiguredWorkerService | null =
    config.localRepositoryRoot === undefined
      ? null
      : await createConfiguredWorkerService({
          repositoryRoot: config.localRepositoryRoot,
          expectedGitHubRepository: config.githubRepository,
        });
  const memory = createLocalOwnerMemoryRuntime(config.stateDir);
  const agents = createKsLeslieAgentBundle(config, {
    ...(worker === null ? {} : { workerAgentService: worker.service }),
    memoryAgentServices: memory.agentServices,
  });
  return {
    agent: agents.coordinator,
    agents,
    workerAgentService: worker?.service ?? null,
    workerDoctor: worker?.doctor ?? null,
    memoryStore: memory.store,
    memoryService: memory.service,
    memoryIngestion: memory.ingestion,
    memoryOwnerContext: memory.ownerContext,
  };
}
