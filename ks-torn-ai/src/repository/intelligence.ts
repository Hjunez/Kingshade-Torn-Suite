import {
  selectKnownGoodBaseline,
  type BaselineDecision,
  type BaselineEvidence,
} from './baseline.js';
import { releaseEvidenceFromCommit, type GitCommitObservation } from './evidence-adapters.js';
import type { GitHubCompareFile, GitHubFileObservation } from './github-reader.js';
import { KINGSHADE_PROJECTS } from './registry.js';
import {
  resolveProject as resolveRegisteredProject,
  type ProjectDescriptor,
} from './project-state.js';
import type { RepositoryBackend, RepositoryReader } from './reader.js';
import { inspectUserscript, type UserscriptInspection } from './userscript.js';
import {
  MAX_REPOSITORY_FILE_BYTES,
  MAX_SOURCE_CHUNK_BYTES,
  MAX_SOURCE_CHUNK_LINES,
  normalizeCommitObservation,
  normalizeRepositoryPath,
  redactRepositorySecrets,
  validateHistoryLimit,
  validateRepositoryRef,
} from './validation.js';

export interface ProjectHistory {
  backend: RepositoryBackend;
  project: ProjectDescriptor;
  ref: string;
  resolvedRef: string;
  filePath: string;
  recentCommits: readonly GitCommitObservation[];
  releaseEvidence: readonly BaselineEvidence[];
  baselineDecision: BaselineDecision;
}

export interface ProjectInspection extends ProjectHistory {
  fileSha: string;
  userscript: UserscriptInspection;
}

export interface ProjectRefComparison {
  backend: RepositoryBackend;
  project: ProjectDescriptor;
  baseRef: string;
  headRef: string;
  resolvedBaseSha: string;
  resolvedHeadSha: string;
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  relevantFiles: readonly GitHubCompareFile[];
  secretRedactions: number;
}

export interface ProjectSourceChunk {
  backend: RepositoryBackend;
  project: ProjectDescriptor;
  ref: string;
  resolvedRef: string;
  filePath: string;
  fileSha: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  source: string;
  secretRedactions: number;
}

function requirePrimaryFile(project: ProjectDescriptor): string {
  const filePath = project.primaryFiles[0];
  if (filePath === undefined) {
    throw new Error(`Project has no primary file: ${project.id}`);
  }
  return filePath;
}

function validateComparisonCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Repository comparison has invalid ${field}`);
  }
}

const COMPARE_STATUSES = new Set(['identical', 'ahead', 'behind', 'diverged']);
const FILE_STATUSES = new Set([
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

function validateResolvedCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('Repository ref did not resolve to an exact commit SHA');
  }
  return value.toLowerCase();
}

function validateFileObservation(file: GitHubFileObservation, expectedPath: string): void {
  if (file.path !== expectedPath || normalizeRepositoryPath(file.path) === null) {
    throw new Error(`Repository reader returned an unexpected file path: ${file.path}`);
  }
  if (file.sha.length < 1 || file.sha.length > 128) {
    throw new Error(`Repository reader returned an invalid file SHA: ${expectedPath}`);
  }
  if (Buffer.byteLength(file.content, 'utf8') > MAX_REPOSITORY_FILE_BYTES) {
    throw new Error('Repository file exceeds the inspection limit');
  }
}

export class RepositoryIntelligenceService {
  readonly #reader: RepositoryReader;
  readonly #projects: readonly ProjectDescriptor[];

  constructor(
    reader: RepositoryReader,
    projects: readonly ProjectDescriptor[] = KINGSHADE_PROJECTS,
  ) {
    this.#reader = reader;
    this.#projects = projects;
  }

  resolveProject(query: string): ProjectDescriptor {
    const project = resolveRegisteredProject(this.#projects, query);
    if (project === null) {
      throw new Error(`Unknown Kingshade project: ${query}`);
    }
    return project;
  }

  async #backend(): Promise<RepositoryBackend> {
    return this.#reader.describeBackend === undefined
      ? 'injected'
      : await this.#reader.describeBackend();
  }

  async #history(
    project: ProjectDescriptor,
    ref: string,
    resolvedRef: string,
    commitLimit: number,
  ): Promise<ProjectHistory> {
    validateRepositoryRef(ref);
    validateHistoryLimit(commitLimit);
    const filePath = requirePrimaryFile(project);
    const [backend, commits] = await Promise.all([
      this.#backend(),
      this.#reader.listCommits({ ref: resolvedRef, path: filePath, limit: commitLimit }),
    ]);
    const recentCommits = commits.map(normalizeCommitObservation);
    const releaseEvidence = recentCommits
      .map((commit) => releaseEvidenceFromCommit(project.id, commit))
      .filter((record): record is BaselineEvidence => record !== null);

    return {
      backend,
      project,
      ref,
      resolvedRef,
      filePath,
      recentCommits,
      releaseEvidence,
      baselineDecision: selectKnownGoodBaseline(releaseEvidence, project.id),
    };
  }

  async getProjectHistory(query: string, ref = 'main', commitLimit = 20): Promise<ProjectHistory> {
    validateRepositoryRef(ref);
    validateHistoryLimit(commitLimit);
    const resolvedRef = validateResolvedCommit(await this.#reader.resolveRef(ref));
    return await this.#history(this.resolveProject(query), ref, resolvedRef, commitLimit);
  }

  async inspectProject(query: string, ref = 'main', commitLimit = 20): Promise<ProjectInspection> {
    const project = this.resolveProject(query);
    const filePath = requirePrimaryFile(project);
    validateRepositoryRef(ref);
    validateHistoryLimit(commitLimit);

    const resolvedRef = validateResolvedCommit(await this.#reader.resolveRef(ref));
    const [file, history] = await Promise.all([
      this.#reader.readFile(filePath, resolvedRef),
      this.#history(project, ref, resolvedRef, commitLimit),
    ]);
    validateFileObservation(file, filePath);

    return {
      ...history,
      fileSha: file.sha,
      userscript: inspectUserscript(file.content),
    };
  }

  async compareProjectRefs(
    query: string,
    baseRef: string,
    headRef: string,
  ): Promise<ProjectRefComparison> {
    const project = this.resolveProject(query);
    validateRepositoryRef(baseRef);
    validateRepositoryRef(headRef);
    const [backend, resolvedBaseSha, resolvedHeadSha] = await Promise.all([
      this.#backend(),
      this.#reader.resolveRef(baseRef).then(validateResolvedCommit),
      this.#reader.resolveRef(headRef).then(validateResolvedCommit),
    ]);
    const comparison = await this.#reader.compareRefs(resolvedBaseSha, resolvedHeadSha);
    if (!COMPARE_STATUSES.has(comparison.status)) {
      throw new Error('Repository comparison returned an invalid status');
    }
    validateComparisonCount(comparison.aheadBy, 'aheadBy');
    validateComparisonCount(comparison.behindBy, 'behindBy');
    validateComparisonCount(comparison.totalCommits, 'totalCommits');
    const primaryFiles = new Set(project.primaryFiles);
    const relevantFiles = comparison.files.filter((file) => {
      if (
        normalizeRepositoryPath(file.filename) === null ||
        (file.previousFilename !== undefined &&
          normalizeRepositoryPath(file.previousFilename) === null)
      ) {
        throw new Error('Repository comparison returned an invalid file path');
      }
      return (
        primaryFiles.has(file.filename) ||
        (file.previousFilename !== undefined && primaryFiles.has(file.previousFilename))
      );
    });
    let secretRedactions = 0;
    const safeRelevantFiles = relevantFiles.map((file) => {
      if (!FILE_STATUSES.has(file.status)) {
        throw new Error('Repository comparison returned an invalid file status');
      }
      const filename = redactRepositorySecrets(file.filename);
      const previousFilename =
        file.previousFilename === undefined
          ? undefined
          : redactRepositorySecrets(file.previousFilename);
      secretRedactions += filename.redactionCount + (previousFilename?.redactionCount ?? 0);
      return {
        ...file,
        filename: filename.value,
        ...(previousFilename === undefined ? {} : { previousFilename: previousFilename.value }),
      };
    });
    return {
      backend,
      project,
      baseRef,
      headRef,
      resolvedBaseSha,
      resolvedHeadSha,
      status: comparison.status,
      aheadBy: comparison.aheadBy,
      behindBy: comparison.behindBy,
      totalCommits: comparison.totalCommits,
      relevantFiles: safeRelevantFiles,
      secretRedactions,
    };
  }

  async readSourceChunk(options: {
    project: string;
    ref?: string;
    startLine: number;
    endLine: number;
  }): Promise<ProjectSourceChunk> {
    const project = this.resolveProject(options.project);
    const filePath = requirePrimaryFile(project);
    const ref = options.ref ?? 'main';
    validateRepositoryRef(ref);
    if (
      !Number.isInteger(options.startLine) ||
      !Number.isInteger(options.endLine) ||
      options.startLine < 1 ||
      options.endLine < options.startLine ||
      options.endLine - options.startLine + 1 > MAX_SOURCE_CHUNK_LINES
    ) {
      throw new Error(
        `Source chunk must be a 1-based range of at most ${String(MAX_SOURCE_CHUNK_LINES)} lines`,
      );
    }

    const [backend, file] = await Promise.all([
      this.#backend(),
      this.#reader.resolveRef(ref).then(validateResolvedCommit),
    ]);
    const resolvedRef = file;
    const observation = await this.#reader.readFile(filePath, resolvedRef);
    validateFileObservation(observation, filePath);
    const lines = observation.content.split(/\r?\n/);
    if (options.startLine > lines.length) {
      throw new Error(`Source chunk starts after the end of ${filePath}`);
    }
    const selectedLines = lines.slice(options.startLine - 1, options.endLine);
    const source = selectedLines.join('\n');
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_CHUNK_BYTES) {
      throw new Error('Source chunk exceeds the bounded output size; request a smaller range');
    }
    const redacted = redactRepositorySecrets(source);
    if (Buffer.byteLength(redacted.value, 'utf8') > MAX_SOURCE_CHUNK_BYTES) {
      throw new Error(
        'Redacted source chunk exceeds the bounded output size; request a smaller range',
      );
    }

    return {
      backend,
      project,
      ref,
      resolvedRef,
      filePath,
      fileSha: observation.sha,
      startLine: options.startLine,
      endLine: options.startLine + selectedLines.length - 1,
      totalLines: lines.length,
      source: redacted.value,
      secretRedactions: redacted.redactionCount,
    };
  }
}
