import { createHash } from 'node:crypto';

import { z } from 'zod';

import { redactRepositorySecrets } from '../repository/validation.js';
import type { WorkerAction, WorkerActionStatus } from '../worker/contracts.js';
import { canVerifyTestCandidate, isFullCommitSha, type DeliveryVerification } from './gates.js';
import { syntheticDebugWriteProposalSchema, type SyntheticDebugWriteProposal } from './records.js';
import type {
  SyntheticDebugWorkerExecutionRecord,
  SyntheticDebugWorkerFailureCode,
} from './worker-execution.js';

const MAX_DECISION_SUMMARY = 1_000;
const MAX_SUMMARY_INPUT = 10_000;
const OPAQUE_APPROVAL_SECRET = /\b[0-9a-f]{64}\b/gi;

const workerActionKindSchema = z.enum([
  'inspect_file',
  'search_text',
  'git_history',
  'compare_refs',
  'run_test_profile',
  'apply_patch',
  'finalize_candidate',
]);
const workerActionStatusSchema = z.enum(['passed', 'failed', 'blocked', 'error']);
const workerFailureCodeSchema = z.enum([
  'STALE_BASELINE',
  'INVALID_BASELINE',
  'APPROVAL_GRANT_REJECTED',
  'PATCH_REJECTED',
  'PATH_SCOPE_VIOLATION',
  'TEST_PROFILE_FAILED',
  'CANDIDATE_INTEGRITY_FAILURE',
  'CLEANUP_ROLLBACK_FAILURE',
  'INTERNAL_WORKER_ERROR',
]);
const boundedNullableStringSchema = (maximum: number) => z.string().min(1).max(maximum).nullable();
const timestampSchema = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected a valid action timestamp');
const testProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const sanitizedWorkerActionSchema = z
  .object({
    actionIndex: z.number().int().nonnegative(),
    kind: workerActionKindSchema,
    status: workerActionStatusSchema,
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    summary: z.string().max(1_000),
    exitCode: z.number().int().nullable(),
    profileId: z.string().max(100).nullable(),
    patchId: z.string().max(128).nullable(),
  })
  .strict()
  .superRefine((action, context) => {
    if (
      action.kind === 'run_test_profile' &&
      !testProfileIdSchema.safeParse(action.profileId).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profileId'],
        message: 'A test-profile action requires one bounded canonical profile id',
      });
    }
  });

const sanitizedWorkerFailureSchema = z
  .object({
    code: workerFailureCodeSchema,
    disposition: z.enum(['BLOCKED', 'FAILED']),
    summary: z.string().min(1).max(1_000),
    context: z.string().max(1_000).nullable(),
    actionIndex: z.number().int().nonnegative().nullable(),
    actionKind: workerActionKindSchema.nullable(),
  })
  .strict();

const sanitizedWorkerExecutionSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    workflowKind: z.literal('synthetic'),
    recordKind: z.literal('WORKER_EXECUTION'),
    status: z.enum(['SUCCEEDED', 'BLOCKED', 'FAILED']),
    proposalId: z.string().regex(/^write-proposal-[0-9a-f]{64}$/i),
    jobId: boundedNullableStringSchema(128),
    projectId: z.string().min(1).max(80),
    baselineSha: boundedNullableStringSchema(64),
    sourceHeadSha: boundedNullableStringSchema(64),
    headShaBefore: boundedNullableStringSchema(64),
    headShaAfter: boundedNullableStringSchema(64),
    candidateSha: boundedNullableStringSchema(64),
    isolatedBranch: boundedNullableStringSchema(255),
    workspaceReference: boundedNullableStringSchema(2_000),
    workspaceRetained: z.boolean(),
    isolatedExecution: z.boolean(),
    changedPaths: z.array(z.string().min(1).max(500)).max(100),
    actions: z.array(sanitizedWorkerActionSchema).max(20),
    rollbackRef: z.string().min(1).max(1_000),
    rollbackSha: boundedNullableStringSchema(64),
    failure: sanitizedWorkerFailureSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    for (const [index, action] of record.actions.entries()) {
      if (action.actionIndex !== index) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'actionIndex'],
          message: 'Worker action indexes must be unique, ordered, and zero based',
        });
      }
    }
  });

