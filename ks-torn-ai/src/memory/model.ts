import { z } from 'zod';

export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MAX_MEMORY_RECORDS = 10_000;
export const MAX_MEMORY_CONTENT_CHARS = 4_000;
export const MAX_MEMORY_SOURCE_CHARS = 1_000;
export const MAX_MEMORY_SUBJECT_CHARS = 240;
export const MAX_MEMORY_INVALIDATION_REASON_CHARS = 500;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const projectIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const memoryTimestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, 'Timestamp must be canonical ISO-8601 UTC');

export const memoryRecordIdSchema = identifierSchema;
export const memoryProjectIdSchema = projectIdentifierSchema;
export const memoryActorIdSchema = identifierSchema;
export const memoryTenantIdSchema = identifierSchema;

export const knowledgeZoneSchema = z.enum([
  'PUBLIC_TORN',
  'FACTION_SHARED',
  'PRIVATE_KINGSHADE_DEV',
  'USER_PRIVATE',
]);

export const memoryRecordKindSchema = z.enum([
  'PROJECT_DECISION',
  'VERIFIED_FACT',
  'BASELINE_EVIDENCE',
  'FAILED_CANDIDATE',
  'TEST_RESULT',
  'ARCHITECTURE_SECURITY_DECISION',
  'CURATED_TORN_NOTE',
]);

export const evidenceClassificationSchema = z.enum([
  'OFFICIAL_CURRENT',
  'OWNER_VERIFIED',
  'COMMUNITY_DERIVED',
  'AUTOMATED_TEST',
  'RELEASE_RECORD',
  'INFERENCE_HYPOTHESIS',
]);

export const verificationStateSchema = z.enum([
  'OWNER_VERIFIED',
  'OFFICIAL_CURRENT',
  'SUPPORTING',
  'UNVERIFIED',
  'HYPOTHESIS',
]);

export const memorySourceSchema = z
  .object({
    kind: z.enum([
      'OFFICIAL_DOCUMENTATION',
      'OWNER_ARTIFACT',
      'COMMUNITY_SOURCE',
      'TEST_RUN',
      'RELEASE_RECORD',
      'CURATED_MANIFEST',
      'MODEL_PROPOSAL',
      'TRUSTED_APPLICATION',
    ]),
    reference: z.string().min(1).max(MAX_MEMORY_SOURCE_CHARS),
    description: z.string().min(1).max(MAX_MEMORY_SOURCE_CHARS),
  })
  .strict();

export const ownerVerificationEvidenceSchema = z
  .object({
    verifiedByActorId: memoryActorIdSchema,
    evidenceReference: z.string().min(1).max(MAX_MEMORY_SOURCE_CHARS),
  })
  .strict();

const activeLifecycleSchema = z
  .object({
    status: z.enum(['PENDING', 'ACTIVE']),
  })
  .strict();

const invalidatedLifecycleSchema = z
  .object({
    status: z.literal('INVALIDATED'),
    invalidatedAt: memoryTimestampSchema,
    invalidatedByActorId: memoryActorIdSchema,
    reason: z.string().min(1).max(MAX_MEMORY_INVALIDATION_REASON_CHARS),
    replacementRecordId: memoryRecordIdSchema.optional(),
  })
  .strict();

export const memoryLifecycleSchema = z.discriminatedUnion('status', [
  activeLifecycleSchema,
  invalidatedLifecycleSchema,
]);

const memoryRecordFields = {
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  id: memoryRecordIdSchema,
  projectId: memoryProjectIdSchema,
  kind: memoryRecordKindSchema,
  zone: knowledgeZoneSchema,
  ownerId: memoryActorIdSchema.optional(),
  tenantId: memoryTenantIdSchema.optional(),
  contentScope: z.literal('TORN_PROJECT'),
  subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
  evidenceClassification: evidenceClassificationSchema,
  source: memorySourceSchema,
  verificationState: verificationStateSchema,
  ownerVerificationEvidence: ownerVerificationEvidenceSchema.optional(),
  createdAt: memoryTimestampSchema,
  updatedAt: memoryTimestampSchema,
  supersedesRecordId: memoryRecordIdSchema.optional(),
};

