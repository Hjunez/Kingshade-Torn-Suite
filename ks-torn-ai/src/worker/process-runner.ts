import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export interface ProcessRunRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessRunResult {
  executable: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export interface ProcessInvocation {
  executable: string;
  args: readonly string[];
}

export interface ProcessInvocationOptions {
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  npmExecPath?: string;
}

export function resolveProcessInvocation(
  executable: string,
  args: readonly string[],
  options: ProcessInvocationOptions = {},
): ProcessInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || (executable !== 'npm' && executable !== 'npx')) {
    return { executable, args };
  }

  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const configuredNpmPath = options.npmExecPath;
  const npmCliPath =
    configuredNpmPath !== undefined &&
    win32.basename(configuredNpmPath).toLowerCase() === 'npm-cli.js'
      ? configuredNpmPath
      : win32.join(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cliPath =
    executable === 'npm' ? npmCliPath : win32.join(win32.dirname(npmCliPath), 'npx-cli.js');

  return {
    executable: nodeExecutable,
    args: [cliPath, ...args],
  };
}

function appendCapped(
  current: Buffer,
  chunk: Buffer,
  cap: number,
): { buffer: Buffer; truncated: boolean } {
  if (current.length >= cap) {
    return { buffer: current, truncated: chunk.length > 0 };
  }
  const remaining = cap - current.length;
  if (chunk.length <= remaining) {
    return { buffer: Buffer.concat([current, chunk]), truncated: false };
  }
  return { buffer: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

export async function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('maxOutputBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive safe integer');
  }

  return await new Promise<ProcessRunResult>((resolve, reject) => {
    const invocation = resolveProcessInvocation(request.executable, request.args);
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd: request.cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, request.timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const result = appendCapped(stdout, buffer, maxOutputBytes);
      stdout = result.buffer;
      outputTruncated ||= result.truncated;
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const result = appendCapped(stderr, buffer, maxOutputBytes);
      stderr = result.buffer;
      outputTruncated ||= result.truncated;
    });

    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        exitCode,
        signal,
        timedOut,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        outputTruncated,
      });
    });
  });
}
