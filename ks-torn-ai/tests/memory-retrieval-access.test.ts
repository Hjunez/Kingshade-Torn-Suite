import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryAuthorizationError,
  createTrustedMemoryAccessContext,
  type MemoryAccessContext,
} from '../src/memory/access.js';
import type { NewMemoryRecord } from '../src/memory/model.js';
import { MemoryService, type TrustedMemoryDraft } from '../src/memory/service.js';
import { DurableMemoryStore, DurableMemoryStoreError } from '../src/memory/store.js';
import {
  MEMORY_TIME_1,
  activeMemoryRecord,
  createMemoryTemporaryDirectory,
  removeMemoryTemporaryDirectory,
} from './memory-test-helpers.js';

const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const directory = await createMemoryTemporaryDirectory();
  temporaryDirectories.push(directory);
  return directory;
}

function readContext(
  options: {
    actorId?: string;
    projects?: string[];
    zones?: ('PUBLIC_TORN' | 'FACTION_SHARED' | 'PRIVATE_KINGSHADE_DEV' | 'USER_PRIVATE')[];
    tenants?: string[];
    includeReadCapability?: boolean;
  } = {},
): MemoryAccessContext {
  return createTrustedMemoryAccessContext({
    actorId: options.actorId ?? 'advisor-a',
    role: 'TORN_ADVISOR',
    capabilities: options.includeReadCapability === false ? [] : ['MEMORY_READ'],
    projectGrants: options.projects ?? ['project-alpha'],
    allowedZones: options.zones ?? ['PUBLIC_TORN'],
    tenantGrants: options.tenants ?? [],
  });
}

async function serviceWithRecords(
  records: readonly NewMemoryRecord[],
): Promise<{ service: MemoryService; store: DurableMemoryStore }> {
  const stateDirectory = await temporaryStateDirectory();
  let eventSequence = 0;
  const store = new DurableMemoryStore(stateDirectory, {
    eventIdFactory: () => `retrieval-event-${String(++eventSequence)}`,
  });
  for (const record of records) {
    await store.addRecord(record, 'fixture-writer');
  }
  return {
    service: new MemoryService(store, { now: () => new Date(MEMORY_TIME_1) }),
    store,
  };
}

function supersedingDraft(
  id: string,
  supersedesRecordId: string,
  overrides: Partial<TrustedMemoryDraft> = {},
): TrustedMemoryDraft {
  return {
    id,
    projectId: 'project-alpha',
    kind: 'FAILED_CANDIDATE',
    zone: 'PUBLIC_TORN',
    subject: 'Synthetic supersession evidence',
    content: 'A trusted synthetic failure supersedes earlier evidence.',
    evidenceClassification: 'AUTOMATED_TEST',
    source: {
      kind: 'TEST_RUN',
      reference: `synthetic:${id}`,
      description: 'Synthetic deterministic supersession evidence.',
    },
    verificationState: 'SUPPORTING',
    supersedesRecordId,
    ...overrides,
  };
}

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(removeMemoryTemporaryDirectory));
});

