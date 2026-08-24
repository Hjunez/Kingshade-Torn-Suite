export type ProjectLifecycle = 'release' | 'test' | 'candidate' | 'experimental' | 'unknown';
export type PlatformTarget = 'torn_pda' | 'mobile_browser' | 'desktop_browser';

export interface ProjectDescriptor {
  id: string;
  displayName: string;
  aliases: readonly string[];
  primaryFiles: readonly string[];
  testProfiles: readonly string[];
  platformTargets: readonly PlatformTarget[];
}

export interface RepositorySnapshot {
  repository: string;
  branch: string;
  headSha: string;
  observedAt: string;
  workingTree: 'clean' | 'dirty' | 'unknown';
}

export interface ProjectRevision {
  projectId: string;
  commitSha: string;
  version?: string;
  lifecycle: ProjectLifecycle;
  observedAt: string;
  source: 'git' | 'manifest' | 'owner' | 'ci';
}

export interface ProjectState {
  descriptor: ProjectDescriptor;
  snapshot: RepositorySnapshot;
  currentRevision: ProjectRevision | null;
  knownGoodCommitSha: string | null;
  unresolvedUncertainty: readonly string[];
}

export function normalizeProjectKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function resolveProject(
  projects: readonly ProjectDescriptor[],
  query: string,
): ProjectDescriptor | null {
  const key = normalizeProjectKey(query);
  const matches = projects.filter((project) => {
    const keys = [project.id, project.displayName, ...project.aliases].map(normalizeProjectKey);
    return keys.includes(key);
  });

  if (matches.length > 1) {
    throw new Error(`Ambiguous project query: ${query}`);
  }

  return matches[0] ?? null;
}
