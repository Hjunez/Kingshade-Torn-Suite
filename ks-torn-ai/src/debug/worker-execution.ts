import { z } from 'zod';

import { redactRepositorySecrets } from '../repository/validation.js';
import type { WorkerAction, WorkerActionStatus } from '../worker/contracts.js';
import { isPathAllowed, normalizeRelativeWorkerPath } from '../worker/path-policy.js';
import { isFullCommitSha } from './gates.js';
import type { SyntheticDebugWriteProposal } from './records.js';

type SyntheticDebugWorkerProposal = Readonly<
  Omit<SyntheticDebugWriteProposal, 'approvedPaths' | 'requiredTestProfileIds'>
> & {
  readonly approvedPaths: readonly string[];
  readonly requiredTestProfileIds: readonly string[];
};

const MAX_SAFE_CONTEXT = 1_000;
const MAX_SAFE_INPUT = 100_000;
const OPAQUE_APPROVAL_SECRET = /[0-9a-f]{64}/gi;
const PROPOSAL_PLACEHOLDER = '__KS_LESLIE_SAFE_PROPOSAL_ID__';

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
const fullCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const timestampSchema = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected a valid action timestamp');

const workerActionResultSchema = z
  .object({
    actionIndex: z.number().int().nonnegative(),
    kind: workerActionKindSchema,
    status: workerActionStatusSchema,
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    summary: z.string().max(1_100_000),
    exitCode: z.number().int().optional(),
    output: z.string().max(1_100_000).optional(),
    profileId: z.string().max(100).optional(),
    patchId: z.string().max(128).optional(),
    artifactRefs: z.array(z.string().max(2_000)).max(100).optional(),
  })
  .strict();

const workerJobResultSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(80),
    baselineRef: fullCommitShaSchema,
    workspaceBranch: z.string().min(1).max(255).optional(),
    workspacePath: z.string().min(1).max(2_000).optional(),
    workspaceRetained: z.boolean(),
    isolatedExecution: z.boolean(),
    sourceHeadSha: fullCommitShaSchema,
    headShaBefore: fullCommitShaSchema,
    headShaAfter: fullCommitShaSchema,
    changedPaths: z.array(z.string().min(1).max(500)).max(100),
    actions: z.array(workerActionResultSchema).min(1).max(20),
  })
  .strict();

type ParsedWorkerResult = z.infer<typeof workerJobResultSchema>;
type ParsedWorkerAction = z.infer<typeof workerActionResultSchema>;

export type SyntheticDebugWorkerFailureCode =
  | 'STALE_BASELINE'
  | 'INVALID_BASELINE'
  | 'APPROVAL_GRANT_REJECTED'
  | 'PATCH_REJECTED'
  | 'PATH_SCOPE_VIOLATION'
  | 'TEST_PROFILE_FAILED'
  | 'CANDIDATE_INTEGRITY_FAILURE'
  | 'CLEANUP_ROLLBACK_FAILURE'
  | 'INTERNAL_WORKER_ERROR';

export type SyntheticDebugWorkerFailureDisposition = 'BLOCKED' | 'FAILED';

export interface SyntheticDebugWorkerFailure {
  readonly code: SyntheticDebugWorkerFailureCode;
  readonly disposition: SyntheticDebugWorkerFailureDisposition;
  readonly summary: string;
  readonly context: string | null;
  readonly actionIndex: number | null;
  readonly actionKind: WorkerAction['kind'] | null;
}

export interface SyntheticDebugWorkerActionRecord {
  readonly actionIndex: number;
  readonly kind: WorkerAction['kind'];
  readonly status: WorkerActionStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly summary: string;
  readonly exitCode: number | null;
  readonly profileId: string | null;
  readonly patchId: string | null;
}

export interface SyntheticDebugWorkerExecutionRecord {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly recordKind: 'WORKER_EXECUTION';
  readonly status: 'SUCCEEDED' | 'BLOCKED' | 'FAILED';
  readonly proposalId: string;
  readonly jobId: string | null;
  readonly projectId: string;
  readonly baselineSha: string | null;
  readonly sourceHeadSha: string | null;
  readonly headShaBefore: string | null;
  readonly headShaAfter: string | null;
  readonly candidateSha: string | null;
  readonly isolatedBranch: string | null;
  readonly workspaceReference: string | null;
  readonly workspaceRetained: boolean;
  readonly isolatedExecution: boolean;
  readonly changedPaths: readonly string[];
  readonly actions: readonly SyntheticDebugWorkerActionRecord[];
  readonly rollbackRef: string;
  readonly rollbackSha: string | null;
  readonly failure: SyntheticDebugWorkerFailure | null;
}

