import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import {
  MAX_MEMORY_RECORDS,
  MEMORY_SCHEMA_VERSION,
  memoryActorIdSchema,
  memoryRecordIdSchema,
  memoryRecordSchema,
  memoryTimestampSchema,
  newMemoryRecordSchema,
  type MemoryRecord,
  type NewMemoryRecord,
} from './model.js';
import {
  validateMemoryInvalidationReason,
  validateMemoryMetadataSafety,
  validateMemoryRecordSafety,
} from './safety.js';

const MEMORY_FILE_NAME = 'memory-v1.json';
const MEMORY_FILE_FORMAT = 'ks-leslie-memory-event-store' as const;
const MAX_MEMORY_EVENTS = MAX_MEMORY_RECORDS * 2;
const MAX_MEMORY_STORE_BYTES = 64 * 1024 * 1024;

const recordAddedEventSchema = z
  .object({
    eventId: memoryRecordIdSchema,
    type: z.literal('RECORD_ADDED'),
    occurredAt: memoryTimestampSchema,
    actorId: memoryActorIdSchema,
    record: newMemoryRecordSchema,
  })
  .strict();

const recordInvalidatedEventSchema = z
  .object({
    eventId: memoryRecordIdSchema,
    type: z.literal('RECORD_INVALIDATED'),
    occurredAt: memoryTimestampSchema,
    actorId: memoryActorIdSchema,
    targetRecordId: memoryRecordIdSchema,
    reason: z.string().min(1).max(500),
    replacementRecordId: memoryRecordIdSchema.optional(),
  })
  .strict();

export const memoryStoreEventSchema = z.discriminatedUnion('type', [
  recordAddedEventSchema,
  recordInvalidatedEventSchema,
]);

const memoryStoreFileSchema = z
  .object({
    format: z.literal(MEMORY_FILE_FORMAT),
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    events: z.array(memoryStoreEventSchema).max(MAX_MEMORY_EVENTS),
  })
  .strict();

export type MemoryStoreEvent = z.infer<typeof memoryStoreEventSchema>;

interface LoadedState {
  events: MemoryStoreEvent[];
  records: Map<string, MemoryRecord>;
  originalRecords: Map<string, NewMemoryRecord>;
}

export interface DurableMemoryStoreOptions {
  now?: () => Date;
  eventIdFactory?: () => string;
}

export interface MemoryStoreWriteResult {
  status: 'inserted' | 'duplicate';
  record: MemoryRecord;
  duplicateOfRecordId?: string;
  invalidatedRecordId?: string;
}

export class DurableMemoryStoreError extends Error {
  readonly code:
    | 'CORRUPTED'
    | 'ID_COLLISION'
    | 'DUPLICATE_LIMIT'
    | 'INVALID_TRANSITION'
    | 'NOT_FOUND'
    | 'WRITE_FAILED';

  constructor(code: DurableMemoryStoreError['code']) {
    const messages: Record<DurableMemoryStoreError['code'], string> = {
      CORRUPTED: 'Durable memory store is corrupted or incompatible',
      ID_COLLISION: 'Durable memory record id collision',
      DUPLICATE_LIMIT: 'Durable memory store limit reached',
      INVALID_TRANSITION: 'Durable memory lifecycle transition is invalid',
      NOT_FOUND: 'Durable memory record was not found',
      WRITE_FAILED: 'Durable memory store write failed',
    };
    super(messages[code]);
    this.name = 'DurableMemoryStoreError';
    this.code = code;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function emptyStoreFile(): z.infer<typeof memoryStoreFileSchema> {
  return {
    format: MEMORY_FILE_FORMAT,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    events: [],
  };
}

function hasSameAuthorizationScope(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    left.projectId === right.projectId &&
    left.zone === right.zone &&
    left.ownerId === right.ownerId &&
    left.tenantId === right.tenantId
  );
}

function materializeStore(events: readonly MemoryStoreEvent[]): LoadedState {
  const records = new Map<string, MemoryRecord>();
  const originalRecords = new Map<string, NewMemoryRecord>();
  const eventIds = new Set<string>();

  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      throw new DurableMemoryStoreError('CORRUPTED');
    }
    eventIds.add(event.eventId);
    try {
      validateMemoryMetadataSafety(event.eventId);
      validateMemoryMetadataSafety(event.actorId);
      if (event.type === 'RECORD_INVALIDATED') {
        validateMemoryMetadataSafety(event.targetRecordId);
        if (event.replacementRecordId !== undefined) {
          validateMemoryMetadataSafety(event.replacementRecordId);
        }
      }
    } catch {
      throw new DurableMemoryStoreError('CORRUPTED');
    }

