import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { MemoryAccessContext } from '../memory/access.js';
import type { MemoryRecordKind } from '../memory/model.js';
import { MemoryService, type TrustedMemoryDraft } from '../memory/service.js';

const exactSha = z.string().regex(/^[0-9a-f]{40}$/i);
const safeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const opaqueApprovalSecret = /\b[0-9a-f]{64}\b/i;

const profileSchema = z.object({
  profileId: safeId,
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
});

const defectEvidenceProvenanceSchema = z
  .object({
    evidenceId: safeId,
    kind: z.enum([
      'USER_PROVIDED',
      'REPRODUCIBLE',
      'REPOSITORY',
      'AUTOMATED_TEST',
      'SYNTHETIC_FIXTURE',
    ]),
    reference: z.string().trim().min(1).max(1_000),
  })
  .strict();

const ownerAcknowledgementSchema = z
  .object({
    status: z.enum(['OWNER_VERIFIED_KNOWN_GOOD', 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE']),
    evidenceReference: z.string().trim().min(1).max(1_000),
  })
  .strict();

const writeApprovalProvenanceSchema = z
  .object({
    decisionReferenceId: safeId,
    decision: z.enum(['APPROVED', 'DENIED', 'CANCELLED']),
  })
  .strict();

export const syntheticDebugDurableOutcomeSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    workflowKind: z.literal('synthetic'),
    caseId: safeId,
    projectId: safeId,
    finalDisposition: z.enum(['TEST_READY', 'BLOCKED']),
    baselineMode: z.enum(['KNOWN_GOOD', 'DEFECT_REFERENCE']),
    baselineSha: exactSha.nullable(),
    referenceVersion: z.string().trim().min(1).max(500).nullable(),
    referenceWasOwnerVerifiedKnownGood: z.boolean(),
    ownerAcknowledgement: ownerAcknowledgementSchema.nullable(),
    historicalSearchBoundary: z.string().trim().min(1).max(2_000).nullable(),
    defectEvidenceProvenance: z.array(defectEvidenceProvenanceSchema).max(30),
    knownPreExistingDefects: z.array(z.string().trim().min(1).max(500)).max(30),
    knownUnrelatedFailures: z.array(z.string().trim().min(1).max(500)).max(30),
    referenceSelectionReason: z.string().trim().min(1).max(2_000).nullable(),
    rollbackReferenceSemantics: z.string().trim().min(1).max(2_000).nullable(),
    writeApprovalProvenance: writeApprovalProvenanceSchema.nullable(),
    candidateSha: exactSha.nullable(),
    verificationDecisionId: safeId.nullable(),
    verificationStatus: z.enum(['PASSED', 'BLOCKED', 'FAILED']).nullable(),
    verificationProfiles: z.array(profileSchema).max(30),
    reviewId: safeId.nullable(),
    reviewDisposition: z.enum(['pass', 'fail', 'blocked', 'not_run']),
    failureCodes: z.array(safeId).max(30),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.baselineMode === 'KNOWN_GOOD') {
      if (
        (outcome.baselineSha === null
          ? outcome.referenceWasOwnerVerifiedKnownGood || outcome.ownerAcknowledgement !== null
          : !outcome.referenceWasOwnerVerifiedKnownGood ||
            outcome.ownerAcknowledgement?.status !== 'OWNER_VERIFIED_KNOWN_GOOD') ||
        outcome.historicalSearchBoundary !== null ||
        outcome.defectEvidenceProvenance.length > 0 ||
        outcome.knownPreExistingDefects.length > 0 ||
        outcome.knownUnrelatedFailures.length > 0 ||
        outcome.referenceSelectionReason !== null ||
        outcome.rollbackReferenceSemantics !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'KNOWN_GOOD memory cannot carry DEFECT_REFERENCE provenance',
        });
      }
      return;
    }
    if (
      outcome.baselineSha === null ||
      outcome.referenceWasOwnerVerifiedKnownGood ||
      outcome.ownerAcknowledgement?.status !== 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE' ||
      outcome.historicalSearchBoundary === null ||
      outcome.defectEvidenceProvenance.length === 0 ||
      outcome.knownPreExistingDefects.length === 0 ||
      outcome.referenceSelectionReason === null ||
      outcome.rollbackReferenceSemantics === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'DEFECT_REFERENCE memory requires complete non-known-good provenance',
      });
    }
  });