describe('MemoryService pre-ranking authorization', () => {
  it('returns granted public memory while a stronger private match cannot affect rank or conflict summaries', async () => {
    const publicRecord = activeMemoryRecord('public-authorized', {
      subject: 'Authorization needle',
      content: 'A modest public Torn observation.',
    });
    const privateRecord = activeMemoryRecord('private-unauthorized', {
      zone: 'PRIVATE_KINGSHADE_DEV',
      subject: 'Authorization needle',
      content:
        'Authorization needle is repeated with ultraprivatephrase for a much stronger score.',
    });
    const { service } = await serviceWithRecords([publicRecord, privateRecord]);

    const result = await service.retrieve(readContext(), {
      query: 'authorization needle',
      limit: 1,
    });

    expect(result).toMatchObject({
      authorizationAppliedBeforeRanking: true,
      truncated: false,
      records: [
        {
          id: publicRecord.id,
          zone: 'PUBLIC_TORN',
          conflictingRecordIds: [],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(privateRecord.id);
    expect(JSON.stringify(result)).not.toContain('ultraprivatephrase');

    const privateOnlyQuery = await service.retrieve(readContext(), {
      query: 'ultraprivatephrase',
      limit: 8,
    });
    expect(privateOnlyQuery.records).toEqual([]);
    expect(privateOnlyQuery.truncated).toBe(false);
  });

  it('isolates USER_PRIVATE records by the trusted actor id', async () => {
    const ownerARecord = activeMemoryRecord('private-owner-a', {
      zone: 'USER_PRIVATE',
      ownerId: 'owner-a',
      subject: 'Private Torn preference',
      content: 'Owner A synthetic private Torn preference.',
    });
    const ownerBRecord = activeMemoryRecord('private-owner-b', {
      zone: 'USER_PRIVATE',
      ownerId: 'owner-b',
      subject: 'Private Torn preference',
      content: 'Owner B synthetic private Torn preference.',
    });
    const { service } = await serviceWithRecords([ownerARecord, ownerBRecord]);

    const result = await service.retrieve(
      readContext({ actorId: 'owner-a', zones: ['USER_PRIVATE'] }),
      { query: 'private torn preference', limit: 8 },
    );

    expect(result.records.map((record) => record.id)).toEqual([ownerARecord.id]);
    expect(result.records[0]?.conflictingRecordIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(ownerBRecord.id);
  });

  it('isolates FACTION_SHARED records by explicit tenant grants', async () => {
    const factionARecord = activeMemoryRecord('faction-a-note', {
      zone: 'FACTION_SHARED',
      tenantId: 'faction-a',
      subject: 'Faction synthetic playbook',
      content: 'Faction A synthetic Torn playbook.',
    });
    const factionBRecord = activeMemoryRecord('faction-b-note', {
      zone: 'FACTION_SHARED',
      tenantId: 'faction-b',
      subject: 'Faction synthetic playbook',
      content: 'Faction B synthetic Torn playbook.',
    });
    const { service } = await serviceWithRecords([factionARecord, factionBRecord]);

    const result = await service.retrieve(
      readContext({ zones: ['FACTION_SHARED'], tenants: ['faction-a'] }),
      { query: 'faction synthetic playbook', limit: 8 },
    );

    expect(result.records.map((record) => record.id)).toEqual([factionARecord.id]);
    expect(result.records[0]?.conflictingRecordIds).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(factionBRecord.id);
  });

  it('isolates otherwise-readable public records by project grant', async () => {
    const grantedProjectRecord = activeMemoryRecord('project-alpha-note', {
      projectId: 'project-alpha',
      subject: 'Shared project query',
      content: 'Synthetic evidence from the granted project.',
    });
    const ungrantedProjectRecord = activeMemoryRecord('project-beta-note', {
      projectId: 'project-beta',
      subject: 'Shared project query',
      content: 'Synthetic evidence from an ungranted project.',
    });
    const { service } = await serviceWithRecords([grantedProjectRecord, ungrantedProjectRecord]);

    const result = await service.retrieve(readContext({ projects: ['project-alpha'] }), {
      query: 'shared project query',
      limit: 8,
    });

    expect(result.records.map((record) => record.id)).toEqual([grantedProjectRecord.id]);
    expect(JSON.stringify(result)).not.toContain(ungrantedProjectRecord.id);
  });

  it('default-denies missing context and contexts without MEMORY_READ', async () => {
    const { service } = await serviceWithRecords([
      activeMemoryRecord('default-deny-public', {
        subject: 'Default deny evidence',
      }),
    ]);
    const request = { query: 'default deny evidence', limit: 8 };

    await expect(service.retrieve(undefined, request)).rejects.toBeInstanceOf(
      MemoryAuthorizationError,
    );
    await expect(service.retrieve(null, request)).rejects.toBeInstanceOf(MemoryAuthorizationError);
    await expect(
      service.retrieve(readContext({ includeReadCapability: false }), request),
    ).rejects.toBeInstanceOf(MemoryAuthorizationError);
  });

  it('rejects unknown zones and advisor attempts to claim private development access', () => {
    expect(() =>
      createTrustedMemoryAccessContext({
        actorId: 'advisor-a',
        role: 'TORN_ADVISOR',
        capabilities: ['MEMORY_READ'],
        projectGrants: ['project-alpha'],
        allowedZones: ['UNKNOWN_ZONE'],
        tenantGrants: [],
      }),
    ).toThrow(MemoryAuthorizationError);
    expect(() =>
      createTrustedMemoryAccessContext({
        actorId: 'advisor-a',
        role: 'TORN_ADVISOR',
        capabilities: ['MEMORY_READ'],
        projectGrants: ['project-alpha'],
        allowedZones: ['PRIVATE_KINGSHADE_DEV'],
        tenantGrants: [],
      }),
    ).toThrow(MemoryAuthorizationError);
    expect(() =>
      createTrustedMemoryAccessContext({
        actorId: 'advisor-a',
        role: 'UNKNOWN_ROLE',
        capabilities: ['MEMORY_READ'],
        projectGrants: ['project-alpha'],
        allowedZones: ['PUBLIC_TORN'],
        tenantGrants: [],
      }),
    ).toThrow(MemoryAuthorizationError);
  });
});

describe('MemoryService conflict visibility', () => {
  it('returns contradictory active baseline evidence without applying latest-wins', async () => {
    const olderBaseline = activeMemoryRecord('baseline-a-older', {
      kind: 'BASELINE_EVIDENCE',
      subject: 'Known good baseline',
      content: 'Synthetic commit alpha was observed as a candidate.',
    });
    const newerBaseline = activeMemoryRecord('baseline-z-newer', {
      kind: 'BASELINE_EVIDENCE',
      subject: 'Known good baseline',
      content: 'Synthetic commit beta contradicts the earlier candidate.',
      createdAt: MEMORY_TIME_1,
      updatedAt: MEMORY_TIME_1,
    });
    const { service } = await serviceWithRecords([olderBaseline, newerBaseline]);

    const result = await service.retrieve(readContext(), {
      query: 'known good baseline',
      kinds: ['BASELINE_EVIDENCE'],
      limit: 8,
    });

    expect(result.records.map((record) => record.id)).toEqual([olderBaseline.id, newerBaseline.id]);
    expect(result.records[0]).toMatchObject({
      createdAt: olderBaseline.createdAt,
      conflictingRecordIds: [newerBaseline.id],
    });
    expect(result.records[1]).toMatchObject({
      createdAt: newerBaseline.createdAt,
      conflictingRecordIds: [olderBaseline.id],
    });
    expect(result.truncated).toBe(false);
  });
});

describe('MemoryService supersession authorization', () => {
  it('requires explicit invalidation capability in addition to write access', async () => {
    const target = activeMemoryRecord('public-target');
    const { service, store } = await serviceWithRecords([target]);
    const ingestOnly = createTrustedMemoryAccessContext({
      actorId: 'owner-a',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_INGEST'],
      projectGrants: ['project-alpha'],
      allowedZones: ['PUBLIC_TORN'],
      tenantGrants: [],
    });

    await expect(
      service.saveTrustedRecord(ingestOnly, supersedingDraft('public-replacement', target.id)),
    ).rejects.toBeInstanceOf(MemoryAuthorizationError);
    expect(await store.listRecords()).toEqual([target]);
  });

  it('cannot cross knowledge zones even when the actor can access both zones', async () => {
    const target = activeMemoryRecord('private-target', { zone: 'PRIVATE_KINGSHADE_DEV' });
    const { service, store } = await serviceWithRecords([target]);
    const context = createTrustedMemoryAccessContext({
      actorId: 'owner-a',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_INGEST', 'MEMORY_INVALIDATE'],
      projectGrants: ['project-alpha'],
      allowedZones: ['PUBLIC_TORN', 'PRIVATE_KINGSHADE_DEV'],
      tenantGrants: [],
    });

    await expect(
      service.saveTrustedRecord(
        context,
        supersedingDraft('public-replacement', target.id, { zone: 'PUBLIC_TORN' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await store.listRecords()).toEqual([target]);
  });

  it('cannot cross USER_PRIVATE owners', async () => {
    const target = activeMemoryRecord('private-owner-b-target', {
      zone: 'USER_PRIVATE',
      ownerId: 'owner-b',
    });
    const { service, store } = await serviceWithRecords([target]);
    const ownerAContext = createTrustedMemoryAccessContext({
      actorId: 'owner-a',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_INGEST', 'MEMORY_INVALIDATE'],
      projectGrants: ['project-alpha'],
      allowedZones: ['USER_PRIVATE'],
      tenantGrants: [],
    });

    await expect(
      service.saveTrustedRecord(
        ownerAContext,
        supersedingDraft('private-owner-a-replacement', target.id, {
          zone: 'USER_PRIVATE',
          ownerId: 'owner-a',
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryAuthorizationError);
    expect(await store.listRecords()).toEqual([target]);
  });

  it('cannot cross FACTION_SHARED tenants even when both tenants are granted', async () => {
    const target = activeMemoryRecord('faction-b-target', {
      zone: 'FACTION_SHARED',
      tenantId: 'faction-b',
    });
    const { service, store } = await serviceWithRecords([target]);
    const context = createTrustedMemoryAccessContext({
      actorId: 'owner-a',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_INGEST', 'MEMORY_INVALIDATE'],
      projectGrants: ['project-alpha'],
      allowedZones: ['FACTION_SHARED'],
      tenantGrants: ['faction-a', 'faction-b'],
    });

    await expect(
      service.saveTrustedRecord(
        context,
        supersedingDraft('faction-a-replacement', target.id, {
          zone: 'FACTION_SHARED',
          tenantId: 'faction-a',
        }),
      ),
    ).rejects.toBeInstanceOf(DurableMemoryStoreError);
    expect(await store.listRecords()).toEqual([target]);
  });
});