    if (event.type === 'RECORD_ADDED') {
      if (records.has(event.record.id)) {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
      const parsed = newMemoryRecordSchema.safeParse(event.record);
      if (!parsed.success) {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
      try {
        validateMemoryRecordSafety(parsed.data);
      } catch {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
      records.set(parsed.data.id, memoryRecordSchema.parse(parsed.data));
      originalRecords.set(parsed.data.id, parsed.data);
      continue;
    }

    const target = records.get(event.targetRecordId);
    if (target === undefined || target.lifecycle.status === 'INVALIDATED') {
      throw new DurableMemoryStoreError('CORRUPTED');
    }
    try {
      validateMemoryInvalidationReason(event.reason);
    } catch {
      throw new DurableMemoryStoreError('CORRUPTED');
    }
    if (event.replacementRecordId !== undefined) {
      const replacement = records.get(event.replacementRecordId);
      if (
        replacement === undefined ||
        !hasSameAuthorizationScope(replacement, target) ||
        replacement.supersedesRecordId !== target.id
      ) {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
    }
    const invalidated = memoryRecordSchema.safeParse({
      ...target,
      updatedAt: event.occurredAt,
      lifecycle: {
        status: 'INVALIDATED',
        invalidatedAt: event.occurredAt,
        invalidatedByActorId: event.actorId,
        reason: event.reason,
        ...(event.replacementRecordId === undefined
          ? {}
          : { replacementRecordId: event.replacementRecordId }),
      },
    });
    if (!invalidated.success) {
      throw new DurableMemoryStoreError('CORRUPTED');
    }
    records.set(target.id, invalidated.data);
  }

  for (const record of originalRecords.values()) {
    if (record.supersedesRecordId === undefined) {
      continue;
    }
    const superseded = records.get(record.supersedesRecordId);
    if (
      superseded?.lifecycle.status !== 'INVALIDATED' ||
      superseded.lifecycle.replacementRecordId !== record.id
    ) {
      throw new DurableMemoryStoreError('CORRUPTED');
    }
  }

  return { events: [...events], records, originalRecords };
}

function semanticFingerprint(record: NewMemoryRecord): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => key !== 'id' && key !== 'createdAt' && key !== 'updatedAt',
      ),
    ),
  );
}

export class DurableMemoryStore {
  readonly #filePath: string;
  readonly #now: () => Date;
  readonly #eventIdFactory: () => string;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string, options: DurableMemoryStoreOptions = {}) {
    if (stateDirectory.trim().length === 0) {
      throw new DurableMemoryStoreError('WRITE_FAILED');
    }
    this.#filePath = join(stateDirectory, MEMORY_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#eventIdFactory = options.eventIdFactory ?? randomUUID;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async #load(): Promise<LoadedState> {
    try {
      const metadata = await stat(this.#filePath);
      if (!metadata.isFile() || metadata.size > MAX_MEMORY_STORE_BYTES) {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
      const raw = await readFile(this.#filePath, 'utf8');
      const parsedJson: unknown = JSON.parse(raw);
      const parsed = memoryStoreFileSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new DurableMemoryStoreError('CORRUPTED');
      }
      return materializeStore(parsed.data.events);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return materializeStore([]);
      }
      if (error instanceof DurableMemoryStoreError) {
        throw error;
      }
      throw new DurableMemoryStoreError('CORRUPTED');
    }
  }