type ParsedWorkerExecution = z.infer<typeof sanitizedWorkerExecutionSchema>;

export type SyntheticDebugVerificationStatus = 'PASSED' | 'BLOCKED' | 'FAILED';

export type SyntheticDebugVerificationBlockerCode =
  | 'MALFORMED_VERIFICATION_CONTEXT'
  | 'MALFORMED_TRUSTED_WORKER_RESULT'
  | 'TRUSTED_EXECUTION_IDENTITY_MISMATCH'
  | 'WORKER_EXECUTION_BLOCKED'
  | 'WORKER_EXECUTION_FAILED'
  | 'WORKER_FINALIZATION_INCOMPLETE'
  | 'WORKER_ACTION_DID_NOT_PASS'
  | 'PRE_REVIEW_GATE_BLOCKER';

export interface SyntheticDebugVerificationBlocker {
  readonly code: SyntheticDebugVerificationBlockerCode;
  readonly summary: string;
}

export interface SyntheticDebugVerificationProfileResult {
  readonly actionIndex: number;
  readonly profileId: string;
  readonly required: boolean;
  readonly status: DeliveryVerification['status'];
}

export interface SyntheticDebugVerificationWorkerActionSummary {
  readonly actionIndex: number;
  readonly kind: WorkerAction['kind'];
  readonly status: WorkerActionStatus;
  readonly profileId: string | null;
}

export interface SyntheticDebugVerificationDecision {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly recordKind: 'VERIFICATION_DECISION';
  readonly sourceBoundary: 'TRUSTED_APPLICATION';
  readonly verificationDecisionId: string;
  readonly status: SyntheticDebugVerificationStatus;
  readonly caseId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly workerJobId: string | null;
  readonly workerStatus: SyntheticDebugWorkerExecutionRecord['status'] | null;
  readonly baselineSha: string | null;
  readonly candidateSha: string | null;
  readonly rollbackRef: string | null;
  readonly rollbackSha: string | null;
  readonly isolatedBranch: string | null;
  readonly isolatedExecution: boolean;
  readonly retainedWorkspaceEvidence: boolean;
  readonly approvedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly requiredProfileIds: readonly string[];
  readonly profileResults: readonly SyntheticDebugVerificationProfileResult[];
  readonly workerActions: readonly SyntheticDebugVerificationWorkerActionSummary[];
  readonly blockers: readonly SyntheticDebugVerificationBlocker[];
}

export type SyntheticDebugVerificationProposal = Readonly<
  Omit<SyntheticDebugWriteProposal, 'approvedPaths' | 'requiredTestProfileIds'>
> & {
  readonly approvedPaths: readonly string[];
  readonly requiredTestProfileIds: readonly string[];
};

export interface SyntheticDebugVerificationInput {
  readonly caseId: string;
  readonly projectId: string;
  readonly baselineOwnerVerified: boolean;
  readonly problemEvidenceItems: number;
  readonly rootCauseRecorded: boolean;
  readonly proposal: SyntheticDebugVerificationProposal;
  readonly workerExecution: unknown;
}

type DecisionContent = Omit<SyntheticDebugVerificationDecision, 'verificationDecisionId'>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeSummary(value: string): string {
  const redacted = redactRepositorySecrets(value.slice(0, MAX_SUMMARY_INPUT)).value.replace(
    OPAQUE_APPROVAL_SECRET,
    '[REDACTED APPROVAL SECRET]',
  );
  if (redacted.length <= MAX_DECISION_SUMMARY) return redacted;
  const marker = '[truncated]';
  return redacted.slice(0, MAX_DECISION_SUMMARY - marker.length) + marker;
}

function blocker(
  code: SyntheticDebugVerificationBlockerCode,
  summary: string,
): SyntheticDebugVerificationBlocker {
  return { code, summary: safeSummary(summary) };
}

