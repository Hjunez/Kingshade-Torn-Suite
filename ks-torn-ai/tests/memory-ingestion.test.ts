import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTrustedMemoryAccessContext,
  type MemoryAccessContext,
} from '../src/memory/access.js';
import {
  CuratedManifestError,
  CuratedMemoryIngestionService,
  parseCuratedMemoryManifest,
  type CuratedManifestEntry,
  type CuratedMemoryManifest,
} from '../src/memory/ingestion.js';
import { MAX_MEMORY_CONTENT_CHARS } from '../src/memory/model.js';
import { MemorySafetyError } from '../src/memory/safety.js';
import { MemoryService, type TrustedMemoryDraft } from '../src/memory/service.js';
import { DurableMemoryStore, DurableMemoryStoreError } from '../src/memory/store.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/memory/curated-manifest.synthetic.json', import.meta.url),
);
const NOW = new Date('2026-08-24T12:00:00.000Z');
const cleanupPaths: string[] = [];

const OWNER_CONTEXT = createTrustedMemoryAccessContext({
  actorId: 'owner-local',
  role: 'OWNER_DEVELOPER',
  capabilities: ['MEMORY_READ', 'MEMORY_INGEST', 'MEMORY_INVALIDATE', 'MEMORY_VERIFY_OWNER'],
  projectGrants: ['war-dibs'],
  allowedZones: ['PUBLIC_TORN', 'PRIVATE_KINGSHADE_DEV'],
  tenantGrants: [],
});

interface MemoryHarness {
  store: DurableMemoryStore;
  service: MemoryService;
  ingestion: CuratedMemoryIngestionService;
}

async function createHarness(): Promise<MemoryHarness> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'ks-leslie-memory-ingestion-test-'));
  cleanupPaths.push(stateDirectory);
  const store = new DurableMemoryStore(stateDirectory, { now: () => NOW });
  const service = new MemoryService(store, { now: () => NOW });
  return {
    store,
    service,
    ingestion: new CuratedMemoryIngestionService(service),
  };
}

async function loadFixture(): Promise<CuratedMemoryManifest> {
  return parseCuratedMemoryManifest(await readFile(FIXTURE_PATH, 'utf8'));
}

function baseEntry(overrides: Partial<CuratedManifestEntry> = {}): CuratedManifestEntry {
  return {
    id: 'synthetic-entry',
    projectId: 'war-dibs',
    kind: 'CURATED_TORN_NOTE',
    zone: 'PRIVATE_KINGSHADE_DEV',
    contentType: 'text/plain',
    contentScope: 'TORN_PROJECT',
    subject: 'Synthetic memory subject',
    content: 'Synthetic Torn project content.',
    evidenceClassification: 'COMMUNITY_DERIVED',
    sourceReference: 'synthetic:curated-source',
    sourceDescription: 'Synthetic source description for deterministic tests.',
    verificationState: 'UNVERIFIED',
    ...overrides,
  };
}

function manifest(entries: CuratedManifestEntry[]): CuratedMemoryManifest {
  return {
    format: 'ks-leslie-curated-memory',
    schemaVersion: 1,
    manifestId: 'synthetic-test-manifest',
    contentScope: 'TORN_PROJECT',
    entries,
  };
}

