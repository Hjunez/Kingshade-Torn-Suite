import { z } from 'zod';

import { isPathAllowed } from './path-policy.js';

export type WorkerMode = 'read_only' | 'controlled_write';

export type WorkerCapability =
  | 'inspect_repository'
  | 'inspect_git_history'
  | 'compare_refs'
  | 'run_test_profile'
  | 'apply_patch'
  | 'create_branch'
  | 'commit_changes';

const workerPathSchema = z.string().min(1).max(500);
const gitRefSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'));

const workerActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inspect_file'), path: workerPathSchema }).strict(),
  z
    .object({
      kind: z.literal('search_text'),
      query: z.string().min(1).max(2_000),
      paths: z.array(workerPathSchema).min(1).max(50).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('git_history'),
      paths: z.array(workerPathSchema).min(1).max(50).optional(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('compare_refs'),
      baseRef: gitRefSchema,
      headRef: gitRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('run_test_profile'),
      profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('apply_patch'),
      patchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/i),
    })
    .strict(),
  z.object({ kind: z.literal('finalize_candidate') }).strict(),
]);

export const workerJobSchema = z
  .object({
    jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    mode: z.enum(['read_only', 'controlled_write']),
    scope: z
      .object({
        projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
        repositoryRoot: z.string().min(1).max(2_000),
        allowedPaths: z.array(workerPathSchema).min(1).max(100),
        baselineRef: gitRefSchema,
        branch: z.string().min(1).max(200).optional(),
      })
      .strict(),
    actions: z.array(workerActionSchema).min(1).max(20),
    approvalToken: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type WorkerAction = z.infer<typeof workerActionSchema>;
export type WorkerJob = z.infer<typeof workerJobSchema>;
export type WorkerScope = WorkerJob['scope'];

export type WorkerActionStatus = 'passed' | 'failed' | 'blocked' | 'error';

export interface WorkerActionResult {
  actionIndex: number;
  kind: WorkerAction['kind'];
  status: WorkerActionStatus;
  startedAt: string;
  finishedAt: string;
  summary: string;
  exitCode?: number;
  output?: string;
  profileId?: string;
  patchId?: string;
  artifactRefs?: readonly string[];
}

export interface WorkerJobResult {
  jobId: string;
  projectId: string;
  baselineRef: string;
  workspaceBranch?: string;
  workspacePath?: string;
  workspaceRetained: boolean;
  isolatedExecution: boolean;
  sourceHeadSha: string;
  headShaBefore: string;
  headShaAfter: string;
  changedPaths: readonly string[];
  actions: readonly WorkerActionResult[];
}

const WRITE_ACTIONS = new Set<WorkerAction['kind']>(['apply_patch', 'finalize_candidate']);

export function parseWorkerJob(input: unknown): WorkerJob {
  return workerJobSchema.parse(input);
}

export function workerJobContainsWrite(job: WorkerJob): boolean {
  return job.actions.some((action) => WRITE_ACTIONS.has(action.kind));
}

export function workerJobRunsTests(job: WorkerJob): boolean {
  return job.actions.some((action) => action.kind === 'run_test_profile');
}

function actionPaths(action: WorkerAction): readonly string[] {
  switch (action.kind) {
    case 'inspect_file':
      return [action.path];
    case 'search_text':
    case 'git_history':
      return action.paths ?? ['.'];
    default:
      return [];
  }
}

export function validateWorkerJob(job: WorkerJob): readonly string[] {
  const errors: string[] = [];
  const containsWrite = workerJobContainsWrite(job);
  const patchActions = job.actions.filter((action) => action.kind === 'apply_patch');
  const finalizeActions = job.actions.filter((action) => action.kind === 'finalize_candidate');

  if (job.mode === 'read_only' && containsWrite) {
    errors.push('read_only jobs cannot contain write actions');
  }
  if (containsWrite && job.approvalToken === undefined) {
    errors.push('write actions require an application-issued approval token');
  }
  if (containsWrite && job.scope.branch === undefined) {
    errors.push('controlled_write jobs require an isolated branch');
  }
  if (containsWrite && !/^[0-9a-f]{40}$/i.test(job.scope.baselineRef)) {
    errors.push('controlled writes require a full 40-character baseline commit SHA');
  }
  if (containsWrite && patchActions.length !== 1) {
    errors.push('controlled_write jobs require exactly one approved patch');
  }
  if (finalizeActions.length > 1) {
    errors.push('controlled_write jobs can finalize at most once');
  }
  if (
    finalizeActions.length === 1 &&
    job.actions.findIndex((action) => action.kind === 'finalize_candidate') !==
      job.actions.length - 1
  ) {
    errors.push('candidate finalization must be the final Worker action');
  }
  if (job.scope.allowedPaths.length === 0) {
    errors.push('worker scope must contain at least one allowed path');
  }

  for (const action of job.actions) {
    for (const path of actionPaths(action)) {
      if (!isPathAllowed(path, job.scope.allowedPaths)) {
        errors.push(`action path is outside worker scope: ${path}`);
      }
    }
    if (action.kind === 'apply_patch' && action.expectedBaseSha !== job.scope.baselineRef) {
      errors.push('patch expected base does not match worker baseline');
    }
  }

  return errors;
}