function uniqueBlockers(
  blockers: readonly SyntheticDebugVerificationBlocker[],
): readonly SyntheticDebugVerificationBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((item) => {
    const key = `${item.code}\0${item.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decision(content: DecisionContent): SyntheticDebugVerificationDecision {
  const normalized: DecisionContent = {
    ...content,
    approvedPaths: [...content.approvedPaths],
    changedPaths: [...content.changedPaths],
    requiredProfileIds: [...content.requiredProfileIds],
    profileResults: content.profileResults.map((result) => ({ ...result })),
    workerActions: content.workerActions.map((action) => ({ ...action })),
    blockers: uniqueBlockers(content.blockers).map((item) => ({ ...item })),
  };
  const verificationDecisionId = `verification-decision-${createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex')}`;
  return deepFreeze({ ...normalized, verificationDecisionId });
}

function safeIdentifier(value: unknown, fallback: string, maximum: number): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : fallback;
}

function malformedDecision(
  input: SyntheticDebugVerificationInput,
  code: 'MALFORMED_VERIFICATION_CONTEXT' | 'MALFORMED_TRUSTED_WORKER_RESULT',
  summary: string,
  proposal: SyntheticDebugWriteProposal | null,
): SyntheticDebugVerificationDecision {
  return decision({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'VERIFICATION_DECISION',
    sourceBoundary: 'TRUSTED_APPLICATION',
    status: 'FAILED',
    caseId: safeIdentifier(input.caseId, 'invalid-case', 128),
    projectId: safeIdentifier(input.projectId, 'invalid-project', 80),
    proposalId: safeIdentifier(proposal?.proposalId, 'write-proposal-invalid', 128),
    workerJobId: null,
    workerStatus: null,
    baselineSha: proposal?.baselineSha ?? null,
    candidateSha: null,
    rollbackRef: proposal?.rollbackRef ?? null,
    rollbackSha: proposal?.rollbackSha ?? null,
    isolatedBranch: proposal?.proposedIsolatedBranch ?? null,
    isolatedExecution: false,
    retainedWorkspaceEvidence: false,
    approvedPaths: proposal?.approvedPaths ?? [],
    changedPaths: [],
    requiredProfileIds: proposal?.requiredTestProfileIds ?? [],
    profileResults: [],
    workerActions: [],
    blockers: [blocker(code, summary)],
  });
}

function parseVerificationProposal(input: unknown): SyntheticDebugWriteProposal | null {
  const parsed = syntheticDebugWriteProposalSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;

  const candidate = input as Record<string, unknown>;
  const approvedPaths = candidate.approvedPaths;
  const requiredProfileIds = candidate.requiredTestProfileIds;
  if (!Array.isArray(approvedPaths) || !Array.isArray(requiredProfileIds)) return null;
  if (approvedPaths.length > 0 && requiredProfileIds.length > 0) return null;

  const withNonEmptyGatePlaceholders = syntheticDebugWriteProposalSchema.safeParse({
    ...candidate,
    approvedPaths: approvedPaths.length === 0 ? ['verification-placeholder.txt'] : approvedPaths,
    requiredTestProfileIds:
      requiredProfileIds.length === 0 ? ['verification-placeholder'] : requiredProfileIds,
  });
  if (!withNonEmptyGatePlaceholders.success) return null;
  return {
    ...withNonEmptyGatePlaceholders.data,
    approvedPaths: approvedPaths as string[],
    requiredTestProfileIds: requiredProfileIds as string[],
  };
}

function profileStatus(status: WorkerActionStatus): DeliveryVerification['status'] {
  return status === 'blocked' ? 'skipped' : status;
}

function profileResults(
  record: ParsedWorkerExecution,
  requiredProfileIds: readonly string[],
): readonly SyntheticDebugVerificationProfileResult[] {
  const required = new Set(requiredProfileIds);
  return record.actions
    .filter(
      (
        action,
      ): action is typeof action & {
        readonly kind: 'run_test_profile';
        readonly profileId: string;
      } => action.kind === 'run_test_profile' && action.profileId !== null,
    )
    .map((action) => ({
      actionIndex: action.actionIndex,
      profileId: action.profileId,
      required: required.has(action.profileId),
      status: profileStatus(action.status),
    }));
}

function workerActions(
  record: ParsedWorkerExecution,
): readonly SyntheticDebugVerificationWorkerActionSummary[] {
  return record.actions.map((action) => ({
    actionIndex: action.actionIndex,
    kind: action.kind,
    status: action.status,
    profileId: action.kind === 'run_test_profile' ? action.profileId : null,
  }));
}

function identityBlockers(
  input: SyntheticDebugVerificationInput,
  proposal: SyntheticDebugWriteProposal,
  record: ParsedWorkerExecution,
): readonly SyntheticDebugVerificationBlocker[] {
  const blockers: SyntheticDebugVerificationBlocker[] = [];
  if (
    input.caseId !== proposal.caseId ||
    input.projectId !== proposal.projectId ||
    record.projectId !== proposal.projectId ||
    record.proposalId !== proposal.proposalId
  ) {
    blockers.push(
      blocker(
        'TRUSTED_EXECUTION_IDENTITY_MISMATCH',
        'The captured Worker result does not match the active case, project, and proposal.',
      ),
    );
  }
  if (
    isFullCommitSha(record.baselineSha) &&
    record.baselineSha.toLowerCase() !== proposal.baselineSha.toLowerCase()
  ) {
    blockers.push(
      blocker(
        'TRUSTED_EXECUTION_IDENTITY_MISMATCH',
        'The captured Worker baseline does not match the sealed proposal baseline.',
      ),
    );
  }
  if (record.rollbackRef !== proposal.rollbackRef) {
    blockers.push(
      blocker(
        'TRUSTED_EXECUTION_IDENTITY_MISMATCH',
        'The captured rollback reference does not match the sealed proposal.',
      ),
    );
  }
  if (record.isolatedBranch !== null && record.isolatedBranch !== proposal.proposedIsolatedBranch) {
    blockers.push(
      blocker(
        'TRUSTED_EXECUTION_IDENTITY_MISMATCH',
        'The captured isolated branch does not match the sealed proposal.',
      ),
    );
  }
  if (
    isFullCommitSha(record.candidateSha) &&
    isFullCommitSha(record.headShaAfter) &&
    record.candidateSha.toLowerCase() !== record.headShaAfter.toLowerCase()
  ) {
    blockers.push(
      blocker(
        'TRUSTED_EXECUTION_IDENTITY_MISMATCH',
        'The captured candidate does not match the Worker finalization result.',
      ),
    );
  }
  return blockers;
}

function executionOutcomeBlockers(
  record: ParsedWorkerExecution,
): readonly SyntheticDebugVerificationBlocker[] {
  if (record.status === 'FAILED' || record.failure?.disposition === 'FAILED') {
    return [
      blocker(
        'WORKER_EXECUTION_FAILED',
        'C3.6 classified the captured Worker execution or candidate integrity as failed.',
      ),
    ];
  }
  if (record.status === 'BLOCKED' || record.failure?.disposition === 'BLOCKED') {
    return [
      blocker(
        'WORKER_EXECUTION_BLOCKED',
        'C3.6 classified the captured Worker execution as blocked.',
      ),
    ];
  }
  if (record.failure !== null) {
    return [
      blocker(
        'MALFORMED_TRUSTED_WORKER_RESULT',
        'A successful captured Worker result cannot contain a failure classification.',
      ),
    ];
  }
  return [];
}

function finalizationBlockers(
  proposal: SyntheticDebugWriteProposal,
  record: ParsedWorkerExecution,
): readonly SyntheticDebugVerificationBlocker[] {
  const blockers: SyntheticDebugVerificationBlocker[] = [];
  const finalizers = record.actions.filter((action) => action.kind === 'finalize_candidate');
  const finalizer = finalizers[0];
  if (
    record.jobId === null ||
    !record.isolatedExecution ||
    !record.workspaceRetained ||
    record.workspaceReference === null ||
    !isFullCommitSha(record.sourceHeadSha) ||
    !isFullCommitSha(record.headShaBefore) ||
    !isFullCommitSha(record.headShaAfter) ||
    record.sourceHeadSha.toLowerCase() !== proposal.baselineSha.toLowerCase() ||
    record.headShaBefore.toLowerCase() !== proposal.baselineSha.toLowerCase() ||
    finalizers.length !== 1 ||
    finalizer?.status !== 'passed' ||
    finalizer.actionIndex !== record.actions.length - 1
  ) {
    blockers.push(
      blocker(
        'WORKER_FINALIZATION_INCOMPLETE',
        'The captured C3.6 result does not contain one successful retained isolated finalization.',
      ),
    );
  }

  if (
    record.actions.some(
      (action) =>
        action.kind !== 'run_test_profile' &&
        action.kind !== 'finalize_candidate' &&
        action.status !== 'passed',
    )
  ) {
    blockers.push(
      blocker(
        'WORKER_ACTION_DID_NOT_PASS',
        'A captured Worker action required before verification did not pass.',
      ),
    );
  }
  return blockers;
}

function workerFailureCode(record: ParsedWorkerExecution): SyntheticDebugWorkerFailureCode | null {
  return record.failure?.code ?? null;
}

export function verifySyntheticDebugWorkerExecution(
  input: SyntheticDebugVerificationInput,
): SyntheticDebugVerificationDecision {
  const proposal = parseVerificationProposal(input.proposal);
  if (proposal === null) {
    return malformedDecision(
      input,
      'MALFORMED_VERIFICATION_CONTEXT',
      'Verification requires one strict sealed write proposal.',
      null,
    );
  }
  const parsedWorker = sanitizedWorkerExecutionSchema.safeParse(input.workerExecution);
  if (!parsedWorker.success) {
    return malformedDecision(
      input,
      'MALFORMED_TRUSTED_WORKER_RESULT',
      'The captured C3.6 Worker result is structurally invalid.',
      proposal,
    );
  }

  const record = parsedWorker.data;
  const profiles = profileResults(record, proposal.requiredTestProfileIds);
  const actions = workerActions(record);
  const identity = identityBlockers(input, proposal, record);
  const outcome = executionOutcomeBlockers(record);
  const finalization = finalizationBlockers(proposal, record);
  const gate = canVerifyTestCandidate({
    baselineSha: record.baselineSha,
    baselineOwnerVerified: input.baselineOwnerVerified,
    candidateSha: record.candidateSha,
    isolatedBranch: record.isolatedBranch,
    rollbackRef: record.rollbackRef,
    rollbackSha: record.rollbackSha,
    problemEvidenceItems: input.problemEvidenceItems,
    rootCauseRecorded: input.rootCauseRecorded,
    approvedPaths: proposal.approvedPaths,
    changedPaths: record.changedPaths,
    requiredProfileIds: proposal.requiredTestProfileIds,
    verification: profiles,
  });
  const gateBlockers = gate.blockers.map((summary) => blocker('PRE_REVIEW_GATE_BLOCKER', summary));
  const blockers = [...identity, ...outcome, ...finalization, ...gateBlockers];
  const malformedOutcome =
    record.status === 'SUCCEEDED'
      ? record.failure !== null
      : record.failure === null || record.failure.disposition !== record.status;
  const failed =
    identity.length > 0 ||
    malformedOutcome ||
    record.status === 'FAILED' ||
    workerFailureCode(record) === 'CANDIDATE_INTEGRITY_FAILURE' ||
    workerFailureCode(record) === 'CLEANUP_ROLLBACK_FAILURE' ||
    workerFailureCode(record) === 'INTERNAL_WORKER_ERROR';
  const status: SyntheticDebugVerificationStatus = failed
    ? 'FAILED'
    : blockers.length > 0
      ? 'BLOCKED'
      : 'PASSED';

  return decision({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'VERIFICATION_DECISION',
    sourceBoundary: 'TRUSTED_APPLICATION',
    status,
    caseId: proposal.caseId,
    projectId: proposal.projectId,
    proposalId: proposal.proposalId,
    workerJobId: record.jobId,
    workerStatus: record.status,
    baselineSha: record.baselineSha,
    candidateSha: record.candidateSha,
    rollbackRef: record.rollbackRef,
    rollbackSha: record.rollbackSha,
    isolatedBranch: record.isolatedBranch,
    isolatedExecution: record.isolatedExecution,
    retainedWorkspaceEvidence: record.workspaceRetained && record.workspaceReference !== null,
    approvedPaths: proposal.approvedPaths,
    changedPaths: record.changedPaths,
    requiredProfileIds: proposal.requiredTestProfileIds,
    profileResults: profiles,
    workerActions: actions,
    blockers,
  });
}
