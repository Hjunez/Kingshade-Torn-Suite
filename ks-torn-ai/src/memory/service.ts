import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  canReadMemoryRecord,
  createTrustedMemoryAccessContext,
  requireMemoryCapability,
  requireMemoryRecordScope,
  type MemoryAccessContext,
} from './access.js';
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
  memorySourceSchema,
  newMemoryRecordSchema,
  verificationStateSchema,
  type KnowledgeZone,
  type MemoryRecord,
} from './model.js';
import { validateMemoryRecordSafety } from './safety.js';
import { DurableMemoryStore, type MemoryStoreWriteResult } from './store.js';

export const MAX_MEMORY_RETRIEVAL_RESULTS = 8;
export const MAX_RETRIEVED_CONTENT_CHARS = 2_000;
export const MAX_RETRIEVED_SOURCE_CHARS = 500;

export const memoryRetrievalRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    kinds: z.array(memoryRecordKindSchema).max(7).optional(),
    limit: z.number().int().min(1).max(MAX_MEMORY_RETRIEVAL_RESULTS).default(5),
  })
  .strict();

export const trustedMemoryDraftSchema = z
  .object({
    id: memoryRecordIdSchema,
    projectId: memoryProjectIdSchema,
    kind: memoryRecordKindSchema,
    zone: knowledgeZoneSchema,
    ownerId: memoryActorIdSchema.optional(),
    tenantId: memoryActorIdSchema.optional(),
    subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
    content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
    evidenceClassification: evidenceClassificationSchema,
    source: memorySourceSchema,
    verificationState: verificationStateSchema,
    supersedesRecordId: memoryRecordIdSchema.optional(),
  })
  .strict();

export const pendingMemoryProposalSchema = z
  .object({
    kind: memoryRecordKindSchema,
    subject: z.string().trim().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
    content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_CHARS),
    sourceDescription: z.string().trim().min(1).max(MAX_MEMORY_SOURCE_CHARS),
  })
  .strict();

export const boundMemoryScopeSchema = z
  .object({
    projectId: memoryProjectIdSchema,
    zone: knowledgeZoneSchema,
    ownerId: memoryActorIdSchema.optional(),
    tenantId: memoryActorIdSchema.optional(),
    sourceReference: z.string().min(1).max(MAX_MEMORY_SOURCE_CHARS),
  })
  .strict();

export interface TrustedOwnerVerificationEvidence {
  verifiedByActorId: string;
  explicitEvidenceReference: string;
}

export interface TrustedMemoryWriteOptions {
  ownerVerificationEvidence?: TrustedOwnerVerificationEvidence;
}

export type MemoryRetrievalRequest = z.input<typeof memoryRetrievalRequestSchema>;
export type TrustedMemoryDraft = z.infer<typeof trustedMemoryDraftSchema>;
export type PendingMemoryProposal = z.infer<typeof pendingMemoryProposalSchema>;
export type BoundMemoryScope = z.infer<typeof boundMemoryScopeSchema>;

export interface RetrievedMemoryRecord {
  id: string;
  projectId: string;
  kind: MemoryRecord['kind'];
  zone: KnowledgeZone;
  subject: string;
  content: string;
  evidenceClassification: MemoryRecord['evidenceClassification'];
  verificationState: MemoryRecord['verificationState'];
  sourceReference: string;
  sourceDescription: string;
  createdAt: string;
  updatedAt: string;
  lifecycleStatus: 'ACTIVE';
  supersedesRecordId: string | null;
  conflictingRecordIds: string[];
  relevanceScore: number;
}

export interface MemoryRetrievalResult {
  authorizationAppliedBeforeRanking: true;
  records: RetrievedMemoryRecord[];
  truncated: boolean;
}

export interface PendingMemoryProposalResult {
  status: 'pending_review';
  proposalId: string;
  projectId: string;
  zone: KnowledgeZone;
  evidenceClassification: 'INFERENCE_HYPOTHESIS';
  verificationState: 'HYPOTHESIS';
  lifecycleStatus: 'PENDING';
  duplicateOfRecordId: string | null;
}

export interface MemoryServiceOptions {
  now?: () => Date;
  recordIdFactory?: () => string;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function compareStableIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(value)
        .split(/[^a-z0-9]+/u)
        .filter(Boolean),
    ),
  ];
}

function scoreRecord(record: MemoryRecord, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const subject = normalizeSearchText(record.subject);
  const content = normalizeSearchText(record.content);
  const source = normalizeSearchText(
    `${record.source.reference} ${record.source.description} ${record.kind}`,
  );
  let score = 0;
  if (subject.includes(normalizedQuery)) score += 30;
  if (content.includes(normalizedQuery)) score += 20;
  for (const token of searchTokens(query)) {
    if (subject.includes(token)) score += 8;
    if (content.includes(token)) score += 3;
    if (source.includes(token)) score += 1;
  }
  return score;
}