export interface SyntheticDebugWorkerAdaptation {
  readonly disposition: 'VERIFYING' | SyntheticDebugWorkerFailureDisposition;
  readonly record: SyntheticDebugWorkerExecutionRecord;
}

interface WorkerRecordFacts {
  readonly jobId: string | null;
  readonly sourceHeadSha: string | null;
  readonly headShaBefore: string | null;
  readonly headShaAfter: string | null;
  readonly candidateSha: string | null;
  readonly isolatedBranch: string | null;
  readonly workspaceReference: string | null;
  readonly workspaceRetained: boolean;
  readonly isolatedExecution: boolean;
  readonly changedPaths: readonly string[];
  readonly actions: readonly SyntheticDebugWorkerActionRecord[];
}

const EMPTY_WORKER_FACTS: WorkerRecordFacts = Object.freeze({
  jobId: null,
  sourceHeadSha: null,
  headShaBefore: null,
  headShaAfter: null,
  candidateSha: null,
  isolatedBranch: null,
  workspaceReference: null,
  workspaceRetained: false,
  isolatedExecution: false,
  changedPaths: Object.freeze([]),
  actions: Object.freeze([]),
});

const FAILURE_SUMMARIES: Readonly<Record<SyntheticDebugWorkerFailureCode, string>> = Object.freeze({
  STALE_BASELINE: 'The Worker rejected a stale approved baseline.',
  INVALID_BASELINE: 'Worker execution requires an exact 40-character baseline SHA.',
  APPROVAL_GRANT_REJECTED: 'The existing Worker approval mechanism rejected the execution.',
  PATCH_REJECTED: 'The existing Worker rejected the bounded synthetic patch.',
  PATH_SCOPE_VIOLATION: 'The existing Worker detected a path or scope violation.',
  TEST_PROFILE_FAILED: 'A Worker-reported post-patch test profile did not pass.',
  CANDIDATE_INTEGRITY_FAILURE: 'The existing Worker candidate integrity check did not pass.',
  CLEANUP_ROLLBACK_FAILURE: 'The existing Worker reported cleanup or rollback failure.',
  INTERNAL_WORKER_ERROR: 'The trusted Worker execution boundary failed unexpectedly.',
});

function safeText(value: string, proposalId: string, maximum = MAX_SAFE_CONTEXT): string {
  const preserveProposalId = isSafeProposalId(proposalId);
  const boundedValue = value.slice(0, MAX_SAFE_INPUT);
  const protectedProposal = preserveProposalId
    ? boundedValue.split(proposalId).join(PROPOSAL_PLACEHOLDER)
    : boundedValue;
  const repositoryRedacted = redactRepositorySecrets(protectedProposal).value;
  const approvalRedacted = repositoryRedacted.replace(
    OPAQUE_APPROVAL_SECRET,
    '[REDACTED APPROVAL SECRET]',
  );
  const restored = preserveProposalId
    ? approvalRedacted.split(PROPOSAL_PLACEHOLDER).join(proposalId)
    : approvalRedacted;
  if (restored.length <= maximum) return restored;
  const marker = '[truncated]';
  return restored.slice(0, maximum - marker.length) + marker;
}

function safeOptionalText(
  value: string | undefined,
  proposalId: string,
  maximum?: number,
): string | null {
  return value === undefined ? null : safeText(value, proposalId, maximum);
}

function failureDisposition(
  code: SyntheticDebugWorkerFailureCode,
): SyntheticDebugWorkerFailureDisposition {
  return code === 'CANDIDATE_INTEGRITY_FAILURE' ||
    code === 'CLEANUP_ROLLBACK_FAILURE' ||
    code === 'INTERNAL_WORKER_ERROR'
    ? 'FAILED'
    : 'BLOCKED';
}

