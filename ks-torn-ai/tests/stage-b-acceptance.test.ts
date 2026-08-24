import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDebugWorkflowReport } from '../src/debug/workflow.js';
import { serializeDebugDeliveryReport } from '../src/debug/report.js';
import { WorkerAgentService } from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';
import { runProcess } from '../src/worker/process-runner.js';

const cleanupPaths: string[] = [];
const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({
    executable: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'git exited ' + String(result.exitCode));
  }
  return result.stdout.trim();
}

async function snapshotFiles(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative.length === 0 ? entry.name : relative + '/' + entry.name;
    if (path === '.git' || path.startsWith('.git/')) continue;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotFiles(root, path));
    } else if (entry.isFile()) {
      result[path] = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex');
    }
  }
  return result;
}

async function sourceState(root: string) {
  return {
    head: await git(root, ['rev-parse', 'HEAD']),
    branch: await git(root, ['branch', '--show-current']),
    status: await git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    files: await snapshotFiles(root),
  };
}

async function removeWorkerWorkspace(
  sourceRoot: string,
  workspacePath: string | undefined,
  branch: string | undefined,
): Promise<void> {
  if (workspacePath !== undefined) {
    await git(sourceRoot, ['worktree', 'remove', '--force', workspacePath]);
  }
  if (branch !== undefined) {
    await git(sourceRoot, ['branch', '-D', branch]);
  }
}