export type SyntheticDebugDurableOutcome = z.infer<typeof syntheticDebugDurableOutcomeSchema>;

export interface SyntheticDebugMemoryPersistenceResult {
  readonly status: 'PERSISTED';
  readonly disposition: SyntheticDebugDurableOutcome['finalDisposition'];
  readonly records: readonly {
    readonly id: string;
    readonly kind: MemoryRecordKind;
    readonly status: 'inserted' | 'duplicate';
  }[];
}

export class SyntheticDebugMemoryPersistenceError extends Error {
  readonly code: 'INVALID_OUTCOME' | 'PERSISTENCE_FAILED';
  readonly persistedRecordIds: readonly string[];

  constructor(
    code: SyntheticDebugMemoryPersistenceError['code'],
    persistedRecordIds: readonly string[] = [],
  ) {
    super(
      code === 'INVALID_OUTCOME'
        ? 'Synthetic debug memory outcome is invalid'
        : 'Synthetic debug memory persistence failed',
    );
    this.name = 'SyntheticDebugMemoryPersistenceError';
    this.code = code;
    this.persistedRecordIds = Object.freeze([...persistedRecordIds]);
  }
}

function deterministicId(kind: MemoryRecordKind, outcome: SyntheticDebugDurableOutcome): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ kind, outcome }), 'utf8')
    .digest('hex');
  return `c3-${kind.toLowerCase().replaceAll('_', '-')}-${digest}`;
}

function content(value: Record<string, unknown>): string {
  return JSON.stringify({ scope: 'SYNTHETIC_TEST_FIXTURE', ...value });
}

function draft(
  kind: MemoryRecordKind,
  outcome: SyntheticDebugDurableOutcome,
  boundProjectId: string,
  subject: string,
  recordContent: Record<string, unknown>,
): TrustedMemoryDraft {
  return {
    id: deterministicId(kind, outcome),
    projectId: boundProjectId,
    kind,
    zone: 'PRIVATE_KINGSHADE_DEV',
    subject,
    content: content(recordContent),
    evidenceClassification: 'AUTOMATED_TEST',
    source: {
      kind: 'TEST_RUN',
      reference: `c3-synthetic:${outcome.caseId}`,
      description: 'Bounded synthetic C3 workflow evidence from the trusted application sink.',
    },
    verificationState: 'SUPPORTING',
  };
}

