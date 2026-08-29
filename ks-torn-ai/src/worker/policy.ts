import { resolve } from 'node:path';

import { isPathAllowed, normalizeRelativeWorkerPath } from './path-policy.js';

export interface WorkerProjectPolicy {
  projectId: string;
  repositoryRoot: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  allowedTestProfileIds: readonly string[];
  requiredWriteTestProfileIds: readonly string[];
  branchPrefix: string;
}

function normalizePolicyPaths(paths: readonly string[], label: string): readonly string[] {
  if (paths.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const normalized = paths.map((path) => {
    const value = normalizeRelativeWorkerPath(path);
    if (value === null) {
      throw new Error(`${label} contains an invalid path: ${path}`);
    }
    return value;
  });
  return [...new Set(normalized)].sort();
}

function normalizePolicy(policy: WorkerProjectPolicy): WorkerProjectPolicy {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(policy.projectId)) {
    throw new Error(`invalid Worker project id: ${policy.projectId}`);
  }
  if (!/^ks-leslie\/[a-z0-9][a-z0-9._/-]*$/.test(policy.branchPrefix)) {
    throw new Error(`invalid Worker branch prefix: ${policy.branchPrefix}`);
  }
  const readablePaths = normalizePolicyPaths(policy.readablePaths, 'readablePaths');
  const writablePaths = normalizePolicyPaths(policy.writablePaths, 'writablePaths');
  const allowedTestProfileIds = [...new Set(policy.allowedTestProfileIds)].sort();
  const requiredWriteTestProfileIds = [...new Set(policy.requiredWriteTestProfileIds)].sort();
  if (requiredWriteTestProfileIds.length === 0) {
    throw new Error('Worker write policy must require at least one test profile');
  }
  for (const profileId of requiredWriteTestProfileIds) {
    if (!allowedTestProfileIds.includes(profileId)) {
      throw new Error(`required Worker test profile is not allowed: ${profileId}`);
    }
  }
  return {
    ...policy,
    repositoryRoot: resolve(policy.repositoryRoot),
    readablePaths,
    writablePaths,
    allowedTestProfileIds,
    requiredWriteTestProfileIds,
  };
}

export class WorkerPolicyRegistry {
  readonly #policies: ReadonlyMap<string, WorkerProjectPolicy>;

  constructor(policies: readonly WorkerProjectPolicy[]) {
    const entries = policies.map((policy) => {
      const normalized = normalizePolicy(policy);
      return [normalized.projectId, normalized] as const;
    });
    if (new Set(entries.map(([projectId]) => projectId)).size !== entries.length) {
      throw new Error('Worker project policy ids must be unique');
    }
    this.#policies = new Map(entries);
  }

  requireProject(projectId: string): WorkerProjectPolicy {
    const policy = this.#policies.get(projectId);
    if (policy === undefined) {
      throw new Error(`Worker project is not approved: ${projectId}`);
    }
    return policy;
  }

  requireReadablePath(projectId: string, path: string): string {
    const policy = this.requireProject(projectId);
    const normalized = normalizeRelativeWorkerPath(path);
    if (normalized === null || !isPathAllowed(normalized, policy.readablePaths)) {
      throw new Error(`path is outside the trusted read policy for ${projectId}: ${path}`);
    }
    return normalized;
  }

  requireReadablePaths(projectId: string, paths?: readonly string[]): readonly string[] {
    const policy = this.requireProject(projectId);
    return paths === undefined
      ? policy.readablePaths
      : paths.map((path) => this.requireReadablePath(projectId, path));
  }

  requireWritablePaths(projectId: string, paths: readonly string[]): readonly string[] {
    const policy = this.requireProject(projectId);
    if (paths.length === 0) {
      throw new Error('an approved write must contain at least one path');
    }
    return paths.map((path) => {
      const normalized = normalizeRelativeWorkerPath(path);
      if (normalized === null || !isPathAllowed(normalized, policy.writablePaths)) {
        throw new Error(`path is outside the trusted write policy for ${projectId}: ${path}`);
      }
      return normalized;
    });
  }

  requireTestProfile(projectId: string, profileId: string): void {
    const policy = this.requireProject(projectId);
    if (!policy.allowedTestProfileIds.includes(profileId)) {
      throw new Error(`test profile is not approved for ${projectId}: ${profileId}`);
    }
  }

  requireBranch(projectId: string, branch: string): void {
    const policy = this.requireProject(projectId);
    if (!branch.startsWith(policy.branchPrefix)) {
      throw new Error(
        `Worker branch must start with the trusted prefix ${policy.branchPrefix}: ${branch}`,
      );
    }
  }
}