function sameConflictSubject(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    left.id !== right.id &&
    left.projectId === right.projectId &&
    left.kind === right.kind &&
    normalizeSearchText(left.subject) === normalizeSearchText(right.subject) &&
    left.content !== right.content
  );
}

function toRetrievedRecord(
  record: MemoryRecord,
  score: number,
  authorizedActiveRecords: readonly MemoryRecord[],
): RetrievedMemoryRecord {
  if (record.lifecycle.status !== 'ACTIVE') {
    throw new Error('Memory retrieval lifecycle invariant failed');
  }
  const conflictingRecordIds = authorizedActiveRecords
    .filter(
      (candidate) =>
        candidate.lifecycle.status === 'ACTIVE' && sameConflictSubject(record, candidate),
    )
    .map((candidate) => candidate.id)
    .sort(compareStableIdentifiers)
    .slice(0, 20);
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind,
    zone: record.zone,
    subject: record.subject,
    content: record.content.slice(0, MAX_RETRIEVED_CONTENT_CHARS),
    evidenceClassification: record.evidenceClassification,
    verificationState: record.verificationState,
    sourceReference: record.source.reference.slice(0, MAX_RETRIEVED_SOURCE_CHARS),
    sourceDescription: record.source.description.slice(0, MAX_RETRIEVED_SOURCE_CHARS),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lifecycleStatus: 'ACTIVE',
    supersedesRecordId: record.supersedesRecordId ?? null,
    conflictingRecordIds,
    relevanceScore: score,
  };
}

export class MemoryService {
  readonly #store: DurableMemoryStore;
  readonly #now: () => Date;
  readonly #recordIdFactory: () => string;

  constructor(store: DurableMemoryStore, options: MemoryServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#recordIdFactory = options.recordIdFactory ?? randomUUID;
  }

  get store(): DurableMemoryStore {
    return this.#store;
  }

  async retrieve(
    context: MemoryAccessContext | null | undefined,
    requestInput: MemoryRetrievalRequest,
  ): Promise<MemoryRetrievalResult> {
    const trusted = requireMemoryCapability(context, 'MEMORY_READ');
    const request = memoryRetrievalRequestSchema.parse(requestInput);
    const allRecords = await this.#store.listRecords();

    // This filter is intentionally complete before any scoring, sorting, counting, or summary.
    const authorizedActiveRecords = allRecords.filter(
      (record) => record.lifecycle.status === 'ACTIVE' && canReadMemoryRecord(trusted, record),
    );
    const kindFiltered =
      request.kinds === undefined
        ? authorizedActiveRecords
        : authorizedActiveRecords.filter((record) => request.kinds?.includes(record.kind) === true);
    const ranked = kindFiltered
      .map((record) => ({ record, score: scoreRecord(record, request.query) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        const scoreDifference = right.score - left.score;
        return scoreDifference === 0
          ? compareStableIdentifiers(left.record.id, right.record.id)
          : scoreDifference;
      });
    const selected = ranked.slice(0, request.limit);

    return {
      authorizationAppliedBeforeRanking: true,
      records: selected.map(({ record, score }) =>
        toRetrievedRecord(record, score, authorizedActiveRecords),
      ),
      truncated: ranked.length > selected.length,
    };
  }

  #prepareTrustedRecord(
    context: MemoryAccessContext | null | undefined,
    draftInput: TrustedMemoryDraft,
    options: TrustedMemoryWriteOptions = {},
  ) {
    const trusted = requireMemoryCapability(context, 'MEMORY_INGEST');
    const draft = trustedMemoryDraftSchema.parse(draftInput);
    const evidence = options.ownerVerificationEvidence;
    if (draft.verificationState === 'OWNER_VERIFIED' && evidence === undefined) {
      throw new Error('Owner verification requires explicit trusted evidence');
    }
    if (draft.verificationState !== 'OWNER_VERIFIED' && evidence !== undefined) {
      throw new Error('Owner-verification evidence was supplied for a non-owner-verified record');
    }
    const now = this.#now().toISOString();
    const record = newMemoryRecordSchema.parse({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      ...draft,
      contentScope: 'TORN_PROJECT',
      createdAt: now,
      updatedAt: now,
      lifecycle: { status: 'ACTIVE' },
      ...(evidence === undefined
        ? {}
        : {
            ownerVerificationEvidence: {
              verifiedByActorId: evidence.verifiedByActorId,
              evidenceReference: evidence.explicitEvidenceReference,
            },
          }),
    });
    requireMemoryRecordScope(trusted, 'MEMORY_INGEST', record);
    validateMemoryRecordSafety(record);

    if (record.verificationState === 'OWNER_VERIFIED') {
      requireMemoryCapability(trusted, 'MEMORY_VERIFY_OWNER');
      if (
        evidence === undefined ||
        evidence.verifiedByActorId !== trusted.actorId ||
        evidence.explicitEvidenceReference !== record.source.reference ||
        !['OWNER_ARTIFACT', 'CURATED_MANIFEST'].includes(record.source.kind)
      ) {
        throw new Error('Owner verification requires explicit trusted evidence');
      }
    }

    return { trusted, record };
  }

