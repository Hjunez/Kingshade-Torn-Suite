import { RunContext, type Tool } from '@openai/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKsLeslieAgentBundle } from '../src/agents.js';
import type { KsLeslieConfig } from '../src/config.js';
import { SyntheticDebugApplicationApi } from '../src/debug/application-api.js';
import {
  DEBUG_CREATE_CASE_TOOL_NAME,
  DEBUG_INSPECT_CASE_TOOL_NAME,
  DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME,
  DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
  DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME,
  createSyntheticDebugAgentTools,
} from '../src/debug/agent-tools.js';
import type { RepositoryReader } from '../src/repository/reader.js';
import { WORKER_AGENT_TOOL_NAMES, WorkerAgentService } from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';
import {
  E2E_API_SECRET,
  E2E_SECRET,
  SyntheticDebugE2EHarness,
  intake,
  plan,
  rootCause,
} from './synthetic-debug-e2e-harness.js';

const config: KsLeslieConfig = {
  openAiModel: 'gpt-5.6-sol',
  specialistModel: 'gpt-5.6-terra',
  stateDir: '.state',
  githubRepository: 'Hjunez/Kingshade-Torn-Suite',
};
const reader: RepositoryReader = {
  resolveRef: () => Promise.resolve('a'.repeat(40)),
  readFile: (path) => Promise.resolve({ path, sha: 'blob', content: '' }),
  listCommits: () => Promise.resolve([]),
  compareRefs: () =>
    Promise.resolve({
      status: 'identical',
      aheadBy: 0,
      behindBy: 0,
      totalCommits: 0,
      files: [],
    }),
};
const harnesses: SyntheticDebugE2EHarness[] = [];
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function functionTool(tools: readonly Tool[], name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (selected?.type !== 'function') throw new Error(`Missing function tool: ${name}`);
  return selected;
}

async function invoke(tools: readonly Tool[], name: string, input: unknown): Promise<unknown> {
  // The SDK invoke contract is typed as any; the helper narrows it before use.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const value = await functionTool(tools, name).invoke(new RunContext(), JSON.stringify(input));
  if (typeof value !== 'string') return value;
  // JSON.parse is typed as any by TypeScript; this helper deliberately returns unknown.
  const parsed: unknown = JSON.parse(value) as unknown;
  return parsed;
}

