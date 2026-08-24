import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runProcess } from './process-runner.js';

interface DoctorCheck {
  name: string;
  required: boolean;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

async function commandCheck(
  name: string,
  executable: string,
  args: readonly string[],
  required: boolean,
  cwd: string,
): Promise<DoctorCheck> {
  try {
    const result = await runProcess({
      executable,
      args,
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 100_000,
    });
    const detail = (result.stdout.trim() || result.stderr.trim() || `exit ${String(result.exitCode)}`).split(/\r?\n/)[0] ?? '';
    if (result.exitCode === 0 && !result.timedOut) {
      return { name, required, status: 'pass', detail };
    }
    return {
      name,
      required,
      status: required ? 'fail' : 'warn',
      detail: result.timedOut ? 'timed out' : detail,
    };
  } catch (error: unknown) {
    return {
      name,
      required,
      status: required ? 'fail' : 'warn',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function nodeCheck(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0]);
  const pass = Number.isInteger(major) && major >= 22;
  return {
    name: 'Node.js',
    required: true,
    status: pass ? 'pass' : 'fail',
    detail: process.version,
  };
}

async function repositoryCheck(repositoryRoot: string): Promise<DoctorCheck> {
  try {
    const canonical = await realpath(repositoryRoot);
    const result = await runProcess({
      executable: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: canonical,
      timeoutMs: 15_000,
      maxOutputBytes: 100_000,
    });
    if (result.exitCode !== 0) {
      return {
        name: 'Kingshade repository',
        required: true,
        status: 'fail',
        detail: result.stderr.trim() || result.stdout.trim() || 'not a Git repository',
      };
    }
    const top = await realpath(result.stdout.trim());
    const same = process.platform === 'win32' ? top.toLowerCase() === canonical.toLowerCase() : top === canonical;
    return {
      name: 'Kingshade repository',
      required: true,
      status: same ? 'pass' : 'fail',
      detail: same ? top : `expected Git top-level ${canonical}, got ${top}`,
    };
  } catch (error: unknown) {
    return {
      name: 'Kingshade repository',
      required: true,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(process.argv[2] ?? '..');
  const checks: DoctorCheck[] = [
    nodeCheck(),
    await commandCheck('Git', 'git', ['--version'], true, process.cwd()),
    await commandCheck('npm', 'npm', ['--version'], true, process.cwd()),
    await repositoryCheck(repositoryRoot),
    await commandCheck('Bash', 'bash', ['--version'], false, process.cwd()),
    await commandCheck('Docker', 'docker', ['version', '--format', '{{.Server.Version}}'], false, process.cwd()),
  ];

  const requiredFailures = checks.filter((check) => check.required && check.status !== 'pass');
  const report = {
    product: 'KS Leslie',
    component: 'Worker Doctor',
    repositoryRoot,
    readyForLocalWorker: requiredFailures.length === 0,
    checks,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (requiredFailures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
