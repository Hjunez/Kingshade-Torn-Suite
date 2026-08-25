import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { tool } from '@openai/agents';
import { z } from 'zod';

import {
  resolvedSyntheticDebugBaselineMode,
  type SyntheticDebugBaselineMode,
} from '../debug/baseline-mode.js';
import { canStartImplementation } from '../debug/gates.js';
import { redactRepositorySecrets } from '../repository/validation.js';
import { WriteApprovalStore, type WriteApprovalGrant } from './approval.js';
import type { WorkerAction, WorkerJob, WorkerJobResult } from './contracts.js';
import { executeLocalWorkerJob, readLocalRepositoryHead } from './local-worker.js';
import { inspectPatch } from './patch-policy.js';
import { WorkerPolicyRegistry } from './policy.js';
import { KS_LESLIE_TEST_PROFILES, requireAvailableTestProfile } from './test-profiles.js';

const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const pathSchema = z.string().min(1).max(500);
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const refSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith('-') && !containsControlCharacter(value));

export const workerInspectFileInputSchema = z
  .object({
    projectId: projectIdSchema,
    path: pathSchema,
  })
  .strict();

export const workerSearchTextInputSchema = z
  .object({
    projectId: projectIdSchema,
    query: z.string().min(1).max(2_000),
    paths: z.array(pathSchema).min(1).max(50).optional(),
  })
  .strict();

export const workerGitHistoryInputSchema = z
  .object({
    projectId: projectIdSchema,
    paths: z.array(pathSchema).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export const workerCompareRefsInputSchema = z
  .object({
    projectId: projectIdSchema,
    baseRef: refSchema,
    headRef: refSchema,
  })
  .strict();

export const workerRunTestProfileInputSchema = z
  .object({
    projectId: projectIdSchema,
    profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  })
  .strict();

export const workerApplyApprovedPatchInputSchema = z
  .object({
    projectId: projectIdSchema,
  })
  .strict();

export type ApplicationWriteApprovalReceipt = Omit<WriteApprovalGrant, 'token'>;

export interface ApplicationWriteApprovalRequest {
  projectId: string;
  baselineSha: string;
  baselineMode?: SyntheticDebugBaselineMode;
  baselineOwnerVerified: boolean;
  defectReferenceOwnerAcknowledged?: boolean;
  defectReferenceEntryRequirementsSatisfied?: boolean;
  problemEvidenceItems: number;
  rootCauseRecorded: boolean;
  unresolvedBaselineBlocker?: string | null;
  branch: string;
  allowedPaths: readonly string[];
  patchId: string;
  patch: string;
  expiresAt: Date;
}

export interface WorkerAgentServiceOptions {
  policies: WorkerPolicyRegistry;
  approvals: WriteApprovalStore;
  workspaceBaseDir?: string;
  jobIdFactory?: () => string;
  now?: () => Date;
}

export const WORKER_AGENT_TOOL_NAMES = [
  'worker_inspect_file',
  'worker_search_literal',
  'worker_git_history',
  'worker_compare_refs',
  'worker_run_test_profile',
  'worker_apply_approved_patch',
] as const;

interface WorkerAgentRedactionEvidence {
  secretRedactions: number;
}

function redactAgentFacingValue(value: unknown, evidence: WorkerAgentRedactionEvidence): unknown {
  if (typeof value === 'string') {
    const redacted = redactRepositorySecrets(value);
    evidence.secretRedactions += redacted.redactionCount;
    return redacted.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAgentFacingValue(item, evidence));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactAgentFacingValue(item, evidence)]),
    );
  }
  return value;
}

function serializeWorkerAgentResult(result: WorkerJobResult): string {
  const evidence: WorkerAgentRedactionEvidence = { secretRedactions: 0 };
  const redacted = redactAgentFacingValue(result, evidence);
  return JSON.stringify({
    ...(redacted as Record<string, unknown>),
    agentBoundary: evidence,
  });
}

