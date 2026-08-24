import { createKsLeslieAgent } from './agents.js';
import type { KsLeslieConfig } from './config.js';
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
  return {
    agent: createKsLeslieAgent(config, {
      ...(worker === null ? {} : { workerAgentService: worker.service }),
    }),
    workerAgentService: worker?.service ?? null,
    workerDoctor: worker?.doctor ?? null,
  };
}
