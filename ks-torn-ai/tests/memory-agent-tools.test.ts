import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunContext, type Tool } from '@openai/agents';
import { afterEach, describe, expect, it } from 'vitest';

import { createTrustedMemoryAccessContext } from '../src/memory/access.js';
import {
  MEMORY_PROPOSAL_TOOL_NAME,
  MEMORY_RETRIEVAL_TOOL_NAME,
  createCoordinatorMemoryTools,
  createReadOnlyMemoryTools,
  proposeDurableMemoryInputSchema,
  retrieveAuthorizedMemoryInputSchema,
} from '../src/memory/agent-tools.js';
import {
  AuthorizedMemoryReader,
  MemoryService,
  PendingMemoryWriter,
} from '../src/memory/service.js';
import { createLocalOwnerMemoryRuntime } from '../src/memory/runtime.js';
import { DurableMemoryStore } from '../src/memory/store.js';

const FIXED_TIME = new Date('2026-08-24T12:00:00.000Z');
const cleanupPaths: string[] = [];

const MODEL_FORBIDDEN_MEMORY_FIELDS = [
  'actor',
  'actorId',
  'user',
  'userId',
  'role',
  'capability',
  'capabilities',
  'project',
  'projectId',
  'projectGrants',
  'zone',
  'allowedZones',
  'owner',
  'ownerId',
  'tenant',
  'tenantId',
  'tenantGrants',
  'faction',
  'factionId',
  'factionGrants',
  'evidenceClass',
  'evidenceClassification',
  'verification',
  'verificationState',
  'ownerVerified',
  'ownerVerificationEvidence',
  'verifiedByActorId',
  'evidenceReference',
  'active',
  'lifecycleStatus',
  'timestamp',
  'timestamps',
  'createdAt',
  'updatedAt',
  'id',
  'supersedes',
  'supersession',
  'supersedesRecordId',
  'replacementRecordId',
  'source',
  'sourceKind',
  'sourceReference',
  'contentScope',
  'lifecycle',
  'command',
  'executable',
  'token',
  'apiToken',
  'githubToken',
  'approvalToken',
] as const;

function requireFunctionTool(tools: readonly Tool[], name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (selected?.type !== 'function') {
    throw new Error(`Missing function tool: ${name}`);
  }
  return selected;
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

async function createMemoryToolFixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'ks-leslie-memory-agent-tools-'));
  cleanupPaths.push(stateDirectory);
  let eventSequence = 0;
  const store = new DurableMemoryStore(stateDirectory, {
    now: () => FIXED_TIME,
    eventIdFactory: () => `event-${String(++eventSequence)}`,
  });
  const service = new MemoryService(store, {
    now: () => FIXED_TIME,
    recordIdFactory: () => 'deterministic-proposal',
  });
  const context = createTrustedMemoryAccessContext({
    actorId: 'trusted-test-owner',
    role: 'OWNER_DEVELOPER',
    capabilities: ['MEMORY_READ', 'MEMORY_PROPOSE', 'MEMORY_INGEST'],
    projectGrants: ['kingshade-torn-suite'],
    allowedZones: ['PRIVATE_KINGSHADE_DEV'],
    tenantGrants: [],
  });
  const reader = new AuthorizedMemoryReader(service, context);
  const writer = new PendingMemoryWriter(service, context, {
    projectId: 'kingshade-torn-suite',
    zone: 'PRIVATE_KINGSHADE_DEV',
    sourceReference: 'ks-leslie:test-proposal',
  });

  return {
    service,
    store,
    tools: createCoordinatorMemoryTools(reader, writer),
  };
}