async function executeWorkerAgentTool(operation: () => Promise<WorkerJobResult>): Promise<string> {
  try {
    return serializeWorkerAgentResult(await operation());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Worker operation failed';
    throw new Error(redactRepositorySecrets(message).value);
  }
}

function workerAgentToolError(_context: unknown, error: unknown): string {
  const message = error instanceof Error ? error.message : 'Worker operation failed';
  return 'Worker operation failed: ' + redactRepositorySecrets(message).value;
}

function sameRoot(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class WorkerAgentService {
  readonly #policies: WorkerPolicyRegistry;
  readonly #approvals: WriteApprovalStore;
  readonly #pendingApprovalTokens = new Map<string, string>();
  readonly #workspaceBaseDir: string | undefined;
  readonly #jobIdFactory: () => string;
  readonly #now: () => Date;

  constructor(options: WorkerAgentServiceOptions) {
    this.#policies = options.policies;
    this.#approvals = options.approvals;
    this.#workspaceBaseDir = options.workspaceBaseDir;
    this.#jobIdFactory = options.jobIdFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async #readJob(
    projectId: string,
    allowedPaths: readonly string[],
    actions: readonly WorkerAction[],
  ): Promise<WorkerJobResult> {
    const policy = this.#policies.requireProject(projectId);
    const baselineRef = await readLocalRepositoryHead(policy.repositoryRoot);
    const job: WorkerJob = {
      jobId: this.#jobIdFactory(),
      mode: 'read_only',
      scope: {
        projectId,
        repositoryRoot: policy.repositoryRoot,
        allowedPaths: [...allowedPaths],
        baselineRef,
      },
      actions: [...actions],
    };
    return await executeLocalWorkerJob(job, {
      ...(this.#workspaceBaseDir === undefined ? {} : { workspaceBaseDir: this.#workspaceBaseDir }),
      now: this.#now,
    });
  }

  async inspectFile(input: z.infer<typeof workerInspectFileInputSchema>): Promise<WorkerJobResult> {
    const parsed = workerInspectFileInputSchema.parse(input);
    const path = this.#policies.requireReadablePath(parsed.projectId, parsed.path);
    return await this.#readJob(parsed.projectId, [path], [{ kind: 'inspect_file', path }]);
  }

  async searchText(input: z.infer<typeof workerSearchTextInputSchema>): Promise<WorkerJobResult> {
    const parsed = workerSearchTextInputSchema.parse(input);
    const paths = this.#policies.requireReadablePaths(parsed.projectId, parsed.paths);
    return await this.#readJob(parsed.projectId, paths, [
      { kind: 'search_text', query: parsed.query, paths: [...paths] },
    ]);
  }

  async gitHistory(input: z.infer<typeof workerGitHistoryInputSchema>): Promise<WorkerJobResult> {
    const parsed = workerGitHistoryInputSchema.parse(input);
    const paths = this.#policies.requireReadablePaths(parsed.projectId, parsed.paths);
    return await this.#readJob(parsed.projectId, paths, [
      { kind: 'git_history', paths: [...paths], limit: parsed.limit },
    ]);
  }

  async compareRefs(input: z.infer<typeof workerCompareRefsInputSchema>): Promise<WorkerJobResult> {
    const parsed = workerCompareRefsInputSchema.parse(input);
    const policy = this.#policies.requireProject(parsed.projectId);
    return await this.#readJob(parsed.projectId, policy.readablePaths, [
      { kind: 'compare_refs', baseRef: parsed.baseRef, headRef: parsed.headRef },
    ]);
  }

  async runTestProfile(
    input: z.infer<typeof workerRunTestProfileInputSchema>,
  ): Promise<WorkerJobResult> {
    const parsed = workerRunTestProfileInputSchema.parse(input);
    this.#policies.requireTestProfile(parsed.projectId, parsed.profileId);
    requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, parsed.profileId);
    const policy = this.#policies.requireProject(parsed.projectId);
    return await this.#readJob(parsed.projectId, policy.readablePaths, [
      { kind: 'run_test_profile', profileId: parsed.profileId },
    ]);
  }

  async issueWriteApproval(
    request: ApplicationWriteApprovalRequest,
  ): Promise<ApplicationWriteApprovalReceipt> {
    const policy = this.#policies.requireProject(request.projectId);
    const pendingToken = this.#pendingApprovalTokens.get(request.projectId);
    if (pendingToken !== undefined) {
      const pending = this.#approvals.peek(pendingToken);
      if (Date.parse(pending.expiresAt) > this.#now().getTime()) {
        throw new Error('project already has a pending application-issued write approval');
      }
      this.#pendingApprovalTokens.delete(request.projectId);
    }
    const currentHead = await readLocalRepositoryHead(policy.repositoryRoot);
    if (
      !/^[0-9a-f]{40}$/i.test(request.baselineSha) ||
      request.baselineSha.toLowerCase() !== currentHead.toLowerCase()
    ) {
      throw new Error(
        'write approval baseline is stale: requested ' +
          request.baselineSha +
          ', current ' +
          currentHead,
      );
    }
    const baselineMode = resolvedSyntheticDebugBaselineMode(request.baselineMode);
    const implementationGate = canStartImplementation({
      baselineMode,
      knownGoodBaselineSha: baselineMode === 'KNOWN_GOOD' ? currentHead : null,
      baselineOwnerVerified: request.baselineOwnerVerified,
      defectReferenceSha: baselineMode === 'DEFECT_REFERENCE' ? currentHead : null,
      ...(request.defectReferenceOwnerAcknowledged === undefined
        ? {}
        : { defectReferenceOwnerAcknowledged: request.defectReferenceOwnerAcknowledged }),
      ...(request.defectReferenceEntryRequirementsSatisfied === undefined
        ? {}
        : {
            defectReferenceEntryRequirementsSatisfied:
              request.defectReferenceEntryRequirementsSatisfied,
          }),
      evidenceItems: request.problemEvidenceItems,
      rootCauseRecorded: request.rootCauseRecorded,
      ...(request.unresolvedBaselineBlocker === undefined
        ? {}
        : { unresolvedBaselineBlocker: request.unresolvedBaselineBlocker }),
    });
    if (!implementationGate.allowed) {
      throw new Error(
        'write approval blocked by Debug MVP gate: ' + implementationGate.blockers.join('; '),
      );
    }
    this.#policies.requireBranch(request.projectId, request.branch);
    const allowedPaths = this.#policies.requireWritablePaths(
      request.projectId,
      request.allowedPaths,
    );
    const inspection = inspectPatch(request.patch, allowedPaths);
    if (inspection.errors.length > 0) {
      throw new Error('write approval patch is invalid: ' + inspection.errors.join('; '));
    }
    for (const profileId of policy.requiredWriteTestProfileIds) {
      this.#policies.requireTestProfile(request.projectId, profileId);
      requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, profileId);
    }
    const grant = this.#approvals.issue({
      projectId: request.projectId,
      repositoryRoot: policy.repositoryRoot,
      baselineSha: currentHead,
      branch: request.branch,
      allowedPaths,
      patchId: request.patchId,
      patch: request.patch,
      expiresAt: request.expiresAt,
    });
    this.#pendingApprovalTokens.set(request.projectId, grant.token);
    return {
      projectId: grant.projectId,
      repositoryRoot: grant.repositoryRoot,
      baselineSha: grant.baselineSha,
      branch: grant.branch,
      allowedPaths: grant.allowedPaths,
      patchId: grant.patchId,
      patchSha256: grant.patchSha256,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
  }

  async applyApprovedPatch(
    input: z.infer<typeof workerApplyApprovedPatchInputSchema>,
  ): Promise<WorkerJobResult> {
    const parsed = workerApplyApprovedPatchInputSchema.parse(input);
    const approvalToken = this.#pendingApprovalTokens.get(parsed.projectId);
    if (approvalToken === undefined) {
      throw new Error('project has no pending application-issued write approval');
    }
    this.#pendingApprovalTokens.delete(parsed.projectId);
    const grant = this.#approvals.peek(approvalToken);
    if (grant.projectId !== parsed.projectId) {
      throw new Error('pending write approval is bound to a different project');
    }
    const policy = this.#policies.requireProject(grant.projectId);
    if (!sameRoot(policy.repositoryRoot, grant.repositoryRoot)) {
      throw new Error('write approval repository is no longer trusted for the project');
    }
    this.#policies.requireBranch(grant.projectId, grant.branch);
    this.#policies.requireWritablePaths(grant.projectId, grant.allowedPaths);
    const testActions: WorkerAction[] = policy.requiredWriteTestProfileIds.map((profileId) => {
      this.#policies.requireTestProfile(grant.projectId, profileId);
      requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, profileId);
      return { kind: 'run_test_profile', profileId };
    });
    const job: WorkerJob = {
      jobId: this.#jobIdFactory(),
      mode: 'controlled_write',
      scope: {
        projectId: grant.projectId,
        repositoryRoot: policy.repositoryRoot,
        allowedPaths: [...grant.allowedPaths],
        baselineRef: grant.baselineSha,
        branch: grant.branch,
      },
      actions: [
        {
          kind: 'apply_patch',
          patchId: grant.patchId,
          expectedBaseSha: grant.baselineSha,
        },
        ...testActions,
        { kind: 'finalize_candidate' },
      ],
      approvalToken,
    };
    return await executeLocalWorkerJob(job, {
      approvalStore: this.#approvals,
      ...(this.#workspaceBaseDir === undefined ? {} : { workspaceBaseDir: this.#workspaceBaseDir }),
      now: this.#now,
    });
  }
}

