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

export const syntheticDebugDurableOutcomeSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    workflowKind: z.literal('synthetic'),
    caseId: safeId,
    projectId: safeId,
    finalDisposition: z.enum(['TEST_READY', 'BLOCKED']),
    baselineSha: exactSha.nullable(),
    candidateSha: exactSha.nullable(),
    verificationDecisionId: safeId.nullable(),
    verificationStatus: z.enum(['PASSED', 'BLOCKED', 'FAILED']).nullable(),
    verificationProfiles: z.array(profileSchema).max(30),
    reviewId: safeId.nullable(),
    reviewDisposition: z.enum(['pass', 'fail', 'blocked', 'not_run']),
    failureCodes: z.array(safeId).max(30),
  })
  .strict();

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
      baselineSha: outcome.baselineSha,
      candidateSha: outcome.candidateSha,
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
