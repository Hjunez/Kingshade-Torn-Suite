import { RunContext, type Tool } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkerAgentService,
  WORKER_AGENT_TOOL_NAMES,
  createWorkerAgentTools,
  workerApplyApprovedPatchInputSchema,
  workerCompareRefsInputSchema,
  workerGitHistoryInputSchema,
  workerInspectFileInputSchema,
  workerRunTestProfileInputSchema,
  workerSearchTextInputSchema,
} from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';

function requireFunctionTool(tools: readonly Tool[], name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (selected?.type !== 'function') {
    throw new Error(`Missing function tool: ${name}`);
  }
  return selected;
}

describe('Worker agent boundary', () => {
  it.each([
    [workerInspectFileInputSchema, { projectId: 'synthetic', path: 'script.js' }],
    [workerSearchTextInputSchema, { projectId: 'synthetic', query: 'alpha', paths: ['script.js'] }],
    [workerGitHistoryInputSchema, { projectId: 'synthetic' }],
    [workerCompareRefsInputSchema, { projectId: 'synthetic', baseRef: 'HEAD~1', headRef: 'HEAD' }],
    [workerRunTestProfileInputSchema, { projectId: 'synthetic', profileId: 'check' }],
    [workerApplyApprovedPatchInputSchema, { projectId: 'synthetic' }],
  ])('rejects command, executable, repository, mode and scope injection', (schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    for (const property of [
      'command',
      'executable',
      'repositoryRoot',
      'allowedPaths',
      'testProfiles',
      'mode',
      'scope',
      'approved',
      'approvalToken',
      'token',
    ]) {
      expect(schema.safeParse({ ...valid, [property]: 'attacker-controlled' }).success).toBe(false);
    }
  });

  it('exposes only the exact fixed Worker tool set and requires SDK approval for writes', async () => {
    const service = new WorkerAgentService({
      policies: new WorkerPolicyRegistry([]),
      approvals: new WriteApprovalStore(),
    });
    const tools = createWorkerAgentTools(service);

    expect(tools.map((workerTool) => workerTool.name)).toEqual(WORKER_AGENT_TOOL_NAMES);
    for (const workerTool of tools.slice(0, -1)) {
      expect(
        await requireFunctionTool(tools, workerTool.name).needsApproval(new RunContext(), {
          projectId: 'synthetic',
        }),
      ).toBe(false);
    }
    expect(
      await requireFunctionTool(tools, 'worker_apply_approved_patch').needsApproval(
        new RunContext(),
        {
          projectId: 'synthetic',
        },
      ),
    ).toBe(true);
  });

  it('redacts secrets from every agent-facing Worker result string', async () => {
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
    const service = new WorkerAgentService({
      policies: new WorkerPolicyRegistry([]),
      approvals: new WriteApprovalStore(),
    });
    vi.spyOn(service, 'inspectFile').mockResolvedValue({
      jobId: 'redaction-test',
      projectId: 'synthetic',
      baselineRef: 'a'.repeat(40),
      workspaceRetained: false,
      isolatedExecution: false,
      sourceHeadSha: 'a'.repeat(40),
      headShaBefore: 'a'.repeat(40),
      headShaAfter: 'a'.repeat(40),
      changedPaths: [],
      actions: [
        {
          actionIndex: 0,
          kind: 'inspect_file',
          status: 'passed',
          startedAt: '2026-08-24T00:00:00.000Z',
          finishedAt: '2026-08-24T00:00:00.000Z',
          summary: `Read output containing ${secret}.`,
          output: `OPENAI_API_KEY=${secret}`,
        },
      ],
    });
    const tools = createWorkerAgentTools(service);

    const serialized: unknown = await requireFunctionTool(tools, 'worker_inspect_file').invoke(
      new RunContext(),
      JSON.stringify({ projectId: 'synthetic', path: 'script.js' }),
    );
    expect(String(serialized)).not.toContain(secret);
    expect(String(serialized)).toContain('Read output containing [REDACTED REPOSITORY SECRET].');
    expect(String(serialized)).toContain('OPENAI_API_KEY=[REDACTED REPOSITORY SECRET]');
    expect(String(serialized)).toContain('"agentBoundary":{"secretRedactions":2}');

    vi.spyOn(service, 'searchText').mockRejectedValue(
      new Error(`Worker command failed with ${secret}`),
    );
    const failure: unknown = await requireFunctionTool(tools, 'worker_search_literal').invoke(
      new RunContext(),
      JSON.stringify({ projectId: 'synthetic', query: 'needle' }),
    );
    const failureMessage = String(failure);
    expect(failureMessage).toContain('[REDACTED REPOSITORY SECRET]');
    expect(failureMessage).not.toContain(secret);
  });

  it('derives repository, path, test and branch authority from trusted policy', () => {
    const policies = new WorkerPolicyRegistry([
      {
        projectId: 'synthetic',
        repositoryRoot: 'C:/trusted/repository',
        readablePaths: ['src', 'tests'],
        writablePaths: ['src/worker'],
        allowedTestProfileIds: ['check'],
        requiredWriteTestProfileIds: ['check'],
        branchPrefix: 'ks-leslie/synthetic/',
      },
    ]);

    expect(policies.requireReadablePath('synthetic', 'src/index.ts')).toBe('src/index.ts');
    expect(() => policies.requireReadablePath('synthetic', 'package.json')).toThrow(
      'trusted read policy',
    );
    expect(() => policies.requireWritablePaths('synthetic', ['tests/check.ts'])).toThrow(
      'trusted write policy',
    );
    expect(() => {
      policies.requireTestProfile('synthetic', 'attacker-command');
    }).toThrow('not approved');
    expect(() => {
      policies.requireBranch('synthetic', 'main');
    }).toThrow('trusted prefix');
  });
});