function failure(
  code: SyntheticDebugWorkerFailureCode,
  proposalId: string,
  context: string | null,
  action: ParsedWorkerAction | null = null,
): SyntheticDebugWorkerFailure {
  return {
    code,
    disposition: failureDisposition(code),
    summary: FAILURE_SUMMARIES[code],
    context: context === null ? null : safeText(context, proposalId),
    actionIndex: action?.actionIndex ?? null,
    actionKind: action?.kind ?? null,
  };
}

function classifyText(value: string): SyntheticDebugWorkerFailureCode {
  const normalized = value.toLowerCase();
  if (
    normalized.includes('workspace cleanup failed') ||
    normalized.includes('cleanup failure') ||
    normalized.includes('rollback failure') ||
    normalized.includes('reset rejected worker change') ||
    normalized.includes('clean rejected worker change')
  ) {
    return 'CLEANUP_ROLLBACK_FAILURE';
  }
  if (
    normalized.includes('full 40-character') ||
    normalized.includes('non-full baseline') ||
    normalized.includes('invalid baseline')
  ) {
    return 'INVALID_BASELINE';
  }
  if (
    normalized.includes('stale baseline') ||
    normalized.includes('stale patch baseline') ||
    normalized.includes('baseline is stale')
  ) {
    return 'STALE_BASELINE';
  }
  if (
    normalized.includes('write approval does not match') ||
    normalized.includes('approval token') ||
    normalized.includes('approval verifier') ||
    normalized.includes('pending write') ||
    normalized.includes('pending application-issued write approval') ||
    normalized.includes('grant')
  ) {
    return 'APPROVAL_GRANT_REJECTED';
  }
  if (
    normalized.includes('approved candidate') ||
    normalized.includes('candidate finalization') ||
    normalized.includes('candidate tree') ||
    normalized.includes('unexpected head') ||
    normalized.includes('unexpected branch') ||
    normalized.includes('branch already exists') ||
    normalized.includes('worker branch must start')
  ) {
    return 'CANDIDATE_INTEGRITY_FAILURE';
  }
  if (
    normalized.includes('scope violation') ||
    normalized.includes('outside worker scope') ||
    normalized.includes('outside the trusted write policy') ||
    normalized.includes('path escape') ||
    normalized.includes('path escapes')
  ) {
    return 'PATH_SCOPE_VIOLATION';
  }
  if (
    normalized.includes('patch rejected') ||
    normalized.includes('patch is invalid') ||
    normalized.includes('validate git patch') ||
    normalized.includes('apply git patch') ||
    normalized.includes('approved patch produced no scoped changes')
  ) {
    return 'PATCH_REJECTED';
  }
  if (normalized.includes('test profile')) return 'TEST_PROFILE_FAILED';
  if (normalized.includes('approval')) return 'APPROVAL_GRANT_REJECTED';
  return 'INTERNAL_WORKER_ERROR';
}

function isSafeProposalId(value: string): boolean {
  return /^write-proposal-[0-9a-f]{64}$/i.test(value);
}

function safeProposalId(value: string): string {
  return isSafeProposalId(value) ? value : 'write-proposal-invalid';
}

function classifyActionFailure(action: ParsedWorkerAction): SyntheticDebugWorkerFailureCode {
  const classified = classifyText(action.summary);
  if (classified !== 'INTERNAL_WORKER_ERROR') return classified;
  if (action.kind === 'run_test_profile') return 'TEST_PROFILE_FAILED';
  if (action.kind === 'apply_patch') return 'PATCH_REJECTED';
  if (action.kind === 'finalize_candidate') return 'CANDIDATE_INTEGRITY_FAILURE';
  return classified;
}

function safeAction(
  action: ParsedWorkerAction,
  proposalId: string,
): SyntheticDebugWorkerActionRecord {
  return {
    actionIndex: action.actionIndex,
    kind: action.kind,
    status: action.status,
    startedAt: action.startedAt,
    finishedAt: action.finishedAt,
    summary: safeText(action.summary, proposalId),
    exitCode: action.exitCode ?? null,
    profileId: safeOptionalText(action.profileId, proposalId, 100),
    patchId:
      isSafeProposalId(proposalId) && action.patchId === proposalId
        ? proposalId
        : safeOptionalText(action.patchId, proposalId, 128),
  };
}

