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

export interface WorkerScope {
  repositoryRoot: string;
  allowedPaths: readonly string[];
  baselineRef: string;
  branch?: string;
}

export type WorkerAction =
  | { kind: 'inspect_file'; path: string }
  | { kind: 'search_text'; query: string; paths?: readonly string[] }
  | { kind: 'git_history'; paths?: readonly string[]; limit: number }
  | { kind: 'compare_refs'; baseRef: string; headRef: string }
  | { kind: 'run_test_profile'; profileId: string }
  | { kind: 'apply_patch'; patchId: string; expectedBaseSha: string };

export interface WorkerJob {
  jobId: string;
  mode: WorkerMode;
  scope: WorkerScope;
  actions: readonly WorkerAction[];
  approvedWrite: boolean;
}

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
  artifactRefs?: readonly string[];
}

export interface WorkerJobResult {
  jobId: string;
  baselineRef: string;
  workspaceBranch?: string;
  workspacePath?: string;
  headShaBefore: string;
  headShaAfter: string;
  changedPaths: readonly string[];
  actions: readonly WorkerActionResult[];
}

const WRITE_ACTIONS = new Set<WorkerAction['kind']>(['apply_patch']);

export function workerJobContainsWrite(job: WorkerJob): boolean {
  return job.actions.some((action) => WRITE_ACTIONS.has(action.kind));
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

  if (job.mode === 'read_only' && containsWrite) {
    errors.push('read_only jobs cannot contain write actions');
  }

  if (containsWrite && !job.approvedWrite) {
    errors.push('write actions require explicit approval');
  }

  if (containsWrite && job.mode === 'controlled_write' && job.scope.branch === undefined) {
    errors.push('controlled_write jobs require an isolated branch');
  }

  if (containsWrite && !/^[0-9a-f]{40}$/i.test(job.scope.baselineRef)) {
    errors.push('controlled writes require a full 40-character baseline commit SHA');
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