  async #write(events: readonly MemoryStoreEvent[]): Promise<void> {
    materializeStore(events);
    const parsed = memoryStoreFileSchema.safeParse({
      ...emptyStoreFile(),
      events,
    });
    if (!parsed.success) {
      throw new DurableMemoryStoreError('DUPLICATE_LIMIT');
    }
    const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_STORE_BYTES) {
      throw new DurableMemoryStoreError('DUPLICATE_LIMIT');
    }

    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid.toString()}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#filePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new DurableMemoryStoreError('WRITE_FAILED');
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async listRecords(): Promise<MemoryRecord[]> {
    const state = await this.#load();
    return [...state.records.values()].map((record) => structuredClone(record));
  }

  async readAuditEvents(): Promise<MemoryStoreEvent[]> {
    const state = await this.#load();
    return structuredClone(state.events);
  }

  async addRecord(recordInput: NewMemoryRecord, actorId: string): Promise<MemoryStoreWriteResult> {
    return await this.#mutate(async () => {
      const recordResult = newMemoryRecordSchema.safeParse(recordInput);
      const actorResult = memoryActorIdSchema.safeParse(actorId);
      if (!recordResult.success || !actorResult.success) {
        throw new DurableMemoryStoreError('INVALID_TRANSITION');
      }
      const record = recordResult.data;
      validateMemoryRecordSafety(record);
      validateMemoryMetadataSafety(actorResult.data);
      const state = await this.#load();
      const originalWithId = state.originalRecords.get(record.id);
      if (originalWithId !== undefined) {
        if (semanticFingerprint(originalWithId) === semanticFingerprint(record)) {
          const existing = state.records.get(record.id);
          if (existing === undefined) {
            throw new DurableMemoryStoreError('CORRUPTED');
          }
          return { status: 'duplicate', record: structuredClone(existing) };
        }
        throw new DurableMemoryStoreError('ID_COLLISION');
      }

      const fingerprint = semanticFingerprint(record);
      for (const [existingId, existing] of state.originalRecords) {
        if (semanticFingerprint(existing) === fingerprint) {
          const materialized = state.records.get(existingId);
          if (materialized === undefined) {
            throw new DurableMemoryStoreError('CORRUPTED');
          }
          return {
            status: 'duplicate',
            record: structuredClone(materialized),
            duplicateOfRecordId: existingId,
          };
        }
      }

      if (state.originalRecords.size >= MAX_MEMORY_RECORDS) {
        throw new DurableMemoryStoreError('DUPLICATE_LIMIT');
      }

      let superseded: MemoryRecord | undefined;
      if (record.supersedesRecordId !== undefined) {
        superseded = state.records.get(record.supersedesRecordId);
        if (
          superseded === undefined ||
          superseded.lifecycle.status === 'INVALIDATED' ||
          !hasSameAuthorizationScope(superseded, record) ||
          Date.parse(record.createdAt) < Date.parse(superseded.updatedAt) ||
          record.lifecycle.status !== 'ACTIVE'
        ) {
          throw new DurableMemoryStoreError('INVALID_TRANSITION');
        }
      }

      const events: MemoryStoreEvent[] = [
        ...state.events,
        {
          eventId: this.#eventIdFactory(),
          type: 'RECORD_ADDED',
          occurredAt: record.createdAt,
          actorId: actorResult.data,
          record,
        },
      ];
      if (superseded !== undefined) {
        events.push({
          eventId: this.#eventIdFactory(),
          type: 'RECORD_INVALIDATED',
          occurredAt: record.createdAt,
          actorId: actorResult.data,
          targetRecordId: superseded.id,
          reason: 'Superseded by an explicitly linked durable memory record.',
          replacementRecordId: record.id,
        });
      }
      await this.#write(events);
      return {
        status: 'inserted',
        record: memoryRecordSchema.parse(record),
        ...(superseded === undefined ? {} : { invalidatedRecordId: superseded.id }),
      };
    });
  }

  async invalidateRecord(recordId: string, reason: string, actorId: string): Promise<MemoryRecord> {
    return await this.#mutate(async () => {
      const recordIdResult = memoryRecordIdSchema.safeParse(recordId);
      const actorResult = memoryActorIdSchema.safeParse(actorId);
      if (!recordIdResult.success || !actorResult.success) {
        throw new DurableMemoryStoreError('INVALID_TRANSITION');
      }
      validateMemoryInvalidationReason(reason);
      validateMemoryMetadataSafety(actorResult.data);
      const state = await this.#load();
      const record = state.records.get(recordIdResult.data);
      if (record === undefined) {
        throw new DurableMemoryStoreError('NOT_FOUND');
      }
      if (record.lifecycle.status === 'INVALIDATED') {
        throw new DurableMemoryStoreError('INVALID_TRANSITION');
      }
      const occurredAt = this.#now().toISOString();
      const event: MemoryStoreEvent = {
        eventId: this.#eventIdFactory(),
        type: 'RECORD_INVALIDATED',
        occurredAt,
        actorId: actorResult.data,
        targetRecordId: record.id,
        reason,
      };
      await this.#write([...state.events, event]);
      return memoryRecordSchema.parse({
        ...record,
        updatedAt: occurredAt,
        lifecycle: {
          status: 'INVALIDATED',
          invalidatedAt: occurredAt,
          invalidatedByActorId: actorResult.data,
          reason,
        },
      });
    });
  }
}