function commonRecord(
  proposal: SyntheticDebugWorkerProposal,
  status: SyntheticDebugWorkerExecutionRecord['status'],
  facts: WorkerRecordFacts,
  executionFailure: SyntheticDebugWorkerFailure | null,
): SyntheticDebugWorkerExecutionRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'WORKER_EXECUTION',
    status,
    proposalId: safeProposalId(proposal.proposalId),
    jobId: facts.jobId,
    projectId: safeText(proposal.projectId, proposal.proposalId, 80),
    baselineSha: isFullCommitSha(proposal.baselineSha) ? proposal.baselineSha.toLowerCase() : null,
    sourceHeadSha: facts.sourceHeadSha,
    headShaBefore: facts.headShaBefore,
    headShaAfter: facts.headShaAfter,
    candidateSha: facts.candidateSha,
    isolatedBranch: facts.isolatedBranch,
    workspaceReference: facts.workspaceReference,
    workspaceRetained: facts.workspaceRetained,
    isolatedExecution: facts.isolatedExecution,
    changedPaths: facts.changedPaths,
    actions: facts.actions,
    rollbackRef: safeText(proposal.rollbackRef, proposal.proposalId),
    rollbackSha: isFullCommitSha(proposal.rollbackSha) ? proposal.rollbackSha.toLowerCase() : null,
    failure: executionFailure,
  };
}

function failedAdaptation(
  proposal: SyntheticDebugWorkerProposal,
  executionFailure: SyntheticDebugWorkerFailure,
  facts: WorkerRecordFacts = EMPTY_WORKER_FACTS,
): SyntheticDebugWorkerAdaptation {
  return {
    disposition: executionFailure.disposition,
    record: commonRecord(
      proposal,
      executionFailure.disposition,
      { ...facts, candidateSha: null },
      executionFailure,
    ),
  };
}

function parsedFacts(
  result: ParsedWorkerResult,
  proposal: SyntheticDebugWorkerProposal,
  candidateSha: string | null,
): WorkerRecordFacts {
  return {
    jobId: safeText(result.jobId, proposal.proposalId, 128),
    sourceHeadSha: result.sourceHeadSha.toLowerCase(),
    headShaBefore: result.headShaBefore.toLowerCase(),
    headShaAfter: result.headShaAfter.toLowerCase(),
    candidateSha,
    isolatedBranch: safeOptionalText(result.workspaceBranch, proposal.proposalId, 255),
    workspaceReference: safeOptionalText(result.workspacePath, proposal.proposalId, 2_000),
    workspaceRetained: result.workspaceRetained,
    isolatedExecution: result.isolatedExecution,
    changedPaths: result.changedPaths.map((path) => safeText(path, proposal.proposalId, 500)),
    actions: result.actions.map((action) => safeAction(action, proposal.proposalId)),
  };
}

function expectedActionKinds(
  proposal: SyntheticDebugWorkerProposal,
): readonly WorkerAction['kind'][] {
  return [
    'apply_patch',
    ...proposal.requiredTestProfileIds.map(() => 'run_test_profile' as const),
    'finalize_candidate',
  ];
}

function actionPrefixMatches(
  actions: readonly ParsedWorkerAction[],
  proposal: SyntheticDebugWorkerProposal,
): boolean {
  const expectedKinds = expectedActionKinds(proposal);
  if (actions.length > expectedKinds.length) return false;
  for (const [index, action] of actions.entries()) {
    if (action.actionIndex !== index || action.kind !== expectedKinds[index]) return false;
    if (index === 0 && action.patchId !== proposal.proposalId) return false;
    if (action.kind === 'run_test_profile') {
      const profileIndex = index - 1;
      if (action.profileId !== proposal.requiredTestProfileIds[profileIndex]) return false;
    }
  }
  return true;
}

function coreResultMatchesProposal(
  result: ParsedWorkerResult,
  proposal: SyntheticDebugWorkerProposal,
): boolean {
  const baseline = proposal.baselineSha.toLowerCase();
  return (
    result.projectId === proposal.projectId &&
    result.baselineRef.toLowerCase() === baseline &&
    result.sourceHeadSha.toLowerCase() === baseline &&
    result.headShaBefore.toLowerCase() === baseline &&
    result.workspaceBranch === proposal.proposedIsolatedBranch &&
    result.isolatedExecution &&
    actionPrefixMatches(result.actions, proposal)
  );
}

