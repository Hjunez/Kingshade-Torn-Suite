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
  artifactRefs?: readonly string[];
}

export interface WorkerJobResult {
  jobId: string;
  baselineRef: string;
  headShaBefore: string;
  headShaAfter: string;
  changedPaths: readonly string[];
  actions: readonly WorkerActionResult[];
}

const WRITE_ACTIONS = new Set<WorkerAction['kind']>(['apply_patch']);

export function validateWorkerJob(job: WorkerJob): readonly string[] {
  const errors: string[] = [];

  if (job.mode === 'read_only' && job.actions.some((action) => WRITE_ACTIONS.has(action.kind))) {
    errors.push('read_only jobs cannot contain write actions');
  }

  if (!job.approvedWrite && job.actions.some((action) => WRITE_ACTIONS.has(action.kind))) {
    errors.push('write actions require explicit approval');
  }

  if (job.scope.allowedPaths.length === 0) {
    errors.push('worker scope must contain at least one allowed path');
  }

  return errors;
}