function patchValue(from: string, to: string): string {
  return [
    'diff --git a/fixture.txt b/fixture.txt',
    '--- a/fixture.txt',
    '+++ b/fixture.txt',
    '@@ -1 +1 @@',
    '-' + from,
    '+' + to,
    '',
  ].join('\n');
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe('Stage B synthetic acceptance', () => {
  it('blocks a failed profile, then emits a rollback-ready report for an isolated candidate', async () => {
    const holder = await mkdtemp(join(tmpdir(), 'ks-leslie-stage-b-acceptance-'));
    cleanupPaths.push(holder);
    const root = join(holder, 'source');
    const workspaces = join(holder, 'workspaces');
    await mkdir(join(root, 'tools'), { recursive: true });
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'acceptance@example.invalid']);
    await git(root, ['config', 'user.name', 'Stage B Acceptance']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(root, 'fixture.txt'), 'alpha\n', 'utf8');
    await writeFile(join(root, 'owner-active.txt'), 'clean\n', 'utf8');
    await cp(
      join(FIXTURE_ROOT, 'fixtures', 'worker-acceptance', 'check-fixture.ts'),
      join(root, 'tools', 'run-suite-validator.mjs'),
    );
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'synthetic baseline']);
    const baseline = await git(root, ['rev-parse', 'HEAD']);

    await writeFile(join(root, 'owner-active.txt'), 'owner work in progress\n', 'utf8');
    await writeFile(join(root, 'owner-untracked.txt'), 'must survive\n', 'utf8');
    const original = await sourceState(root);

    const policies = new WorkerPolicyRegistry([
      {
        projectId: 'synthetic',
        repositoryRoot: root,
        readablePaths: ['fixture.txt', 'tools'],
        writablePaths: ['fixture.txt'],
        allowedTestProfileIds: ['suite-layout'],
        requiredWriteTestProfileIds: ['suite-layout'],
        branchPrefix: 'ks-leslie/synthetic/',
      },
    ]);
    let tokenNumber = 0;
    const approvals = new WriteApprovalStore({
      tokenFactory: () => (++tokenNumber).toString(16).padStart(64, '0'),
    });
    let jobNumber = 0;

    const makeService = () =>
      new WorkerAgentService({
        policies,
        approvals,
        workspaceBaseDir: workspaces,
        jobIdFactory: () => 'synthetic-job-' + String(++jobNumber),
      });

    const readResult = await makeService().inspectFile({
      projectId: 'synthetic',
      path: 'fixture.txt',
    });
    expect(readResult.actions[0]?.output).toBe('alpha\n');
    expect(await sourceState(root)).toEqual(original);

    const failingService = makeService();
    const failingApprovalRequest = {
      projectId: 'synthetic',
      baselineSha: baseline,
      baselineOwnerVerified: true,
      problemEvidenceItems: 1,
      rootCauseRecorded: true,
      branch: 'ks-leslie/synthetic/failing-profile',
      allowedPaths: ['fixture.txt'],
      patchId: 'make-gamma',
      patch: patchValue('alpha', 'gamma'),
      expiresAt: new Date(Date.now() + 60_000),
    } as const;
    const failingReceipt = await failingService.issueWriteApproval(failingApprovalRequest);
    expect(failingReceipt).not.toHaveProperty('token');
    await expect(
      failingService.issueWriteApproval({
        ...failingApprovalRequest,
        patchId: 'second-pending-patch',
      }),
    ).rejects.toThrow('already has a pending application-issued write approval');
    const failed = await failingService.applyApprovedPatch({
      projectId: 'synthetic',
    });
    expect(failed.actions.map((action) => action.status)).toEqual(['passed', 'failed']);
    await expect(failingService.applyApprovedPatch({ projectId: 'synthetic' })).rejects.toThrow(
      'no pending application-issued write approval',
    );
    const failedReport = buildDebugWorkflowReport({
      workflowKind: 'synthetic',
      workerResult: failed,
      baselineOwnerVerified: true,
      problemEvidence: [
        { evidenceId: 'fixture-mismatch', classification: 'SYNTHETIC', summary: 'Mismatch.' },
      ],
      rootCause: 'The failing patch creates the wrong fixture value.',
      approvedPaths: ['fixture.txt'],
      affectedSurfaces: ['synthetic fixture'],
      requiredProfileIds: ['suite-layout'],
      review: { reviewId: 'synthetic-review-failed', status: 'passed', summary: 'Reviewed.' },
      unresolvedBlockingUncertainty: [],
      unresolvedNonBlockingUncertainty: [],
    });
    expect(failedReport.status).toBe('BLOCKED');
    expect(failedReport.candidateSha).toBeNull();
    expect(failedReport.rollbackSha).toBe(baseline);
    expect(await sourceState(root)).toEqual(original);
    await removeWorkerWorkspace(root, failed.workspacePath, failed.workspaceBranch);

    const passingService = makeService();
    const passingReceipt = await passingService.issueWriteApproval({
      projectId: 'synthetic',
      baselineSha: baseline,
      baselineOwnerVerified: true,
      problemEvidenceItems: 1,
      rootCauseRecorded: true,
      branch: 'ks-leslie/synthetic/passing-profile',
      allowedPaths: ['fixture.txt'],
      patchId: 'make-beta',
      patch: patchValue('alpha', 'beta'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(passingReceipt).not.toHaveProperty('token');
    const passed = await passingService.applyApprovedPatch({
      projectId: 'synthetic',
    });
    expect(passed.actions.map((action) => action.status)).toEqual(['passed', 'passed', 'passed']);
    expect(passed.workspacePath).toBeDefined();
    expect(passed.workspaceRetained).toBe(true);
    expect(passed.changedPaths).toEqual(['fixture.txt']);
    expect(passed.headShaAfter).not.toBe(baseline);
    expect(await readFile(join(passed.workspacePath ?? '', 'fixture.txt'), 'utf8')).toBe('beta\n');

    const report = buildDebugWorkflowReport({
      workflowKind: 'synthetic',
      workerResult: passed,
      baselineOwnerVerified: true,
      problemEvidence: [
        {
          evidenceId: 'fixture-alpha',
          classification: 'SYNTHETIC',
          summary: 'The controlled fixture starts with alpha.',
        },
      ],
      rootCause: 'The fixture needs the approved beta value.',
      approvedPaths: ['fixture.txt'],
      affectedSurfaces: ['synthetic fixture'],
      requiredProfileIds: ['suite-layout'],
      review: {
        reviewId: 'synthetic-review-passed',
        status: 'passed',
        summary: 'Patch scope and evidence reviewed.',
      },
      unresolvedBlockingUncertainty: [],
      unresolvedNonBlockingUncertainty: [],
    });
    const machineReadable = JSON.parse(serializeDebugDeliveryReport(report)) as {
      status: string;
      candidateSha: string;
      rollbackSha: string;
    };
    expect(machineReadable.status).toBe('SYNTHETIC_ACCEPTED');
    expect(machineReadable.candidateSha).toBe(passed.headShaAfter);
    expect(machineReadable.rollbackSha).toBe(baseline);
    expect(await sourceState(root)).toEqual(original);
    await removeWorkerWorkspace(root, passed.workspacePath, passed.workspaceBranch);
    expect(await sourceState(root)).toEqual(original);
  }, 30_000);
});