function unsafeChangedPath(
  paths: readonly string[],
  approvedPaths: readonly string[],
): string | null {
  return (
    paths.find((path) => {
      const normalized = normalizeRelativeWorkerPath(path);
      return (
        normalized === null || normalized !== path || !isPathAllowed(normalized, approvedPaths)
      );
    }) ?? null
  );
}

export function adaptSyntheticDebugWorkerResult(
  input: unknown,
  proposal: SyntheticDebugWorkerProposal,
): SyntheticDebugWorkerAdaptation {
  if (!isFullCommitSha(proposal.baselineSha)) {
    return failedAdaptation(proposal, failure('INVALID_BASELINE', proposal.proposalId, null));
  }

  const parsed = workerJobResultSchema.safeParse(input);
  if (!parsed.success) {
    return failedAdaptation(
      proposal,
      failure(
        'INTERNAL_WORKER_ERROR',
        proposal.proposalId,
        'Worker result did not match the strict trusted result contract.',
      ),
    );
  }

  const result = parsed.data;
  const baseFacts = parsedFacts(result, proposal, null);
  if (!coreResultMatchesProposal(result, proposal)) {
    return failedAdaptation(
      proposal,
      failure(
        'CANDIDATE_INTEGRITY_FAILURE',
        proposal.proposalId,
        'Worker result did not match the sealed project, baseline, branch, or action plan.',
      ),
      baseFacts,
    );
  }

  const escapedPath = unsafeChangedPath(result.changedPaths, proposal.approvedPaths);
  if (escapedPath !== null) {
    return failedAdaptation(
      proposal,
      failure(
        'PATH_SCOPE_VIOLATION',
        proposal.proposalId,
        'Worker result contained a changed path outside the approved scope.',
      ),
      baseFacts,
    );
  }

  const cleanupAction = result.actions.find((action) =>
    action.summary.toLowerCase().includes('workspace cleanup failed'),
  );
  if (cleanupAction !== undefined) {
    return failedAdaptation(
      proposal,
      failure(
        'CLEANUP_ROLLBACK_FAILURE',
        proposal.proposalId,
        cleanupAction.summary,
        cleanupAction,
      ),
      baseFacts,
    );
  }

  const failedAction = result.actions.find((action) => action.status !== 'passed');
  if (failedAction !== undefined) {
    return failedAdaptation(
      proposal,
      failure(
        classifyActionFailure(failedAction),
        proposal.proposalId,
        failedAction.summary,
        failedAction,
      ),
      baseFacts,
    );
  }

  const expectedKinds = expectedActionKinds(proposal);
  const finalAction = result.actions.at(-1);
  const candidateSha = result.headShaAfter.toLowerCase();
  if (
    result.actions.length !== expectedKinds.length ||
    finalAction?.kind !== 'finalize_candidate' ||
    !result.workspaceRetained ||
    result.workspacePath === undefined ||
    !isFullCommitSha(candidateSha) ||
    candidateSha === proposal.baselineSha.toLowerCase() ||
    result.changedPaths.length === 0
  ) {
    return failedAdaptation(
      proposal,
      failure(
        'CANDIDATE_INTEGRITY_FAILURE',
        proposal.proposalId,
        'Worker success facts did not contain one finalized retained candidate.',
      ),
      baseFacts,
    );
  }

  const successFacts = parsedFacts(result, proposal, candidateSha);
  return {
    disposition: 'VERIFYING',
    record: commonRecord(proposal, 'SUCCEEDED', successFacts, null),
  };
}

export function adaptSyntheticDebugWorkerError(
  workerError: unknown,
  proposal: SyntheticDebugWorkerProposal,
): SyntheticDebugWorkerAdaptation {
  if (!isFullCommitSha(proposal.baselineSha)) {
    return failedAdaptation(proposal, failure('INVALID_BASELINE', proposal.proposalId, null));
  }
  const rawContext = workerError instanceof Error ? workerError.message : null;
  const code = rawContext === null ? 'INTERNAL_WORKER_ERROR' : classifyText(rawContext);
  return failedAdaptation(proposal, failure(code, proposal.proposalId, rawContext));
}
