import { realpath } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProcess, type ProcessRunRequest, type ProcessRunResult } from './process-runner.js';

export const DEFAULT_KINGSHADE_REPOSITORY = 'Hjunez/Kingshade-Torn-Suite';

export type DoctorCheckId =
  | 'node'
  | 'git'
  | 'npm'
  | 'repository_top_level'
  | 'repository_identity'
  | 'selected_workspace'
  | 'bash'
  | 'docker';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: DoctorCheckId;
  name: string;
  required: boolean;
  status: DoctorCheckStatus;
  detail: string;
}

export interface WorkerDoctorWorkspace {
  requestedPath: string;
  canonicalPath: string | null;
  branch: string | null;
  headSha: string | null;
  platform: NodeJS.Platform;
}

export interface WorkerDoctorReport {
  product: 'KS Leslie';
  component: 'Worker Doctor';
  repositoryRoot: string;
  expectedRepository: string;
  workspace: WorkerDoctorWorkspace;
  readyForLocalWorker: boolean;
  checks: readonly DoctorCheck[];
}

type DoctorProcessRunner = (request: ProcessRunRequest) => Promise<ProcessRunResult>;
type DoctorRealpath = (path: string) => Promise<string>;

export interface WorkerDoctorDependencies {
  runProcess?: DoctorProcessRunner;
  realpath?: DoctorRealpath;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  nodeVersionDetail?: string;
}

export interface WorkerDoctorOptions {
  repositoryRoot: string;
  trustedExpectedRepository?: string;
  dependencies?: WorkerDoctorDependencies;
}

interface CommandObservation {
  passed: boolean;
  detail: string;
  stdout: string;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? '';
}

async function observeCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  processRunner: DoctorProcessRunner,
): Promise<CommandObservation> {
  try {
    const result = await processRunner({
      executable,
      args,
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 100_000,
    });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const detail = firstLine(stdout || stderr || `exit ${String(result.exitCode)}`);
    return {
      passed: result.exitCode === 0 && !result.timedOut,
      detail: result.timedOut ? 'timed out' : detail,
      stdout,
    };
  } catch (error: unknown) {
    return {
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
      stdout: '',
    };
  }
}

function commandCheck(
  id: DoctorCheckId,
  name: string,
  required: boolean,
  observation: CommandObservation,
): DoctorCheck {
  return {
    id,
    name,
    required,
    status: observation.passed ? 'pass' : required ? 'fail' : 'warn',
    detail: observation.detail,
  };
}

function nodeCheck(nodeVersion: string, nodeVersionDetail: string): DoctorCheck {
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  const pass = Number.isInteger(major) && major >= 22;
  return {
    id: 'node',
    name: 'Node.js',
    required: true,
    status: pass ? 'pass' : 'fail',
    detail: nodeVersionDetail,
  };
}

export function canonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
  }
  return left === right;
}

