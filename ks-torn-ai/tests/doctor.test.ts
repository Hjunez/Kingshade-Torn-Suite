import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalPathsEqual,
  normalizeGitHubRepository,
  runWorkerDoctor,
  type DoctorCheckId,
} from '../src/worker/doctor.js';
import type { ProcessRunRequest, ProcessRunResult } from '../src/worker/process-runner.js';

const HEAD_SHA = 'a'.repeat(40);

interface DoctorRunnerOptions {
  topLevel?: string;
  origin?: string;
  branch?: string;
  headSha?: string;
  unavailable?: readonly string[];
}

function processResult(request: ProcessRunRequest, stdout: string, exitCode = 0): ProcessRunResult {
  return {
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    outputTruncated: false,
  };
}

function doctorRunner(options: DoctorRunnerOptions = {}) {
  return (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    if (options.unavailable?.includes(request.executable) === true) {
      return Promise.reject(new Error(`${request.executable} unavailable`));
    }

    const command = `${request.executable} ${request.args.join(' ')}`;
    switch (command) {
      case 'git --version':
        return Promise.resolve(processResult(request, 'git version 2.55.0.windows.5\n'));
      case 'npm --version':
        return Promise.resolve(processResult(request, '11.17.0\n'));
      case 'git rev-parse --show-toplevel':
        return Promise.resolve(processResult(request, `${options.topLevel ?? request.cwd}\n`));
      case 'git remote get-url origin':
        return Promise.resolve(
          processResult(
            request,
            `${options.origin ?? 'https://github.com/Hjunez/Kingshade-Torn-Suite.git'}\n`,
          ),
        );
      case 'git branch --show-current':
        return Promise.resolve(
          processResult(request, `${options.branch ?? 'feature/ks-torn-ai-v0.1-bootstrap'}\n`),
        );
      case 'git rev-parse HEAD':
        return Promise.resolve(processResult(request, `${options.headSha ?? HEAD_SHA}\n`));
      case 'bash --version':
        return Promise.resolve(processResult(request, 'GNU bash 5.2\n'));
      case 'docker version --format {{.Server.Version}}':
        return Promise.resolve(processResult(request, '28.0.0\n'));
      default:
        return Promise.reject(new Error(`Unexpected command: ${command}`));
    }
  };
}

function checkStatus(report: Awaited<ReturnType<typeof runWorkerDoctor>>, id: DoctorCheckId) {
  return report.checks.find((check) => check.id === id)?.status;
}

describe('Worker Doctor', () => {
  it('returns a deterministic ready report with selected workspace details', async () => {
    const repositoryRoot = resolve('doctor-fixture-repository');
    const report = await runWorkerDoctor({
      repositoryRoot,
      dependencies: {
        runProcess: doctorRunner({ unavailable: ['bash', 'docker'] }),
        realpath: (path) => Promise.resolve(path),
        platform: 'win32',
        nodeVersion: '24.19.0',
        nodeVersionDetail: 'v24.19.0',
      },
    });

    expect(report.readyForLocalWorker).toBe(true);
    expect(report.expectedRepository).toBe('Hjunez/Kingshade-Torn-Suite');
    expect(report.workspace).toEqual({
      requestedPath: repositoryRoot,
      canonicalPath: repositoryRoot,
      branch: 'feature/ks-torn-ai-v0.1-bootstrap',
      headSha: HEAD_SHA,
      platform: 'win32',
    });
    expect(report.checks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'node', status: 'pass' },
      { id: 'git', status: 'pass' },
      { id: 'npm', status: 'pass' },
      { id: 'repository_top_level', status: 'pass' },
      { id: 'repository_identity', status: 'pass' },
      { id: 'selected_workspace', status: 'pass' },
      { id: 'bash', status: 'warn' },
      { id: 'docker', status: 'warn' },
    ]);
  });

  it('fails readiness for an old Node runtime or the wrong repository identity', async () => {
    const repositoryRoot = resolve('doctor-fixture-repository');
    const report = await runWorkerDoctor({
      repositoryRoot,
      dependencies: {
        runProcess: doctorRunner({ origin: 'https://github.com/elsewhere/repository.git' }),
        realpath: (path) => Promise.resolve(path),
        nodeVersion: '21.7.3',
        nodeVersionDetail: 'v21.7.3',
      },
    });

    expect(report.readyForLocalWorker).toBe(false);
    expect(checkStatus(report, 'node')).toBe('fail');
    expect(checkStatus(report, 'repository_identity')).toBe('fail');
    expect(report.checks.find((check) => check.id === 'repository_identity')?.detail).toContain(
      'expected Hjunez/Kingshade-Torn-Suite',
    );
  });

  it('rejects a selected path that is not the exact Git top-level', async () => {
    const repositoryRoot = resolve('doctor-fixture-repository');
    const otherRoot = resolve('different-repository');
    const report = await runWorkerDoctor({
      repositoryRoot,
      dependencies: {
        runProcess: doctorRunner({ topLevel: otherRoot }),
        realpath: (path) => Promise.resolve(path),
      },
    });

    expect(report.readyForLocalWorker).toBe(false);
    expect(checkStatus(report, 'repository_top_level')).toBe('fail');
    expect(checkStatus(report, 'selected_workspace')).toBe('fail');
  });

  it('normalizes supported GitHub origin forms without accepting another host', () => {
    expect(normalizeGitHubRepository('https://github.com/Hjunez/Kingshade-Torn-Suite.git')).toBe(
      'Hjunez/Kingshade-Torn-Suite',
    );
    expect(normalizeGitHubRepository('git@github.com:Hjunez/Kingshade-Torn-Suite.git')).toBe(
      'Hjunez/Kingshade-Torn-Suite',
    );
    expect(normalizeGitHubRepository('ssh://git@github.com/Hjunez/Kingshade-Torn-Suite.git')).toBe(
      'Hjunez/Kingshade-Torn-Suite',
    );
    expect(
      normalizeGitHubRepository('https://evil.example/Hjunez/Kingshade-Torn-Suite.git'),
    ).toBeNull();
    expect(normalizeGitHubRepository('https://github.com/../repository.git')).toBeNull();
  });

  it('compares canonical Windows paths case-insensitively with either separator', () => {
    expect(
      canonicalPathsEqual(
        'C:\\Users\\Owner\\KS Leslie\\leslie-stage-b',
        'c:/users/owner/ks leslie/leslie-stage-b',
        'win32',
      ),
    ).toBe(true);
    expect(canonicalPathsEqual('/Repo', '/repo', 'linux')).toBe(false);
  });

  it('accepts repository identity overrides only through validated trusted options', async () => {
    await expect(
      runWorkerDoctor({
        repositoryRoot: resolve('doctor-fixture-repository'),
        trustedExpectedRepository: '../repository',
      }),
    ).rejects.toThrow('owner/name');
  });
});
