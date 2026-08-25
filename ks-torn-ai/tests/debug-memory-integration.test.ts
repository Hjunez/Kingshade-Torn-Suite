import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SyntheticDebugMemoryPersistenceError,
  SyntheticDebugMemorySink,
  type SyntheticDebugDurableOutcome,
} from '../src/debug/memory-integration.js';
import {
  createTrustedMemoryAccessContext,
  type MemoryAccessContext,
} from '../src/memory/access.js';
import { MAX_MEMORY_CONTENT_CHARS } from '../src/memory/model.js';
import { MemoryService } from '../src/memory/service.js';
import { DurableMemoryStore, DurableMemoryStoreError } from '../src/memory/store.js';

const PROJECT_ID = 'synthetic-c3';
const BASELINE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const NOW = new Date('2026-08-25T10:00:00.000Z');
const directories: string[] = [];

function context(
  options: { project?: string; zone?: 'PRIVATE_KINGSHADE_DEV' | 'PUBLIC_TORN' } = {},
) {
  return createTrustedMemoryAccessContext({
    actorId: 'trusted-c3-memory-sink',
    role: 'OWNER_DEVELOPER',
    capabilities: ['MEMORY_READ', 'MEMORY_INGEST'],
    projectGrants: [options.project ?? PROJECT_ID],
    allowedZones: [options.zone ?? 'PRIVATE_KINGSHADE_DEV'],
    tenantGrants: [],
  });
}

function outcome(
  overrides: Partial<SyntheticDebugDurableOutcome> = {},
): SyntheticDebugDurableOutcome {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    caseId: 'task-k-case',
    projectId: PROJECT_ID,
    finalDisposition: 'TEST_READY',
    baselineSha: BASELINE_SHA,
    candidateSha: CANDIDATE_SHA,
    verificationDecisionId: 'verification-task-k',
    verificationStatus: 'PASSED',
    verificationProfiles: [{ profileId: 'synthetic-check', status: 'passed' }],
    reviewId: 'review-task-k',
    reviewDisposition: 'pass',
    failureCodes: [],
    ...overrides,
  };
}

