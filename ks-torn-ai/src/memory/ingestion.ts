import { z } from 'zod';

import { requireMemoryCapability, type MemoryAccessContext } from './access.js';
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_SOURCE_CHARS,
  MAX_MEMORY_SUBJECT_CHARS,
  MEMORY_SCHEMA_VERSION,
  evidenceClassificationSchema,
  knowledgeZoneSchema,
  memoryActorIdSchema,
  memoryProjectIdSchema,
  memoryRecordIdSchema,
  memoryRecordKindSchema,
  verificationStateSchema,
} from './model.js';
import {
  MemoryService,
  type TrustedMemoryDraft,
  type TrustedMemoryWriteOptions,
} from './service.js';
import { validateMemoryMetadataSafety } from './safety.js';

const MAX_MANIFEST_ENTRIES = 200;
const FORBIDDEN_SOURCE_REFERENCE =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|cookies?(?:\.[^/\\]+)?|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|[^/\\]+\.(?:pem|key|p12|pfx|sqlite|db|exe|dll|zip))$/i;

export const curatedManifestEntrySchema = z
  .object({
    id: memoryRecordIdSchema,
    projectId: memoryProjectIdSchema,
    kind: memoryRecordKindSchema,
    zone: knowledgeZoneSchema,
    ownerId: memoryActorIdSchema.optional(),
    tenantId: memoryActorIdSchema.optional(),
    contentType: z.literal('text/plain'),
    contentScope: z.literal('TORN_PROJECT'),
    subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
    content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
    evidenceClassification: evidenceClassificationSchema,
    sourceReference: z
      .string()
      .min(1)
      .max(MAX_MEMORY_SOURCE_CHARS)
      .refine((value) => !FORBIDDEN_SOURCE_REFERENCE.test(value)),
    sourceDescription: z.string().min(1).max(MAX_MEMORY_SOURCE_CHARS),
    verificationState: verificationStateSchema,
    supersedesRecordId: memoryRecordIdSchema.optional(),
  })
  .strict();

export const curatedMemoryManifestSchema = z
  .object({
    format: z.literal('ks-leslie-curated-memory'),
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    manifestId: memoryRecordIdSchema,
    contentScope: z.literal('TORN_PROJECT'),
    entries: z.array(curatedManifestEntrySchema).min(1).max(MAX_MANIFEST_ENTRIES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const entriesById = new Map<string, string>();
    for (const entry of manifest.entries) {
      const serialized = JSON.stringify(entry);
      const previous = entriesById.get(entry.id);
      if (previous !== undefined && previous !== serialized) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: 'Manifest contains a conflicting record id collision',
        });
      }
      entriesById.set(entry.id, serialized);
    }
  });

export type CuratedMemoryManifest = z.infer<typeof curatedMemoryManifestSchema>;
export type CuratedManifestEntry = z.infer<typeof curatedManifestEntrySchema>;

export interface CuratedIngestionOptions {
  dryRun?: boolean;
  ownerVerifiedEntryIds?: readonly string[];
}

export interface CuratedIngestionEntryResult {
  id: string;
  status: 'validated' | 'inserted' | 'duplicate_manifest' | 'duplicate_store';
  storedRecordId: string | null;
}

export interface CuratedIngestionResult {
  manifestId: string;
  dryRun: boolean;
  entries: CuratedIngestionEntryResult[];
}

export class CuratedManifestError extends Error {
  constructor(message = 'Curated memory manifest is invalid or unsafe') {
    super(message);
    this.name = 'CuratedManifestError';
  }
}

export function parseCuratedMemoryManifest(input: unknown): CuratedMemoryManifest {
  try {
    const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    const parsed = curatedMemoryManifestSchema.safeParse(value);
    if (!parsed.success) {
      throw new CuratedManifestError();
    }
    validateMemoryMetadataSafety(parsed.data.manifestId);
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof CuratedManifestError) {
      throw error;
    }
    throw new CuratedManifestError();
  }
}