function draftsFor(
  outcome: SyntheticDebugDurableOutcome,
  boundProjectId: string,
): readonly TrustedMemoryDraft[] {
  const drafts: TrustedMemoryDraft[] = [];
  if (outcome.baselineMode === 'DEFECT_REFERENCE') {
    drafts.push(
      draft(
        'BASELINE_EVIDENCE',
        outcome,
        boundProjectId,
        `Synthetic C4 DEFECT_REFERENCE ${outcome.caseId}`,
        {
          caseId: outcome.caseId,
          baselineMode: outcome.baselineMode,
          referenceSha: outcome.baselineSha,
          referenceVersion: outcome.referenceVersion,
          referenceWasOwnerVerifiedKnownGood: outcome.referenceWasOwnerVerifiedKnownGood,
          ownerAcknowledgement: outcome.ownerAcknowledgement,
          historicalSearchBoundary: outcome.historicalSearchBoundary,
          defectEvidenceProvenance: outcome.defectEvidenceProvenance,
          knownPreExistingDefects: outcome.knownPreExistingDefects,
          knownUnrelatedFailures: outcome.knownUnrelatedFailures,
          reasonSelected: outcome.referenceSelectionReason,
          rollbackReferenceSemantics: outcome.rollbackReferenceSemantics,
          separateWriteApprovalRequired: true,
          writeApprovalProvenance: outcome.writeApprovalProvenance,
        },
      ),
    );
  }
  if (outcome.verificationStatus !== null) {
    drafts.push(
      draft('TEST_RESULT', outcome, boundProjectId, `Synthetic C3 verification ${outcome.caseId}`, {
        caseId: outcome.caseId,
        verificationDecisionId: outcome.verificationDecisionId,
        status: outcome.verificationStatus,
        profiles: outcome.verificationProfiles,
        baselineSha: outcome.baselineSha,
        candidateSha: outcome.candidateSha,
      }),
    );
  }
  if (
    outcome.failureCodes.length > 0 ||
    outcome.verificationStatus === 'FAILED' ||
    outcome.verificationStatus === 'BLOCKED'
  ) {
    drafts.push(
      draft(
        'FAILED_CANDIDATE',
        outcome,
        boundProjectId,
        `Synthetic C3 candidate ${outcome.caseId}`,
        {
          caseId: outcome.caseId,
          candidateSha: outcome.candidateSha,
          verificationStatus: outcome.verificationStatus,
          failureCodes: outcome.failureCodes,
        },
      ),
    );
  }
  if (outcome.reviewDisposition !== 'not_run') {
    drafts.push(
      draft(
        'ARCHITECTURE_SECURITY_DECISION',
        outcome,
        boundProjectId,
        `Synthetic C3 independent review ${outcome.caseId}`,
        {
          caseId: outcome.caseId,
          reviewId: outcome.reviewId,
          disposition: outcome.reviewDisposition,
          candidateSha: outcome.candidateSha,
        },
      ),
    );
  }
  drafts.push(
    draft('PROJECT_DECISION', outcome, boundProjectId, `Synthetic C3 workflow ${outcome.caseId}`, {
      caseId: outcome.caseId,
      disposition: outcome.finalDisposition,
      baselineMode: outcome.baselineMode,
      baselineSha: outcome.baselineSha,
      candidateSha: outcome.candidateSha,
      writeApprovalProvenance: outcome.writeApprovalProvenance,
      verificationStatus: outcome.verificationStatus,
      reviewDisposition: outcome.reviewDisposition,
    }),
  );
  return drafts;
}

export class SyntheticDebugMemorySink {
  readonly #memory: MemoryService;
  readonly #context: MemoryAccessContext | null | undefined;
  readonly #projectId: string;

  constructor(
    memory: MemoryService,
    context: MemoryAccessContext | null | undefined,
    syntheticProjectId: string,
  ) {
    this.#memory = memory;
    this.#context = context;
    this.#projectId = syntheticProjectId;
  }

  async persist(input: unknown): Promise<SyntheticDebugMemoryPersistenceResult> {
    const parsed = syntheticDebugDurableOutcomeSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.projectId !== this.#projectId ||
      opaqueApprovalSecret.test(JSON.stringify(parsed.data))
    ) {
      throw new SyntheticDebugMemoryPersistenceError('INVALID_OUTCOME');
    }
    const outcome = parsed.data;
    const drafts = draftsFor(outcome, this.#projectId);
    const persisted: { id: string; kind: MemoryRecordKind; status: 'inserted' | 'duplicate' }[] =
      [];
    try {
      for (const record of drafts) {
        await this.#memory.validateTrustedRecord(this.#context, record);
      }
      for (const record of drafts) {
        const result = await this.#memory.saveTrustedRecord(this.#context, record);
        persisted.push({ id: result.record.id, kind: result.record.kind, status: result.status });
      }
    } catch {
      throw new SyntheticDebugMemoryPersistenceError(
        'PERSISTENCE_FAILED',
        persisted.map(({ id }) => id),
      );
    }
    return Object.freeze({
      status: 'PERSISTED' as const,
      disposition: outcome.finalDisposition,
      records: Object.freeze(persisted.map((record) => Object.freeze({ ...record }))),
    });
  }
}