async function harness(access: MemoryAccessContext | null | undefined = context()) {
  const directory = await mkdtemp(join(tmpdir(), 'ks-leslie-c3-memory-'));
  directories.push(directory);
  const store = new DurableMemoryStore(directory, {
    now: () => NOW,
    eventIdFactory: (() => {
      let index = 0;
      return () => `event-${String(++index)}`;
    })(),
  });
  const service = new MemoryService(store, { now: () => NOW });
  return {
    directory,
    store,
    service,
    sink: new SyntheticDebugMemorySink(service, access, PROJECT_ID),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('C3.10 durable synthetic memory integration', () => {
  it('persists TEST_READY, verification, and review as synthetic supporting evidence', async () => {
    const { sink, store } = await harness();
    const result = await sink.persist(outcome());
    const records = await store.listRecords();

    expect(result).toMatchObject({ status: 'PERSISTED', disposition: 'TEST_READY' });
    expect(records.map(({ kind }) => kind).sort()).toEqual([
      'ARCHITECTURE_SECURITY_DECISION',
      'PROJECT_DECISION',
      'TEST_RESULT',
    ]);
    expect(
      records.every(
        (record) =>
          record.projectId === PROJECT_ID &&
          record.zone === 'PRIVATE_KINGSHADE_DEV' &&
          record.evidenceClassification === 'AUTOMATED_TEST' &&
          record.verificationState === 'SUPPORTING' &&
          record.ownerVerificationEvidence === undefined &&
          record.source.kind === 'TEST_RUN' &&
          record.content.includes('SYNTHETIC_TEST_FIXTURE'),
      ),
    ).toBe(true);
  });

  it('persists BLOCKED and failed-candidate history without erasing prior evidence', async () => {
    const { sink, store } = await harness();
    await sink.persist(outcome());
    const blocked = outcome({
      caseId: 'task-k-blocked',
      finalDisposition: 'BLOCKED',
      verificationDecisionId: 'verification-task-k-blocked',
      verificationStatus: 'FAILED',
      verificationProfiles: [{ profileId: 'synthetic-check', status: 'failed' }],
      reviewId: null,
      reviewDisposition: 'not_run',
      failureCodes: ['TEST_PROFILE_FAILED'],
    });
    await sink.persist(blocked);

    const records = await store.listRecords();
    expect(records.filter(({ kind }) => kind === 'FAILED_CANDIDATE')).toHaveLength(1);
    expect(records.filter(({ kind }) => kind === 'PROJECT_DECISION')).toHaveLength(2);
    expect(records.every(({ lifecycle }) => lifecycle.status === 'ACTIVE')).toBe(true);
  });

  it('uses exact replay duplicate semantics and rejects deterministic collisions', async () => {
    const { sink, store } = await harness();
    const first = await sink.persist(outcome());
    const replay = await sink.persist(structuredClone(outcome()));
    expect(replay.records.every(({ status }) => status === 'duplicate')).toBe(true);
    expect(replay.records.map(({ id }) => id)).toEqual(first.records.map(({ id }) => id));
    expect(await store.readAuditEvents()).toHaveLength(first.records.length);

    const file = JSON.parse(await readFile(store.filePath, 'utf8')) as {
      events: { record?: { id: string; content: string } }[];
    };
    const record = file.events.find((event) => event.record !== undefined)?.record;
    if (record === undefined) throw new Error('Expected stored record');
    record.content = '{"scope":"SYNTHETIC_TEST_FIXTURE","conflict":true}';
    await writeFile(store.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await expect(sink.persist(outcome())).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      message: 'Synthetic debug memory persistence failed',
    });
  });

  it.each([
    ['wrong project grant', context({ project: 'different-project' })],
    ['wrong zone grant', context({ zone: 'PUBLIC_TORN' })],
    ['missing context', null],
  ] as const)('denies %s without writing', async (_label, access) => {
    const { sink, store } = await harness(access);
    await expect(sink.persist(outcome())).rejects.toBeInstanceOf(
      SyntheticDebugMemoryPersistenceError,
    );
    expect(await store.listRecords()).toEqual([]);
  });

  it('rejects mismatched project input before authorization metadata can be broadened', async () => {
    const { sink, store } = await harness();
    await expect(
      sink.persist({
        ...outcome(),
        projectId: 'different-project',
        zone: 'PUBLIC_TORN',
        verificationState: 'OWNER_VERIFIED',
        actorId: 'model-chosen-owner',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTCOME' });
    expect(await store.listRecords()).toEqual([]);
  });

  it('retrieves only through existing authorized C2 scope filtering and exposes provenance', async () => {
    const { sink, service } = await harness();
    await sink.persist(outcome());
    const authorized = await service.retrieve(context(), { query: 'Synthetic C3', limit: 8 });
    const unauthorized = await service.retrieve(context({ project: 'different-project' }), {
      query: 'Synthetic C3',
      limit: 8,
    });
    expect(authorized.authorizationAppliedBeforeRanking).toBe(true);
    expect(authorized.records).toHaveLength(3);
    expect(
      authorized.records.every(
        (record) =>
          record.evidenceClassification === 'AUTOMATED_TEST' &&
          record.verificationState === 'SUPPORTING',
      ),
    ).toBe(true);
    expect(unauthorized.records).toEqual([]);
  });

  it('keeps contradictory active workflow decisions visible without latest-wins collapse', async () => {
    const { sink, service } = await harness();
    await sink.persist(outcome());
    await sink.persist(outcome({ finalDisposition: 'BLOCKED', failureCodes: ['LATE_BLOCKER'] }));
    const retrieved = await service.retrieve(context(), {
      query: 'Synthetic C3 workflow task k case',
      kinds: ['PROJECT_DECISION'],
      limit: 8,
    });
    expect(retrieved.records).toHaveLength(2);
    expect(retrieved.records.every((record) => record.conflictingRecordIds.length === 1)).toBe(
      true,
    );
  });

  it.each([
    ['approval grant', '7'.repeat(64)],
    ['API credential', 'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'],
    ['unsafe control', 'unsafe\0value'],
    ['unrelated PII', 'private home address 1 Example Street'],
    ['oversize', 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1)],
  ])('rejects %s without exposing the rejected value', async (_label, unsafe) => {
    const { sink, store } = await harness();
    let error: unknown;
    try {
      await sink.persist(outcome({ failureCodes: [unsafe] }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SyntheticDebugMemoryPersistenceError);
    expect(String(error)).not.toContain(unsafe);
    expect(await store.listRecords()).toEqual([]);
  });

  it('reports store corruption and partial-write failure without durable TEST_READY success', async () => {
    const { directory, sink, store } = await harness();
    await writeFile(join(directory, 'memory-v1.json'), '{corrupt', 'utf8');
    await expect(sink.persist(outcome())).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      message: 'Synthetic debug memory persistence failed',
      persistedRecordIds: [],
    });
    await expect(store.listRecords()).rejects.toBeInstanceOf(DurableMemoryStoreError);
  });
});
