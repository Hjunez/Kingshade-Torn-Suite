import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_SCHEMA_VERSION,
  newMemoryRecordSchema,
  type NewMemoryRecord,
} from '../src/memory/model.js';

export const MEMORY_TIME_0 = '2026-08-24T10:00:00.000Z';
export const MEMORY_TIME_1 = '2026-08-24T11:00:00.000Z';
export const MEMORY_TIME_2 = '2026-08-24T12:00:00.000Z';

export async function createMemoryTemporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ks-leslie-memory-test-'));
}

export async function removeMemoryTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function activeMemoryRecord(
  id: string,
  overrides: Partial<NewMemoryRecord> = {},
): NewMemoryRecord {
  return newMemoryRecordSchema.parse({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id,
    projectId: 'project-alpha',
    kind: 'TEST_RESULT',
    zone: 'PUBLIC_TORN',
    contentScope: 'TORN_PROJECT',
    subject: `Synthetic memory ${id}`,
    content: `Synthetic Torn project evidence for ${id}.`,
    evidenceClassification: 'AUTOMATED_TEST',
    source: {
      kind: 'TEST_RUN',
      reference: `synthetic:${id}`,
      description: 'Synthetic deterministic test evidence.',
    },
    verificationState: 'SUPPORTING',
    createdAt: MEMORY_TIME_0,
    updatedAt: MEMORY_TIME_0,
    lifecycle: { status: 'ACTIVE' },
    ...overrides,
  });
}
