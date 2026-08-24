import { createTrustedMemoryAccessContext } from './access.js';
import { CuratedMemoryIngestionService } from './ingestion.js';
import { AuthorizedMemoryReader, MemoryService, PendingMemoryWriter } from './service.js';
import { DurableMemoryStore } from './store.js';

export const KS_LESLIE_MEMORY_PROJECT_ID = 'kingshade-torn-suite' as const;
export const KS_LESLIE_MEMORY_PROJECT_GRANTS = [
  KS_LESLIE_MEMORY_PROJECT_ID,
  'war-dibs',
  'ffscouter-call-guard',
  'war-tools',
  'scout',
] as const;

export interface KsLeslieMemoryAgentServices {
  coordinator: {
    reader: AuthorizedMemoryReader;
    writer: PendingMemoryWriter;
  };
  research: {
    reader: AuthorizedMemoryReader;
  };
  engineering: {
    reader: AuthorizedMemoryReader;
  };
  review: {
    reader: AuthorizedMemoryReader;
  };
}

export function createLocalOwnerMemoryRuntime(stateDirectory: string) {
  const store = new DurableMemoryStore(stateDirectory);
  const service = new MemoryService(store);
  const common = {
    actorId: 'local-owner',
    role: 'OWNER_DEVELOPER' as const,
    projectGrants: [...KS_LESLIE_MEMORY_PROJECT_GRANTS],
    tenantGrants: [],
  };
  const coordinatorContext = createTrustedMemoryAccessContext({
    ...common,
    capabilities: [
      'MEMORY_READ',
      'MEMORY_PROPOSE',
      'MEMORY_INGEST',
      'MEMORY_INVALIDATE',
      'MEMORY_VERIFY_OWNER',
    ],
    allowedZones: ['PUBLIC_TORN', 'PRIVATE_KINGSHADE_DEV', 'USER_PRIVATE'],
  });
  const researchContext = createTrustedMemoryAccessContext({
    ...common,
    capabilities: ['MEMORY_READ'],
    allowedZones: ['PUBLIC_TORN'],
  });
  const developmentReadContext = createTrustedMemoryAccessContext({
    ...common,
    capabilities: ['MEMORY_READ'],
    allowedZones: ['PUBLIC_TORN', 'PRIVATE_KINGSHADE_DEV'],
  });

  const agentServices: KsLeslieMemoryAgentServices = {
    coordinator: {
      reader: new AuthorizedMemoryReader(service, coordinatorContext),
      writer: new PendingMemoryWriter(service, coordinatorContext, {
        projectId: KS_LESLIE_MEMORY_PROJECT_ID,
        zone: 'PRIVATE_KINGSHADE_DEV',
        sourceReference: 'ks-leslie:coordinator-proposal',
      }),
    },
    research: {
      reader: new AuthorizedMemoryReader(service, researchContext),
    },
    engineering: {
      reader: new AuthorizedMemoryReader(service, developmentReadContext),
    },
    review: {
      reader: new AuthorizedMemoryReader(service, developmentReadContext),
    },
  };

  return {
    store,
    service,
    ingestion: new CuratedMemoryIngestionService(service),
    ownerContext: coordinatorContext,
    agentServices,
  } as const;
}