function validateRecordSemantics(
  record: z.infer<typeof memoryRecordBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (record.zone === 'USER_PRIVATE') {
    if (record.ownerId === undefined || record.tenantId !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'USER_PRIVATE records require only an owner scope',
      });
    }
  } else if (record.zone === 'FACTION_SHARED') {
    if (record.tenantId === undefined || record.ownerId !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'FACTION_SHARED records require only a tenant scope',
      });
    }
  } else if (record.ownerId !== undefined || record.tenantId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Unscoped knowledge zones cannot carry owner or tenant scope',
    });
  }

  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    context.addIssue({ code: 'custom', message: 'updatedAt cannot precede createdAt' });
  }

  if (record.supersedesRecordId === record.id) {
    context.addIssue({ code: 'custom', message: 'A record cannot supersede itself' });
  }

  if (
    (record.evidenceClassification === 'AUTOMATED_TEST' ||
      record.evidenceClassification === 'RELEASE_RECORD') &&
    !['SUPPORTING', 'UNVERIFIED'].includes(record.verificationState)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Automated and release evidence can only remain supporting or unverified',
    });
  }

  if (
    record.evidenceClassification === 'COMMUNITY_DERIVED' &&
    !['SUPPORTING', 'UNVERIFIED'].includes(record.verificationState)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Community evidence can only remain supporting or unverified',
    });
  }

  if (
    record.verificationState === 'OFFICIAL_CURRENT' &&
    record.evidenceClassification !== 'OFFICIAL_CURRENT'
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Official verification requires official-current evidence',
    });
  }

  if (
    record.evidenceClassification === 'INFERENCE_HYPOTHESIS' &&
    record.verificationState !== 'HYPOTHESIS'
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Inference evidence must remain a hypothesis',
    });
  }

  if (
    record.verificationState === 'HYPOTHESIS' &&
    record.evidenceClassification !== 'INFERENCE_HYPOTHESIS'
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Hypothesis verification requires inference evidence',
    });
  }

  if (
    (record.evidenceClassification === 'OWNER_VERIFIED') !==
    (record.verificationState === 'OWNER_VERIFIED')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Owner verification requires matching evidence and verification classifications',
    });
  }

  if (record.verificationState === 'OWNER_VERIFIED') {
    if (
      record.ownerVerificationEvidence === undefined ||
      record.ownerVerificationEvidence.evidenceReference !== record.source.reference
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Owner verification requires persisted matching trusted evidence',
      });
    }
  } else if (record.ownerVerificationEvidence !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Non-owner-verified records cannot carry owner-verification evidence',
    });
  }

  if (record.source.kind === 'MODEL_PROPOSAL') {
    if (
      record.lifecycle.status !== 'PENDING' ||
      record.evidenceClassification !== 'INFERENCE_HYPOTHESIS' ||
      record.verificationState !== 'HYPOTHESIS'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Model proposals must remain pending hypotheses',
      });
    }
  }
}

const memoryRecordBaseSchema = z.object({
  ...memoryRecordFields,
  lifecycle: memoryLifecycleSchema,
});

export const memoryRecordSchema = memoryRecordBaseSchema
  .strict()
  .superRefine(validateRecordSemantics);

export const newMemoryRecordSchema = z
  .object({
    ...memoryRecordFields,
    lifecycle: activeLifecycleSchema,
  })
  .strict()
  .superRefine(validateRecordSemantics);

export type KnowledgeZone = z.infer<typeof knowledgeZoneSchema>;
export type MemoryRecordKind = z.infer<typeof memoryRecordKindSchema>;
export type EvidenceClassification = z.infer<typeof evidenceClassificationSchema>;
export type VerificationState = z.infer<typeof verificationStateSchema>;
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type NewMemoryRecord = z.infer<typeof newMemoryRecordSchema>;

export function parseMemoryRecord(value: unknown): MemoryRecord {
  return memoryRecordSchema.parse(value);
}

export function parseNewMemoryRecord(value: unknown): NewMemoryRecord {
  return newMemoryRecordSchema.parse(value);
}