describe('durable memory agent tools', () => {
  it('strictly excludes model-selected identity, authority, verification and execution fields', () => {
    const validRetrieval = { query: 'known good baseline', limit: 3 };
    const validProposal = {
      kind: 'PROJECT_DECISION' as const,
      subject: 'Keep the Phase C1 topology',
      content: 'The current topology should remain unchanged pending trusted review.',
      sourceDescription: 'Coordinator hypothesis from the current Torn development task.',
    };

    expect(retrieveAuthorizedMemoryInputSchema.safeParse(validRetrieval).success).toBe(true);
    expect(proposeDurableMemoryInputSchema.safeParse(validProposal).success).toBe(true);

    for (const field of MODEL_FORBIDDEN_MEMORY_FIELDS) {
      expect(
        retrieveAuthorizedMemoryInputSchema.safeParse({
          ...validRetrieval,
          [field]: 'model-controlled',
        }).success,
        `retrieval schema accepted ${field}`,
      ).toBe(false);
      expect(
        proposeDurableMemoryInputSchema.safeParse({
          ...validProposal,
          [field]: 'model-controlled',
        }).success,
        `proposal schema accepted ${field}`,
      ).toBe(false);
    }
  });

  it('invokes tools without a model and injects a pending-hypothesis authority scope', async () => {
    const fixture = await createMemoryToolFixture();
    await fixture.service.saveTrustedRecord(
      createTrustedMemoryAccessContext({
        actorId: 'trusted-test-owner',
        role: 'OWNER_DEVELOPER',
        capabilities: ['MEMORY_READ', 'MEMORY_PROPOSE', 'MEMORY_INGEST'],
        projectGrants: ['kingshade-torn-suite'],
        allowedZones: ['PRIVATE_KINGSHADE_DEV'],
        tenantGrants: [],
      }),
      {
        id: 'baseline-evidence-1',
        projectId: 'kingshade-torn-suite',
        kind: 'BASELINE_EVIDENCE',
        zone: 'PRIVATE_KINGSHADE_DEV',
        subject: 'Known good baseline evidence',
        content: 'The Phase C1 checkpoint is supporting baseline evidence for C2.',
        evidenceClassification: 'AUTOMATED_TEST',
        source: {
          kind: 'TEST_RUN',
          reference: 'test-run:phase-c1',
          description: 'Synthetic deterministic test evidence.',
        },
        verificationState: 'SUPPORTING',
      },
    );

    const runContext = new RunContext();
    const retrieved: unknown = await requireFunctionTool(
      fixture.tools,
      MEMORY_RETRIEVAL_TOOL_NAME,
    ).invoke(runContext, JSON.stringify({ query: 'baseline evidence', limit: 2 }));
    expect(retrieved).toMatchObject({
      status: 'ok',
      errorCode: 'NONE',
      authorizationAppliedBeforeRanking: true,
      records: [
        {
          id: 'baseline-evidence-1',
          projectId: 'kingshade-torn-suite',
          zone: 'PRIVATE_KINGSHADE_DEV',
          evidenceClassification: 'AUTOMATED_TEST',
          verificationState: 'SUPPORTING',
        },
      ],
    });

    const proposed: unknown = await requireFunctionTool(
      fixture.tools,
      MEMORY_PROPOSAL_TOOL_NAME,
    ).invoke(
      runContext,
      JSON.stringify({
        kind: 'PROJECT_DECISION',
        subject: 'Retain the bounded Core topology',
        content: 'Keep Worker authority confined to Engineering.',
        sourceDescription: 'A model proposal awaiting trusted review.',
      }),
    );
    expect(proposed).toEqual({
      status: 'pending_review',
      proposalId: 'proposal-deterministic-proposal',
      projectId: 'kingshade-torn-suite',
      zone: 'PRIVATE_KINGSHADE_DEV',
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      verificationState: 'HYPOTHESIS',
      lifecycleStatus: 'PENDING',
      duplicateOfRecordId: null,
    });

    const records = await fixture.store.listRecords();
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.id === 'proposal-deterministic-proposal')).toEqual(
      expect.objectContaining({
        projectId: 'kingshade-torn-suite',
        zone: 'PRIVATE_KINGSHADE_DEV',
        evidenceClassification: 'INFERENCE_HYPOTHESIS',
        verificationState: 'HYPOTHESIS',
        source: {
          kind: 'MODEL_PROPOSAL',
          reference: 'ks-leslie:test-proposal',
          description: 'A model proposal awaiting trusted review.',
        },
        lifecycle: { status: 'PENDING' },
      }),
    );
  });

  it('enforces the strict schemas at the SDK invocation boundary', async () => {
    const fixture = await createMemoryToolFixture();
    const runContext = new RunContext();

    const invalidRetrieval: unknown = await requireFunctionTool(
      fixture.tools,
      MEMORY_RETRIEVAL_TOOL_NAME,
    ).invoke(runContext, JSON.stringify({ query: 'baseline', actorId: 'model-selected-owner' }));
    expect(invalidRetrieval).toEqual({
      status: 'error',
      errorCode: 'OPERATION_FAILED',
      authorizationAppliedBeforeRanking: true,
      records: [],
      truncated: false,
    });

    const invalidProposal: unknown = await requireFunctionTool(
      fixture.tools,
      MEMORY_PROPOSAL_TOOL_NAME,
    ).invoke(
      runContext,
      JSON.stringify({
        kind: 'VERIFIED_FACT',
        subject: 'Fabricated verification',
        content: 'The model attempted to choose a protected zone.',
        sourceDescription: 'Synthetic attack input.',
        zone: 'PUBLIC_TORN',
        ownerVerified: true,
      }),
    );
    expect(invalidProposal).toEqual({
      status: 'rejected',
      proposalId: null,
      projectId: null,
      zone: null,
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      verificationState: 'HYPOTHESIS',
      lifecycleStatus: 'PENDING',
      duplicateOfRecordId: null,
    });

    expect(await fixture.store.listRecords()).toEqual([]);
  });

  it('keeps the runtime Research reader public-only while coordinator access stays independent', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ks-leslie-memory-runtime-scope-'));
    cleanupPaths.push(stateDirectory);
    const runtime = createLocalOwnerMemoryRuntime(stateDirectory);
    const common = {
      projectId: 'kingshade-torn-suite',
      kind: 'CURATED_TORN_NOTE' as const,
      subject: 'Runtime scope evidence',
      evidenceClassification: 'COMMUNITY_DERIVED' as const,
      source: {
        kind: 'TRUSTED_APPLICATION' as const,
        reference: 'synthetic:runtime-scope',
        description: 'Synthetic runtime scope evidence.',
      },
      verificationState: 'SUPPORTING' as const,
    };
    await runtime.service.saveTrustedRecord(runtime.ownerContext, {
      ...common,
      id: 'runtime-public-note',
      zone: 'PUBLIC_TORN',
      content: 'Public runtime scope evidence.',
    });
    await runtime.service.saveTrustedRecord(runtime.ownerContext, {
      ...common,
      id: 'runtime-private-note',
      zone: 'PRIVATE_KINGSHADE_DEV',
      content: 'Private runtime scope evidence.',
    });

    const research: unknown = await requireFunctionTool(
      createReadOnlyMemoryTools(runtime.agentServices.research.reader),
      MEMORY_RETRIEVAL_TOOL_NAME,
    ).invoke(new RunContext(), JSON.stringify({ query: 'runtime scope evidence', limit: 8 }));
    const coordinator: unknown = await requireFunctionTool(
      createCoordinatorMemoryTools(
        runtime.agentServices.coordinator.reader,
        runtime.agentServices.coordinator.writer,
      ),
      MEMORY_RETRIEVAL_TOOL_NAME,
    ).invoke(new RunContext(), JSON.stringify({ query: 'runtime scope evidence', limit: 8 }));

    expect(JSON.stringify(research)).toContain('runtime-public-note');
    expect(JSON.stringify(research)).not.toContain('runtime-private-note');
    expect(JSON.stringify(coordinator)).toContain('runtime-public-note');
    expect(JSON.stringify(coordinator)).toContain('runtime-private-note');
  });
});
