import { describe, expect, it } from 'vitest';

import { resolveProcessInvocation, runProcess } from '../src/worker/process-runner.js';

describe('process runner platform handling', () => {
  it('launches Windows npm and npx through Node instead of a command shell', () => {
    const options = {
      platform: 'win32' as const,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    };

    expect(resolveProcessInvocation('npm', ['--version'], options)).toEqual({
      executable: options.nodeExecutable,
      args: [options.npmExecPath, '--version'],
    });
    expect(resolveProcessInvocation('npx', ['vitest', '--version'], options)).toEqual({
      executable: options.nodeExecutable,
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
        'vitest',
        '--version',
      ],
    });
  });

  it('does not wrap ordinary commands or non-Windows npm commands', () => {
    expect(resolveProcessInvocation('git', ['--version'], { platform: 'win32' })).toEqual({
      executable: 'git',
      args: ['--version'],
    });
    expect(resolveProcessInvocation('npm', ['--version'], { platform: 'linux' })).toEqual({
      executable: 'npm',
      args: ['--version'],
    });
  });

  it('passes an explicit sanitized environment to the child process', async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.KS_LESLIE_TEST_VALUE ?? "missing")'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: { KS_LESLIE_TEST_VALUE: 'present' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('present');
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('executes the installed Windows npm CLI without shell mode', async () => {
    const result = await runProcess({
      executable: 'npm',
      args: ['--version'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