function draftFromEntry(entry: CuratedManifestEntry): TrustedMemoryDraft {
  return {
    id: entry.id,
    projectId: entry.projectId,
    kind: entry.kind,
    zone: entry.zone,
    ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
    ...(entry.tenantId === undefined ? {} : { tenantId: entry.tenantId }),
    subject: entry.subject,
    content: entry.content,
    evidenceClassification: entry.evidenceClassification,
    source: {
      kind: 'CURATED_MANIFEST',
      reference: entry.sourceReference,
      description: entry.sourceDescription,
    },
    verificationState: entry.verificationState,
    ...(entry.supersedesRecordId === undefined
      ? {}
      : { supersedesRecordId: entry.supersedesRecordId }),
  };
}

function writeOptionsForEntry(
  context: MemoryAccessContext,
  entry: CuratedManifestEntry,
  ownerVerifiedEntryIds: ReadonlySet<string>,
): TrustedMemoryWriteOptions {
  if (!ownerVerifiedEntryIds.has(entry.id)) {
    return {};
  }
  if (entry.evidenceClassification !== 'OWNER_VERIFIED') {
    throw new CuratedManifestError(
      'Trusted owner-verification evidence may only target owner-verified entries',
    );
  }
  return {
    ownerVerificationEvidence: {
      verifiedByActorId: context.actorId,
      explicitEvidenceReference: entry.sourceReference,
    },
  };
}

export class CuratedMemoryIngestionService {
  readonly #memory: MemoryService;

  constructor(memory: MemoryService) {
    this.#memory = memory;
  }

  async ingest(
    contextInput: MemoryAccessContext | null | undefined,
    manifestInput: unknown,
    options: CuratedIngestionOptions = {},
  ): Promise<CuratedIngestionResult> {
    const context = requireMemoryCapability(contextInput, 'MEMORY_INGEST');
    const manifest = parseCuratedMemoryManifest(manifestInput);
    const ownerVerifiedEntryIds = new Set(options.ownerVerifiedEntryIds ?? []);
    const manifestIds = new Set(manifest.entries.map((entry) => entry.id));
    if (
      ownerVerifiedEntryIds.size !== (options.ownerVerifiedEntryIds?.length ?? 0) ||
      [...ownerVerifiedEntryIds].some((entryId) => !manifestIds.has(entryId))
    ) {
      throw new CuratedManifestError('Trusted owner-verification entry selection is invalid');
    }

    const uniqueEntries: CuratedManifestEntry[] = [];
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    for (const entry of manifest.entries) {
      if (seenIds.has(entry.id)) {
        duplicateIds.add(entry.id);
      } else {
        seenIds.add(entry.id);
        uniqueEntries.push(entry);
      }
    }

    // Validate every entry through the same memory service before making the first durable write.
    for (const entry of uniqueEntries) {
      await this.#memory.validateTrustedRecord(
        context,
        draftFromEntry(entry),
        writeOptionsForEntry(context, entry, ownerVerifiedEntryIds),
      );
    }

    const results: CuratedIngestionEntryResult[] = [];
    const storedRecordIds = new Map<string, string>();
    for (const entry of uniqueEntries) {
      if (options.dryRun === true) {
        results.push({ id: entry.id, status: 'validated', storedRecordId: null });
        continue;
      }
      const result = await this.#memory.saveTrustedRecord(
        context,
        draftFromEntry(entry),
        writeOptionsForEntry(context, entry, ownerVerifiedEntryIds),
      );
      storedRecordIds.set(entry.id, result.record.id);
      results.push({
        id: entry.id,
        status: result.status === 'inserted' ? 'inserted' : 'duplicate_store',
        storedRecordId: result.record.id,
      });
    }
    for (const duplicateId of duplicateIds) {
      results.push({
        id: duplicateId,
        status: 'duplicate_manifest',
        storedRecordId: options.dryRun === true ? null : (storedRecordIds.get(duplicateId) ?? null),
      });
    }

    return {
      manifestId: manifest.manifestId,
      dryRun: options.dryRun === true,
      entries: results,
    };
  }
}
