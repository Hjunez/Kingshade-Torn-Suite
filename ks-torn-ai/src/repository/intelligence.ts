import type { BaselineEvidence } from './baseline.js';
import { releaseEvidenceFromCommit, type GitCommitObservation } from './evidence-adapters.js';
import type { GitHubCompareFile } from './github-reader.js';
import { KINGSHADE_PROJECTS } from './registry.js';
import { resolveProject, type ProjectDescriptor } from './project-state.js';
import type { RepositoryReader } from './reader.js';
import { inspectUserscript, type UserscriptInspection } from './userscript.js';

export interface ProjectInspection {
  project: ProjectDescriptor;
  ref: string;
  filePath: string;
  fileSha: string;
  userscript: UserscriptInspection;
  recentCommits: readonly GitCommitObservation[];
  releaseEvidence: readonly BaselineEvidence[];
}

export interface ProjectRefComparison {
  project: ProjectDescriptor;
  baseRef: string;
  headRef: string;
  status: string;
  aheadBy: number;
  behindBy: number;
  relevantFiles: readonly GitHubCompareFile[];
}

export class RepositoryIntelligenceService {
  readonly #reader: RepositoryReader;
  readonly #projects: readonly ProjectDescriptor[];

  constructor(reader: RepositoryReader, projects: readonly ProjectDescriptor[] = KINGSHADE_PROJECTS) {
    this.#reader = reader;
    this.#projects = projects;
  }

  #requireProject(query: string): ProjectDescriptor {
    const project = resolveProject(this.#projects, query);
    if (project === null) {
      throw new Error(`Unknown Kingshade project: ${query}`);
    }
    return project;
  }

  async inspectProject(query: string, ref = 'main', commitLimit = 20): Promise<ProjectInspection> {
    const project = this.#requireProject(query);
    const filePath = project.primaryFiles[0];
    if (filePath === undefined) {
      throw new Error(`Project has no primary file: ${project.id}`);
    }

    const [file, recentCommits] = await Promise.all([
      this.#reader.readFile(filePath, ref),
      this.#reader.listCommits({ ref, path: filePath, limit: commitLimit }),
    ]);
    const releaseEvidence = recentCommits
      .map((commit) => releaseEvidenceFromCommit(project.id, commit))
      .filter((record): record is BaselineEvidence => record !== null);

    return {
      project,
      ref,
      filePath,
      fileSha: file.sha,
      userscript: inspectUserscript(file.content),
      recentCommits,
      releaseEvidence,
    };
  }

  async compareProjectRefs(
    query: string,
    baseRef: string,
    headRef: string,
  ): Promise<ProjectRefComparison> {
    const project = this.#requireProject(query);
    const comparison = await this.#reader.compareRefs(baseRef, headRef);
    const primaryFiles = new Set(project.primaryFiles);
    return {
      project,
      baseRef,
      headRef,
      status: comparison.status,
      aheadBy: comparison.aheadBy,
      behindBy: comparison.behindBy,
      relevantFiles: comparison.files.filter((file) => primaryFiles.has(file.filename)),
    };
  }

  async readSourceChunk(options: {
    project: string;
    ref?: string;
    startLine: number;
    endLine: number;
  }): Promise<string> {
    const project = this.#requireProject(options.project);
    const filePath = project.primaryFiles[0];
    if (filePath === undefined) {
      throw new Error(`Project has no primary file: ${project.id}`);
    }
    if (
      !Number.isInteger(options.startLine) ||
      !Number.isInteger(options.endLine) ||
      options.startLine < 1 ||
      options.endLine < options.startLine ||
      options.endLine - options.startLine + 1 > 400
    ) {
      throw new Error('Source chunk must be a 1-based range of at most 400 lines');
    }

    const file = await this.#reader.readFile(filePath, options.ref ?? 'main');
    return file.content.split(/\r?\n/).slice(options.startLine - 1, options.endLine).join('\n');
  }
}