async function capturedError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe('curated memory manifest ingestion', () => {
  it('parses the synthetic fixture and rejects schema drift', async () => {
    const fixture = await loadFixture();

    expect(fixture.manifestId).toBe('synthetic-phase-c2-manifest');
    expect(fixture.entries).toHaveLength(2);
    expect(() =>
      parseCuratedMemoryManifest({
        ...fixture,
        unexpectedAuthority: 'OWNER_DEVELOPER',
      }),
    ).toThrow(CuratedManifestError);
    expect(() =>
      parseCuratedMemoryManifest(
        manifest([baseEntry({ contentType: 'text/plain' }), baseEntry({ id: 'bad-entry' })]),
      ),
    ).not.toThrow();
    expect(() =>
      parseCuratedMemoryManifest({
        ...manifest([baseEntry()]),
        entries: [{ ...baseEntry(), contentType: 'application/octet-stream' }],
      }),
    ).toThrow(CuratedManifestError);
  });

  it('validates a dry run without creating the durable store', async () => {
    const { ingestion, store } = await createHarness();
    const fixture = await loadFixture();

    const result = await ingestion.ingest(OWNER_CONTEXT, fixture, { dryRun: true });

    expect(result).toEqual({
      manifestId: fixture.manifestId,
      dryRun: true,
      entries: fixture.entries.map((entry) => ({
        id: entry.id,
        status: 'validated',
        storedRecordId: null,
      })),
    });
    expect(await store.listRecords()).toEqual([]);
    await expect(readFile(store.filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores one exact manifest duplicate and reports the repeated entry deterministically', async () => {
    const { ingestion, store } = await createHarness();
    const entry = baseEntry();

    const result = await ingestion.ingest(OWNER_CONTEXT, manifest([entry, { ...entry }]));

    expect(result.entries).toEqual([
      { id: entry.id, status: 'inserted', storedRecordId: entry.id },
      { id: entry.id, status: 'duplicate_manifest', storedRecordId: entry.id },
    ]);
    expect((await store.listRecords()).map((record) => record.id)).toEqual([entry.id]);
  });

  it('rejects conflicting duplicate ids before persistence', async () => {
    const { ingestion, store } = await createHarness();
    const entry = baseEntry();

    await expect(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([entry, { ...entry, content: 'A contradictory synthetic value.' }]),
      ),
    ).rejects.toThrow(CuratedManifestError);
    expect(await store.listRecords()).toEqual([]);
  });

  it('preserves the durable store id-collision behavior across manifests', async () => {
    const { ingestion } = await createHarness();
    const entry = baseEntry();
    await ingestion.ingest(OWNER_CONTEXT, manifest([entry]));

    await expect(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([{ ...entry, content: 'A different value for the existing identifier.' }]),
      ),
    ).rejects.toBeInstanceOf(DurableMemoryStoreError);
    await expect(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([{ ...entry, content: 'A different value for the existing identifier.' }]),
      ),
    ).rejects.toThrow('Durable memory record id collision');
  });

  it('reports a semantic duplicate with a different id without adding another record', async () => {
    const { ingestion, store } = await createHarness();
    const entry = baseEntry();
    await ingestion.ingest(OWNER_CONTEXT, manifest([entry]));

    const result = await ingestion.ingest(
      OWNER_CONTEXT,
      manifest([{ ...entry, id: 'synthetic-entry-alias' }]),
    );

    expect(result.entries).toEqual([
      {
        id: 'synthetic-entry-alias',
        status: 'duplicate_store',
        storedRecordId: entry.id,
      },
    ]);
    expect(await store.listRecords()).toHaveLength(1);
  });

  it('resolves a repeated manifest duplicate to its actual semantic store record', async () => {
    const { ingestion } = await createHarness();
    const existing = baseEntry({ id: 'existing-semantic-record' });
    await ingestion.ingest(OWNER_CONTEXT, manifest([existing]));
    const alias = { ...existing, id: 'manifest-semantic-alias' };

    const result = await ingestion.ingest(OWNER_CONTEXT, manifest([alias, { ...alias }]));

    expect(result.entries).toEqual([
      {
        id: alias.id,
        status: 'duplicate_store',
        storedRecordId: existing.id,
      },
      {
        id: alias.id,
        status: 'duplicate_manifest',
        storedRecordId: existing.id,
      },
    ]);
  });

  it('replays an already-applied superseding manifest idempotently', async () => {
    const { ingestion, store } = await createHarness();
    const target = baseEntry({
      id: 'supersession-target',
      kind: 'BASELINE_EVIDENCE',
      content: 'Synthetic baseline candidate before failure evidence.',
    });
    const replacement = baseEntry({
      id: 'supersession-replacement',
      kind: 'FAILED_CANDIDATE',
      content: 'Synthetic failure evidence invalidates the earlier candidate.',
      supersedesRecordId: target.id,
    });
    await ingestion.ingest(OWNER_CONTEXT, manifest([target]));
    const first = await ingestion.ingest(OWNER_CONTEXT, manifest([replacement]));
    const eventsAfterFirst = await store.readAuditEvents();

    const replay = await ingestion.ingest(OWNER_CONTEXT, manifest([replacement]));

    expect(first.entries).toEqual([
      {
        id: replacement.id,
        status: 'inserted',
        storedRecordId: replacement.id,
      },
    ]);
    expect(replay.entries).toEqual([
      {
        id: replacement.id,
        status: 'duplicate_store',
        storedRecordId: replacement.id,
      },
    ]);
    expect(await store.readAuditEvents()).toEqual(eventsAfterFirst);
  });

  it.each(['AUTOMATED_TEST', 'RELEASE_RECORD'] as const)(
    'does not let %s evidence fabricate owner verification',
    async (evidenceClassification) => {
      const { ingestion, store } = await createHarness();
      const ownerClaim = baseEntry({
        evidenceClassification,
        verificationState: 'OWNER_VERIFIED',
      });

      await expect(
        ingestion.ingest(OWNER_CONTEXT, manifest([ownerClaim]), {
          ownerVerifiedEntryIds: [ownerClaim.id],
        }),
      ).rejects.toThrow();
      expect(await store.listRecords()).toEqual([]);
    },
  );

  it('requires explicit trusted authority and evidence for owner verification', async () => {
    const { ingestion, service, store } = await createHarness();
    const withoutVerifyAuthority: MemoryAccessContext = createTrustedMemoryAccessContext({
      ...OWNER_CONTEXT,
      capabilities: ['MEMORY_INGEST'],
    });
    const draft: TrustedMemoryDraft = {
      id: 'synthetic-owner-verification',
      projectId: 'war-dibs',
      kind: 'VERIFIED_FACT',
      zone: 'PRIVATE_KINGSHADE_DEV',
      subject: 'Synthetic owner-confirmed fact',
      content: 'The synthetic owner explicitly confirmed this test-only fact.',
      evidenceClassification: 'OWNER_VERIFIED',
      source: {
        kind: 'OWNER_ARTIFACT',
        reference: 'synthetic:owner-confirmation',
        description: 'Explicit synthetic owner confirmation.',
      },
      verificationState: 'OWNER_VERIFIED',
    };
    const explicitEvidence = {
      verifiedByActorId: OWNER_CONTEXT.actorId,
      explicitEvidenceReference: draft.source.reference,
    };

    await expect(
      service.saveTrustedRecord(withoutVerifyAuthority, draft, {
        ownerVerificationEvidence: explicitEvidence,
      }),
    ).rejects.toThrow('Memory access denied');
    await expect(service.saveTrustedRecord(OWNER_CONTEXT, draft)).rejects.toThrow(
      'Owner verification requires explicit trusted evidence',
    );

    const result = await service.saveTrustedRecord(OWNER_CONTEXT, draft, {
      ownerVerificationEvidence: explicitEvidence,
    });
    expect(result.status).toBe('inserted');
    expect((await store.listRecords())[0]).toMatchObject({
      evidenceClassification: 'OWNER_VERIFIED',
      verificationState: 'OWNER_VERIFIED',
      ownerVerificationEvidence: {
        verifiedByActorId: OWNER_CONTEXT.actorId,
        evidenceReference: draft.source.reference,
      },
    });

    const curatedOwnerEntry = baseEntry({
      id: 'synthetic-curated-owner-verification',
      kind: 'VERIFIED_FACT',
      evidenceClassification: 'OWNER_VERIFIED',
      sourceReference: 'synthetic:curated-owner-confirmation',
      verificationState: 'OWNER_VERIFIED',
    });
    const curated = await ingestion.ingest(OWNER_CONTEXT, manifest([curatedOwnerEntry]), {
      ownerVerifiedEntryIds: [curatedOwnerEntry.id],
    });
    expect(curated.entries).toEqual([
      {
        id: curatedOwnerEntry.id,
        status: 'inserted',
        storedRecordId: curatedOwnerEntry.id,
      },
    ]);
    expect(
      (await store.listRecords()).find((record) => record.id === curatedOwnerEntry.id),
    ).toMatchObject({
      evidenceClassification: 'OWNER_VERIFIED',
      source: { kind: 'CURATED_MANIFEST' },
      verificationState: 'OWNER_VERIFIED',
      ownerVerificationEvidence: {
        verifiedByActorId: OWNER_CONTEXT.actorId,
        evidenceReference: curatedOwnerEntry.sourceReference,
      },
    });
  });

  it('keeps inference evidence labeled as a hypothesis', async () => {
    const { ingestion, store } = await createHarness();
    const hypothesis = baseEntry({
      id: 'synthetic-hypothesis',
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      verificationState: 'HYPOTHESIS',
    });

    await ingestion.ingest(OWNER_CONTEXT, manifest([hypothesis]));
    expect((await store.listRecords())[0]).toMatchObject({
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      verificationState: 'HYPOTHESIS',
    });

    await expect(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([
          baseEntry({
            id: 'synthetic-promoted-hypothesis',
            evidenceClassification: 'INFERENCE_HYPOTHESIS',
            verificationState: 'SUPPORTING',
          }),
        ]),
      ),
    ).rejects.toThrow();
  });

  it('does not fetch a source URL while validating or ingesting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { ingestion } = await createHarness();
    const fixture = await loadFixture();

    await ingestion.ingest(OWNER_CONTEXT, fixture, { dryRun: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('curated memory content safety', () => {
  it.each([
    ['OpenAI-shaped key', `sk-proj-${'A'.repeat(32)}`],
    ['generic API key', `api_key=${'B'.repeat(32)}`],
    ['access token', `access_token=${'C'.repeat(32)}`],
    ['password', 'password=synthetic-password-value'],
    ['cookie/session material', 'Cookie: sessionid=synthetic-session-cookie-value'],
    ['authorization header', 'Authorization: Basic SYNTHETICCREDENTIALPAYLOAD'],
    [
      'private key block',
      '-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYMATERIAL\n-----END PRIVATE KEY-----',
    ],
    ['environment-secret assignment', `SERVICE_API_KEY=${'D'.repeat(32)}`],
  ])('rejects a synthetic %s without echoing it', async (_label, syntheticSecret) => {
    const { ingestion, store } = await createHarness();
    const error = await capturedError(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([baseEntry({ content: `Synthetic credential ${syntheticSecret}` })]),
      ),
    );

    expect(error).toBeInstanceOf(MemorySafetyError);
    expect(error.message).toBe('Memory record rejected by secret safety policy');
    expect(error.message).not.toContain(syntheticSecret);
    expect(await store.listRecords()).toEqual([]);
  });

  it.each(['Synthetic NUL\0payload', 'Synthetic control\u0001payload'])(
    'rejects binary-like content without persisting it',
    async (content) => {
      const { ingestion, store } = await createHarness();

      await expect(
        ingestion.ingest(OWNER_CONTEXT, manifest([baseEntry({ content })])),
      ).rejects.toThrow('Memory record rejected by binary safety policy');
      expect(await store.listRecords()).toEqual([]);
    },
  );

  it('rejects oversized manifest content before persistence', async () => {
    const { ingestion, store } = await createHarness();
    const oversized = 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1);
    const error = await capturedError(
      ingestion.ingest(OWNER_CONTEXT, {
        ...manifest([baseEntry()]),
        entries: [{ ...baseEntry(), content: oversized }],
      }),
    );

    expect(error).toBeInstanceOf(CuratedManifestError);
    expect(error.message).not.toContain(oversized);
    expect(await store.listRecords()).toEqual([]);
  });

  it.each([
    'fixtures/.env.local',
    'fixtures/cookies.json',
    'fixtures/private-key.pem',
    'fixtures/binary-snapshot.zip',
  ])('rejects a forbidden source reference: %s', async (sourceReference) => {
    const { ingestion, store } = await createHarness();

    await expect(
      ingestion.ingest(OWNER_CONTEXT, manifest([baseEntry({ sourceReference })])),
    ).rejects.toThrow(CuratedManifestError);
    expect(await store.listRecords()).toEqual([]);
  });

  it('rejects obvious unrelated personal-data categories', async () => {
    const { ingestion, store } = await createHarness();
    const error = await capturedError(
      ingestion.ingest(
        OWNER_CONTEXT,
        manifest([baseEntry({ content: 'Synthetic patient diagnosis outside Torn scope.' })]),
      ),
    );

    expect(error).toBeInstanceOf(MemorySafetyError);
    expect(error.message).toBe('Memory record rejected by personal_data safety policy');
    expect(error.message).not.toContain('patient diagnosis');
    expect(await store.listRecords()).toEqual([]);
  });
});
