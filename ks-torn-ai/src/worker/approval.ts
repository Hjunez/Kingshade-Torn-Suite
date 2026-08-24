import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { WorkerJob } from './contracts.js';

export interface WriteApprovalRequest {
  projectId: string;
  repositoryRoot: string;
  baselineSha: string;
  branch: string;
  allowedPaths: readonly string[];
  patchId: string;
  patch: string;
  expiresAt: Date;
}

export interface WriteApprovalGrant {
  token: string;
  projectId: string;
  repositoryRoot: string;
  baselineSha: string;
  branch: string;
  allowedPaths: readonly string[];
  patchId: string;
  patchSha256: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ConsumedWriteApproval {
  grant: WriteApprovalGrant;
  patch: string;
}

interface StoredApproval extends ConsumedWriteApproval {
  used: boolean;
}

export interface WriteApprovalStoreOptions {
  now?: () => Date;
  tokenFactory?: () => string;
}

function normalizedRoot(path: string): string {
  const root = resolve(path);
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function copyGrant(grant: WriteApprovalGrant): WriteApprovalGrant {
  return { ...grant, allowedPaths: [...grant.allowedPaths] };
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class WriteApprovalStore {
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;
  readonly #approvals = new Map<string, StoredApproval>();

  constructor(options: WriteApprovalStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
  }

  issue(request: WriteApprovalRequest): WriteApprovalGrant {
    if (!/^[0-9a-f]{40}$/i.test(request.baselineSha)) {
      throw new Error('write approval requires a full 40-character baseline SHA');
    }
    const now = this.#now();
    if (request.expiresAt.getTime() <= now.getTime()) {
      throw new Error('write approval expiry must be in the future');
    }
    const token = this.#tokenFactory();
    if (!/^[0-9a-f]{64}$/.test(token) || this.#approvals.has(token)) {
      throw new Error('write approval token factory returned an invalid or duplicate token');
    }
    const grant: WriteApprovalGrant = {
      token,
      projectId: request.projectId,
      repositoryRoot: resolve(request.repositoryRoot),
      baselineSha: request.baselineSha.toLowerCase(),
      branch: request.branch,
      allowedPaths: [...request.allowedPaths].sort(),
      patchId: request.patchId,
      patchSha256: sha256Text(request.patch),
      issuedAt: now.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
    };
    this.#approvals.set(token, { grant, patch: request.patch, used: false });
    return copyGrant(grant);
  }

  peek(token: string): WriteApprovalGrant {
    const approval = this.#approvals.get(token);
    if (approval === undefined) {
      throw new Error('write approval token is unknown');
    }
    return copyGrant(approval.grant);
  }

  consumeForJob(token: string, job: WorkerJob): ConsumedWriteApproval {
    const approval = this.#approvals.get(token);
    if (approval === undefined) {
      throw new Error('write approval token is unknown');
    }
    if (approval.used) {
      throw new Error('write approval token has already been used');
    }
    approval.used = true;

    const { grant } = approval;
    if (Date.parse(grant.expiresAt) <= this.#now().getTime()) {
      throw new Error('write approval token has expired');
    }
    const patchActions = job.actions.filter((action) => action.kind === 'apply_patch');
    const patchAction = patchActions[0];
    const mismatches: string[] = [];
    if (job.scope.projectId !== grant.projectId) mismatches.push('project');
    if (normalizedRoot(job.scope.repositoryRoot) !== normalizedRoot(grant.repositoryRoot)) {
      mismatches.push('repository');
    }
    if (job.scope.baselineRef.toLowerCase() !== grant.baselineSha) mismatches.push('baseline');
    if (job.scope.branch !== grant.branch) mismatches.push('branch');
    if (!sameStrings(job.scope.allowedPaths, grant.allowedPaths)) mismatches.push('path scope');
    if (patchAction?.patchId !== grant.patchId) mismatches.push('patch id');
    if (patchAction?.expectedBaseSha.toLowerCase() !== grant.baselineSha) {
      mismatches.push('patch baseline');
    }
    if (sha256Text(approval.patch) !== grant.patchSha256) mismatches.push('patch digest');
    if (mismatches.length > 0) {
      throw new Error(`write approval does not match Worker job: ${mismatches.join(', ')}`);
    }
    return { grant: copyGrant(grant), patch: approval.patch };
  }
}