export function createWorkerAgentTools(service: WorkerAgentService) {
  return [
    tool({
      name: WORKER_AGENT_TOOL_NAMES[0],
      description: 'Read one file inside a trusted local Kingshade project scope.',
      parameters: workerInspectFileInputSchema,
      errorFunction: workerAgentToolError,
      execute: async (input) => await executeWorkerAgentTool(() => service.inspectFile(input)),
    }),
    tool({
      name: WORKER_AGENT_TOOL_NAMES[1],
      description: 'Search literal text inside trusted local Kingshade project paths.',
      parameters: workerSearchTextInputSchema,
      errorFunction: workerAgentToolError,
      execute: async (input) => await executeWorkerAgentTool(() => service.searchText(input)),
    }),
    tool({
      name: WORKER_AGENT_TOOL_NAMES[2],
      description: 'Read bounded Git history for trusted local Kingshade project paths.',
      parameters: workerGitHistoryInputSchema,
      errorFunction: workerAgentToolError,
      execute: async (input) => await executeWorkerAgentTool(() => service.gitHistory(input)),
    }),
    tool({
      name: WORKER_AGENT_TOOL_NAMES[3],
      description: 'Compare two Git refs only within a trusted Kingshade project scope.',
      parameters: workerCompareRefsInputSchema,
      errorFunction: workerAgentToolError,
      execute: async (input) => await executeWorkerAgentTool(() => service.compareRefs(input)),
    }),
    tool({
      name: WORKER_AGENT_TOOL_NAMES[4],
      description: 'Run one fixed, available test profile in an isolated local worktree.',
      parameters: workerRunTestProfileInputSchema,
      errorFunction: workerAgentToolError,
      execute: async (input) => await executeWorkerAgentTool(() => service.runTestProfile(input)),
    }),
    tool({
      name: WORKER_AGENT_TOOL_NAMES[5],
      description:
        'Consume the pending application-issued approval for a trusted project and run its bound patch and required tests.',
      parameters: workerApplyApprovedPatchInputSchema,
      needsApproval: true,
      errorFunction: workerAgentToolError,
      execute: async (input) =>
        await executeWorkerAgentTool(() => service.applyApprovedPatch(input)),
    }),
  ] as const;
}