async function make(options: Parameters<typeof SyntheticDebugE2EHarness.create>[0] = {}) {
  const harness = await SyntheticDebugE2EHarness.create(options);
  harnesses.push(harness);
  const api = new SyntheticDebugApplicationApi({
    orchestrator: harness.controller,
    memorySink: harness.sink,
  });
  const handle = { caseId: harness.caseId, projectId: 'synthetic' };
  return { harness, api, handle };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe('C3.13 safe agent integration boundary', () => {
  it('wires the exact role-scoped Debug topology without raw Worker or authority tools', async () => {
    const { api } = await make();
    const bundle = createKsLeslieAgentBundle(config, {
      repositoryReader: reader,
      debugApplicationApi: api,
      workerAgentService: new WorkerAgentService({
        policies: new WorkerPolicyRegistry([]),
        approvals: new WriteApprovalStore(),
      }),
    });
    const names = (agent: { tools: readonly Tool[] }) => agent.tools.map(({ name }) => name);

    expect(names(bundle.coordinator)).toEqual(
      expect.arrayContaining([
        DEBUG_CREATE_CASE_TOOL_NAME,
        DEBUG_INSPECT_CASE_TOOL_NAME,
        DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME,
      ]),
    );
    expect(names(bundle.research)).toEqual(
      expect.arrayContaining([
        DEBUG_INSPECT_CASE_TOOL_NAME,
        DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME,
        DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME,
      ]),
    );
    expect(names(bundle.engineering)).toEqual(
      expect.arrayContaining([
        DEBUG_INSPECT_CASE_TOOL_NAME,
        DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME,
        DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
        DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME,
      ]),
    );
    expect(names(bundle.review)).toEqual(
      expect.arrayContaining([DEBUG_INSPECT_CASE_TOOL_NAME, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME]),
    );
    for (const agent of [bundle.coordinator, bundle.research, bundle.review]) {
      expect(names(agent)).not.toEqual(expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]));
    }
    expect(names(bundle.engineering)).not.toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOL_NAMES]),
    );
    expect(names(bundle.coordinator)).not.toContain(DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME);
    expect(names(bundle.review)).not.toContain(DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME);

    const serializedTools = JSON.stringify(
      [bundle.coordinator, bundle.research, bundle.engineering, bundle.review].flatMap(
        ({ tools }) =>
          tools
            .filter(({ name }) => name.includes('debug_'))
            .map((candidate) => (candidate.type === 'function' ? candidate.parameters : candidate)),
      ),
    );
    expect(serializedTools).not.toMatch(
      /targetState|ownerVerification|approvalGrant|approvalToken|reviewDisposition|testReady|repositoryRoot|shell|process|command|executable/i,
    );
  });

  it('delegates the complete permitted workflow to the facade and preserves role separation', async () => {
    const { harness, api, handle } = await make();
    const coordinator = createSyntheticDebugAgentTools(api, 'coordinator');
    const research = createSyntheticDebugAgentTools(api, 'research');
    const engineering = createSyntheticDebugAgentTools(api, 'engineering');
    const review = createSyntheticDebugAgentTools(api, 'review');

    expect(
      await invoke(coordinator, DEBUG_CREATE_CASE_TOOL_NAME, { intake: intake(handle.caseId) }),
    ).toMatchObject({ ok: true, snapshot: { nextAction: { action: 'START_DISCOVERY' } } });
    expect(await invoke(coordinator, DEBUG_INSPECT_CASE_TOOL_NAME, { handle })).toMatchObject({
      ok: true,
      snapshot: { state: 'INTAKE' },
    });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'DISCOVERY' } });
    expect(
      await invoke(engineering, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, error: { code: 'TRANSITION_NOT_PERMITTED' } });
    expect(await invoke(research, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle })).toMatchObject({
      ok: true,
      snapshot: { state: 'EVIDENCE_READY' },
    });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'BASELINE_READY' } });
    expect(
      await invoke(research, DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME, {
        handle,
        rootCause: rootCause(handle.caseId),
      }),
    ).toMatchObject({ ok: true, snapshot: { state: 'ROOT_CAUSE_READY' } });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'IMPLEMENTATION_READY' } });
    expect(
      await invoke(engineering, DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, {
        handle,
        plan: plan(harness.baseline, handle.caseId),
      }),
    ).toMatchObject({ ok: true, snapshot: { state: 'AWAITING_WRITE_APPROVAL' } });
    expect(
      JSON.stringify(await invoke(engineering, DEBUG_INSPECT_CASE_TOOL_NAME, { handle })),
    ).not.toMatch(/approvalGrant|approvalToken/);
    expect(
      await invoke(engineering, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'AWAITING_WRITE_APPROVAL' } });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'IMPLEMENTING' } });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'IMPLEMENTING' } });
    expect(
      await invoke(engineering, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'VERIFYING' } });
    expect(harness.workerCalls).toBe(1);
    expect(await invoke(review, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle })).toMatchObject({
      ok: false,
      snapshot: { state: 'VERIFYING' },
    });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'REVIEWING' } });
    expect(
      await invoke(engineering, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'REVIEWING' } });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'REVIEWING' } });
    expect(await invoke(review, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle })).toMatchObject({
      ok: true,
      snapshot: { nextAction: { action: 'EVALUATE_FINAL_DELIVERY' } },
    });
    expect(harness.reviewCalls).toBe(1);
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({
      ok: true,
      snapshot: { state: 'TEST_READY', finalReport: { status: 'TEST_READY' } },
    });
    expect(
      await invoke(engineering, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'TEST_READY' } });
  });

  it('rejects forged authority fields before facade invocation and emits secret-free errors', async () => {
    const { api, handle } = await make();
    const coordinator = createSyntheticDebugAgentTools(api, 'coordinator');
    const forged = await invoke(coordinator, DEBUG_CREATE_CASE_TOOL_NAME, {
      intake: {
        ...intake(handle.caseId),
        ownerVerification: true,
        approvalGrant: E2E_SECRET,
        reviewDisposition: 'pass',
        targetState: 'TEST_READY',
      },
      repositoryRoot: 'C:/attacker',
      command: `echo ${E2E_API_SECRET}`,
    });
    expect(forged).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, snapshot: null });
    expect(JSON.stringify(forged)).not.toContain(E2E_SECRET);
    expect(JSON.stringify(forged)).not.toContain(E2E_API_SECRET);
    expect(api.getSnapshot(handle)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('surfaces BLOCKED faithfully and preserves replay without repeated trusted work', async () => {
    const { harness, api, handle } = await make({ approval: 'DENIED' });
    const coordinator = createSyntheticDebugAgentTools(api, 'coordinator');
    const research = createSyntheticDebugAgentTools(api, 'research');
    const engineering = createSyntheticDebugAgentTools(api, 'engineering');
    await invoke(coordinator, DEBUG_CREATE_CASE_TOOL_NAME, { intake: intake(handle.caseId) });
    await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle });
    await invoke(research, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle });
    await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle });
    await invoke(engineering, DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME, {
      handle,
      rootCause: rootCause(handle.caseId),
    });
    await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle });
    await invoke(engineering, DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, {
      handle,
      plan: plan(harness.baseline, handle.caseId),
    });
    const blocked = await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle });
    expect(blocked).toMatchObject({ ok: true, snapshot: { state: 'BLOCKED' } });
    expect(await invoke(coordinator, DEBUG_INSPECT_CASE_TOOL_NAME, { handle })).toEqual(blocked);
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: true, snapshot: { state: 'BLOCKED', persistenceStatus: 'PERSISTED' } });
    expect(
      await invoke(coordinator, DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME, { handle }),
    ).toMatchObject({ ok: false, snapshot: { state: 'BLOCKED', nextAction: { action: 'NONE' } } });
    expect(harness.workerCalls).toBe(0);
  });
});