function isRepositoryComponent(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isRepositoryIdentity(value: string): boolean {
  const components = value.split('/');
  return (
    components.length === 2 &&
    components[0] !== undefined &&
    components[1] !== undefined &&
    isRepositoryComponent(components[0]) &&
    isRepositoryComponent(components[1])
  );
}

export function normalizeGitHubRepository(remoteUrl: string): string | null {
  const value = firstLine(remoteUrl);
  const match =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i.exec(value) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(value) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i.exec(value);
  const owner = match?.[1];
  const rawName = match?.[2];
  if (owner === undefined || rawName === undefined) {
    return null;
  }
  const name = rawName.replace(/\.git$/i, '');
  return isRepositoryComponent(owner) && isRepositoryComponent(name) ? `${owner}/${name}` : null;
}

function requiredCheck(
  id: DoctorCheckId,
  name: string,
  passed: boolean,
  detail: string,
): DoctorCheck {
  return { id, name, required: true, status: passed ? 'pass' : 'fail', detail };
}

export async function runWorkerDoctor(options: WorkerDoctorOptions): Promise<WorkerDoctorReport> {
  const expectedRepository = options.trustedExpectedRepository ?? DEFAULT_KINGSHADE_REPOSITORY;
  if (!isRepositoryIdentity(expectedRepository)) {
    throw new Error('trustedExpectedRepository must be in owner/name form');
  }

  const dependencies = options.dependencies ?? {};
  const processRunner = dependencies.runProcess ?? runProcess;
  const canonicalize = dependencies.realpath ?? realpath;
  const platform = dependencies.platform ?? process.platform;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeVersionDetail = dependencies.nodeVersionDetail ?? process.version;
  const requestedPath = resolve(options.repositoryRoot);

  let canonicalPath: string | null = null;
  let canonicalPathError = '';
  try {
    canonicalPath = await canonicalize(requestedPath);
  } catch (error: unknown) {
    canonicalPathError = error instanceof Error ? error.message : String(error);
  }
  const commandCwd = canonicalPath ?? requestedPath;

  const gitObservation = await observeCommand('git', ['--version'], commandCwd, processRunner);
  const npmObservation = await observeCommand('npm', ['--version'], commandCwd, processRunner);
  const topLevelObservation = await observeCommand(
    'git',
    ['rev-parse', '--show-toplevel'],
    commandCwd,
    processRunner,
  );

  let canonicalTopLevel: string | null = null;
  let topLevelError = topLevelObservation.detail;
  if (topLevelObservation.passed && topLevelObservation.stdout.length > 0) {
    try {
      canonicalTopLevel = await canonicalize(firstLine(topLevelObservation.stdout));
    } catch (error: unknown) {
      topLevelError = error instanceof Error ? error.message : String(error);
    }
  }
  const topLevelMatches =
    canonicalPath !== null &&
    canonicalTopLevel !== null &&
    canonicalPathsEqual(canonicalPath, canonicalTopLevel, platform);
  const topLevelDetail: string = topLevelMatches
    ? (canonicalTopLevel ?? requestedPath)
    : canonicalPath === null
      ? canonicalPathError
      : canonicalTopLevel === null
        ? topLevelError
        : `expected Git top-level ${canonicalPath}, got ${canonicalTopLevel}`;

  const originObservation = await observeCommand(
    'git',
    ['remote', 'get-url', 'origin'],
    commandCwd,
    processRunner,
  );
  const actualRepository = originObservation.passed
    ? normalizeGitHubRepository(originObservation.stdout)
    : null;
  const repositoryMatches =
    actualRepository !== null &&
    actualRepository.toLowerCase() === expectedRepository.toLowerCase();
  const identityDetail = repositoryMatches
    ? actualRepository
    : originObservation.passed
      ? `expected ${expectedRepository}, got ${actualRepository ?? firstLine(originObservation.stdout)}`
      : originObservation.detail;

  const branchObservation = await observeCommand(
    'git',
    ['branch', '--show-current'],
    commandCwd,
    processRunner,
  );
  const headObservation = await observeCommand(
    'git',
    ['rev-parse', 'HEAD'],
    commandCwd,
    processRunner,
  );
  const branch =
    branchObservation.passed && branchObservation.stdout.length > 0
      ? firstLine(branchObservation.stdout)
      : null;
  const headCandidate = headObservation.passed ? firstLine(headObservation.stdout) : '';
  const headSha = /^[0-9a-f]{40}$/i.test(headCandidate) ? headCandidate : null;
  const selectedWorkspacePasses = topLevelMatches && branch !== null && headSha !== null;
  const workspaceDetail: string = selectedWorkspacePasses
    ? `${canonicalPath ?? requestedPath} | branch ${branch} | HEAD ${headSha} | platform ${platform}`
    : !topLevelMatches
      ? topLevelDetail
      : branch === null
        ? branchObservation.detail || 'workspace is detached or has no current branch'
        : headObservation.detail || 'workspace HEAD is not a full commit SHA';

  const bashObservation = await observeCommand('bash', ['--version'], commandCwd, processRunner);
  const dockerObservation = await observeCommand(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    commandCwd,
    processRunner,
  );

  const checks: DoctorCheck[] = [
    nodeCheck(nodeVersion, nodeVersionDetail),
    commandCheck('git', 'Git', true, gitObservation),
    commandCheck('npm', 'npm', true, npmObservation),
    requiredCheck('repository_top_level', 'Repository top-level', topLevelMatches, topLevelDetail),
    requiredCheck(
      'repository_identity',
      'Kingshade repository identity',
      repositoryMatches,
      identityDetail,
    ),
    requiredCheck(
      'selected_workspace',
      'Selected Leslie workspace',
      selectedWorkspacePasses,
      workspaceDetail,
    ),
    commandCheck('bash', 'Bash', false, bashObservation),
    commandCheck('docker', 'Docker', false, dockerObservation),
  ];

  const requiredFailures = checks.filter((check) => check.required && check.status !== 'pass');
  return {
    product: 'KS Leslie',
    component: 'Worker Doctor',
    repositoryRoot: canonicalPath ?? requestedPath,
    expectedRepository,
    workspace: {
      requestedPath,
      canonicalPath,
      branch,
      headSha,
      platform,
    },
    readyForLocalWorker: requiredFailures.length === 0,
    checks,
  };
}

export async function main(): Promise<void> {
  const report = await runWorkerDoctor({ repositoryRoot: process.argv[2] ?? '..' });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.readyForLocalWorker) {
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