  async #requireSupersessionAuthorization(
    context: MemoryAccessContext,
    record: MemoryRecord,
  ): Promise<void> {
    if (record.supersedesRecordId === undefined) {
      return;
    }
    requireMemoryCapability(context, 'MEMORY_INVALIDATE');
    const target = (await this.#store.listRecords()).find(
      (candidate) => candidate.id === record.supersedesRecordId,
    );
    if (target === undefined) {
      throw new Error('Superseded durable memory record is unavailable');
    }
    requireMemoryRecordScope(context, 'MEMORY_INVALIDATE', target);
  }

  async validateTrustedRecord(
    context: MemoryAccessContext | null | undefined,
    draftInput: TrustedMemoryDraft,
    options: TrustedMemoryWriteOptions = {},
  ): Promise<void> {
    const { trusted, record } = this.#prepareTrustedRecord(context, draftInput, options);
    await this.#requireSupersessionAuthorization(trusted, record);
  }

  async saveTrustedRecord(
    context: MemoryAccessContext | null | undefined,
    draftInput: TrustedMemoryDraft,
    options: TrustedMemoryWriteOptions = {},
  ): Promise<MemoryStoreWriteResult> {
    const { trusted, record } = this.#prepareTrustedRecord(context, draftInput, options);
    await this.#requireSupersessionAuthorization(trusted, record);

    return await this.#store.addRecord(record, trusted.actorId);
  }

  async proposePendingRecord(
    context: MemoryAccessContext | null | undefined,
    scopeInput: BoundMemoryScope,
    proposalInput: PendingMemoryProposal,
  ): Promise<PendingMemoryProposalResult> {
    const trusted = requireMemoryCapability(context, 'MEMORY_PROPOSE');
    const scope = boundMemoryScopeSchema.parse(scopeInput);
    const proposal = pendingMemoryProposalSchema.parse(proposalInput);
    const now = this.#now().toISOString();
    const proposalId = `proposal-${this.#recordIdFactory()}`;
    const record = newMemoryRecordSchema.parse({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id: proposalId,
      projectId: scope.projectId,
      kind: proposal.kind,
      zone: scope.zone,
      ...(scope.ownerId === undefined ? {} : { ownerId: scope.ownerId }),
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      contentScope: 'TORN_PROJECT',
      subject: proposal.subject,
      content: proposal.content,
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      source: {
        kind: 'MODEL_PROPOSAL',
        reference: scope.sourceReference,
        description: proposal.sourceDescription,
      },
      verificationState: 'HYPOTHESIS',
      createdAt: now,
      updatedAt: now,
      lifecycle: { status: 'PENDING' },
    });
    requireMemoryRecordScope(trusted, 'MEMORY_PROPOSE', record);
    validateMemoryRecordSafety(record);
    const result = await this.#store.addRecord(record, trusted.actorId);
    return {
      status: 'pending_review',
      proposalId: result.record.id,
      projectId: result.record.projectId,
      zone: result.record.zone,
      evidenceClassification: 'INFERENCE_HYPOTHESIS',
      verificationState: 'HYPOTHESIS',
      lifecycleStatus: 'PENDING',
      duplicateOfRecordId: result.duplicateOfRecordId ?? null,
    };
  }

  async invalidateTrustedRecord(
    context: MemoryAccessContext | null | undefined,
    recordId: string,
    reason: string,
  ): Promise<MemoryRecord> {
    const trusted = requireMemoryCapability(context, 'MEMORY_INVALIDATE');
    const records = await this.#store.listRecords();
    const record = records.find((candidate) => candidate.id === recordId);
    if (record === undefined) {
      throw new Error('Durable memory record was not found');
    }
    requireMemoryRecordScope(trusted, 'MEMORY_INVALIDATE', record);
    return await this.#store.invalidateRecord(record.id, reason, trusted.actorId);
  }
}

export class AuthorizedMemoryReader {
  readonly #service: MemoryService;
  readonly #context: MemoryAccessContext;

  constructor(service: MemoryService, context: MemoryAccessContext) {
    this.#service = service;
    this.#context = createTrustedMemoryAccessContext(context);
  }

  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    return await this.#service.retrieve(this.#context, request);
  }
}

export class PendingMemoryWriter {
  readonly #service: MemoryService;
  readonly #context: MemoryAccessContext;
  readonly #scope: BoundMemoryScope;

  constructor(service: MemoryService, context: MemoryAccessContext, scope: BoundMemoryScope) {
    this.#service = service;
    this.#context = createTrustedMemoryAccessContext(context);
    this.#scope = boundMemoryScopeSchema.parse(scope);
  }

  async propose(proposal: PendingMemoryProposal): Promise<PendingMemoryProposalResult> {
    return await this.#service.proposePendingRecord(this.#context, this.#scope, proposal);
  }
}
