import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTrustedMemoryAccessContext } from '../src/memory/access.js';
import { MemoryService } from '../src/memory/service.js';
import { DurableMemoryStore } from '../src/memory/store.js';
import {
  MEMORY_TIME_0,
  MEMORY_TIME_1,
  MEMORY_TIME_2,
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

function eventIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence)}`;
}

const ownerContext = createTrustedMemoryAccessContext({
  actorId: 'owner-a',
  role: 'OWNER_DEVELOPER',
  capabilities: ['MEMORY_READ', 'MEMORY_INGEST', 'MEMORY_INVALIDATE'],
  projectGrants: ['project-alpha'],
  allowedZones: ['PUBLIC_TORN'],
  tenantGrants: [],
});

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(removeMemoryTemporaryDirectory));
});

describe('DurableMemoryStore persistence and audit history', () => {
  it('persists across store and service recreation without composing conversation.json', async () => {
    const stateDirectory = await temporaryStateDirectory();
    const conversationPath = join(stateDirectory, 'conversation.json');
    const conversationState = '{"conversationId":"conversation-sentinel"}\n';
    await writeFile(conversationPath, conversationState, 'utf8');

    const firstStore = new DurableMemoryStore(stateDirectory, {
      eventIdFactory: eventIdFactory('first-event'),
    });
    const firstService = new MemoryService(firstStore, {
      now: () => new Date(MEMORY_TIME_0),
    });
    await firstService.saveTrustedRecord(ownerContext, {
      id: 'persistent-record',
      projectId: 'project-alpha',
      kind: 'TEST_RESULT',
      zone: 'PUBLIC_TORN',
      subject: 'Persistent restart evidence',
      content: 'This synthetic Torn memory survives a service restart.',
      evidenceClassification: 'AUTOMATED_TEST',
      source: {
        kind: 'TEST_RUN',
        reference: 'synthetic:persistent-record',
        description: 'Synthetic deterministic persistence evidence.',
      },
      verificationState: 'SUPPORTING',
    });

    const reopenedStore = new DurableMemoryStore(stateDirectory, {
      eventIdFactory: eventIdFactory('reopened-event'),
    });
    const reopenedService = new MemoryService(reopenedStore, {
      now: () => new Date(MEMORY_TIME_1),
    });
    const retrieval = await reopenedService.retrieve(ownerContext, {
      query: 'persistent restart',
      limit: 8,
    });

    expect(retrieval.records.map((record) => record.id)).toEqual(['persistent-record']);
    expect(await reopenedStore.readAuditEvents()).toHaveLength(1);
    expect(reopenedStore.filePath).not.toBe(conversationPath);
    expect(await readFile(conversationPath, 'utf8')).toBe(conversationState);
  });

  it('fails visibly and leaves a corrupted store untouched', async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory);
    const corruptedContents = '{"format":"ks-leslie-memory-event-store","events":[';
    await writeFile(store.filePath, corruptedContents, 'utf8');

    await expect(store.listRecords()).rejects.toMatchObject({
      name: 'DurableMemoryStoreError',
      code: 'CORRUPTED',
      message: 'Durable memory store is corrupted or incompatible',
    });
    expect(await readFile(store.filePath, 'utf8')).toBe(corruptedContents);
  });

  it.each([
    ['secret', `OPENAI_API_KEY=sk-proj-${'A'.repeat(32)}`],
    ['NUL', 'Synthetic\\u0000invalidation reason'],
  ])('rejects a tampered %s value in persisted invalidation history', async (_label, payload) => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory, {
      now: () => new Date(MEMORY_TIME_1),
      eventIdFactory: eventIdFactory('tampered-event'),
    });
    const record = activeMemoryRecord('tampered-history-record');
    const originalReason = 'Safe synthetic invalidation reason.';
    await store.addRecord(record, 'owner-a');
    await store.invalidateRecord(record.id, originalReason, 'owner-a');
    const validContents = await readFile(store.filePath, 'utf8');
    const tamperedContents = validContents.replace(originalReason, payload);
    expect(tamperedContents).not.toBe(validContents);
    await writeFile(store.filePath, tamperedContents, 'utf8');

    let caught: unknown;
    try {
      await store.readAuditEvents();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'DurableMemoryStoreError',
      code: 'CORRUPTED',
      message: 'Durable memory store is corrupted or incompatible',
    });
    expect(String(caught)).not.toContain(payload);
  });

  it.each([
    ['record id', 'record'],
    ['actor id', 'actor'],
  ] as const)('rejects a secret-shaped %s before persistence', async (_label, target) => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory, {
      eventIdFactory: eventIdFactory('metadata-event'),
    });
    const syntheticSecret = `sk-proj-${'A'.repeat(32)}`;
    const record = activeMemoryRecord(
      target === 'record' ? syntheticSecret : 'safe-metadata-record',
    );
    const actorId = target === 'actor' ? syntheticSecret : 'owner-a';

    let caught: unknown;
    try {
      await store.addRecord(record, actorId);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('secret safety policy');
    expect(String(caught)).not.toContain(syntheticSecret);
    expect(await store.listRecords()).toEqual([]);
  });

  it('rejects a tampered replay that crosses a supersession knowledge-zone scope', async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory, {
      eventIdFactory: eventIdFactory('scope-event'),
    });
    const target = activeMemoryRecord('scope-target', {
      zone: 'PRIVATE_KINGSHADE_DEV',
      kind: 'BASELINE_EVIDENCE',
    });
    const replacement = activeMemoryRecord('scope-replacement', {
      zone: 'PRIVATE_KINGSHADE_DEV',
      kind: 'FAILED_CANDIDATE',
      createdAt: MEMORY_TIME_1,
      updatedAt: MEMORY_TIME_1,
      supersedesRecordId: target.id,
    });
    await store.addRecord(target, 'owner-a');
    await store.addRecord(replacement, 'owner-a');

    const validContents = await readFile(store.filePath, 'utf8');
    const marker = '"zone": "PRIVATE_KINGSHADE_DEV"';
    const firstMarker = validContents.indexOf(marker);
    const replacementMarker = validContents.indexOf(marker, firstMarker + marker.length);
    expect(firstMarker).toBeGreaterThanOrEqual(0);
    expect(replacementMarker).toBeGreaterThan(firstMarker);
    const tamperedContents =
      validContents.slice(0, replacementMarker) +
      '"zone": "PUBLIC_TORN"' +
      validContents.slice(replacementMarker + marker.length);
    await writeFile(store.filePath, tamperedContents, 'utf8');

    await expect(new DurableMemoryStore(stateDirectory).listRecords()).rejects.toMatchObject({
      code: 'CORRUPTED',
      message: 'Durable memory store is corrupted or incompatible',
    });
  });

  it('treats an exact replay as a duplicate and rejects a differing same-id record', async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory, {
      eventIdFactory: eventIdFactory('duplicate-event'),
    });
    const record = activeMemoryRecord('duplicate-record', {
      subject: 'Exact duplicate evidence',
      content: 'The exact same structured Torn evidence is replayed.',
    });

    const inserted = await store.addRecord(record, 'owner-a');
    const duplicate = await store.addRecord(structuredClone(record), 'owner-a');

    expect(inserted.status).toBe('inserted');
    expect(duplicate).toMatchObject({ status: 'duplicate', record: { id: record.id } });
    expect(await store.readAuditEvents()).toHaveLength(1);

    await expect(
      store.addRecord(
        {
          ...record,
          content: 'Different content cannot reuse the durable record id.',
        },
        'owner-a',
      ),
    ).rejects.toMatchObject({
      name: 'DurableMemoryStoreError',
      code: 'ID_COLLISION',
      message: 'Durable memory record id collision',
    });
    expect(await store.listRecords()).toEqual([record]);
    expect(await store.readAuditEvents()).toHaveLength(1);
  });

  it('preserves records and append-only events through supersession and later invalidation', async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = new DurableMemoryStore(stateDirectory, {
      now: () => new Date(MEMORY_TIME_2),
      eventIdFactory: eventIdFactory('audit-event'),
    });
    const original = activeMemoryRecord('baseline-original', {
      kind: 'BASELINE_EVIDENCE',
      subject: 'Synthetic known-good baseline',
      content: 'Original baseline candidate alpha.',
    });
    const replacement = activeMemoryRecord('baseline-replacement', {
      kind: 'BASELINE_EVIDENCE',
      subject: 'Synthetic known-good baseline',
      content: 'Explicit replacement baseline candidate beta.',
      createdAt: MEMORY_TIME_1,
      updatedAt: MEMORY_TIME_1,
      supersedesRecordId: original.id,
    });

    await store.addRecord(original, 'owner-a');
    const replacementWrite = await store.addRecord(replacement, 'owner-a');
    expect(replacementWrite).toMatchObject({
      status: 'inserted',
      invalidatedRecordId: original.id,
    });

    const afterSupersession = await store.listRecords();
    expect(afterSupersession).toHaveLength(2);
    expect(afterSupersession.find((record) => record.id === original.id)).toMatchObject({
      lifecycle: {
        status: 'INVALIDATED',
        invalidatedAt: MEMORY_TIME_1,
        invalidatedByActorId: 'owner-a',
        replacementRecordId: replacement.id,
      },
    });
    expect(afterSupersession.find((record) => record.id === replacement.id)).toMatchObject({
      lifecycle: { status: 'ACTIVE' },
      supersedesRecordId: original.id,
    });

    await store.invalidateRecord(
      replacement.id,
      'Synthetic regression invalidated the replacement candidate.',
      'reviewer-a',
    );

    const reopenedStore = new DurableMemoryStore(stateDirectory);
    const reopenedRecords = await reopenedStore.listRecords();
    const auditEvents = await reopenedStore.readAuditEvents();
    expect(reopenedRecords).toHaveLength(2);
    expect(reopenedRecords.map((record) => record.lifecycle.status)).toEqual([
      'INVALIDATED',
      'INVALIDATED',
    ]);
    expect(auditEvents.map((event) => event.type)).toEqual([
      'RECORD_ADDED',
      'RECORD_ADDED',
      'RECORD_INVALIDATED',
      'RECORD_INVALIDATED',
    ]);
    expect(auditEvents[2]).toMatchObject({
      targetRecordId: original.id,
      replacementRecordId: replacement.id,
    });
    expect(auditEvents[3]).toMatchObject({
      targetRecordId: replacement.id,
      actorId: 'reviewer-a',
      reason: 'Synthetic regression invalidated the replacement candidate.',
    });
  });
});
