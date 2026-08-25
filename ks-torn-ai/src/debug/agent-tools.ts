import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';

import {
  type SyntheticDebugApplicationResult,
  type SyntheticDebugCaseHandle,
  SyntheticDebugApplicationApi,
} from './application-api.js';
import {
  syntheticDebugImplementationPlanRecordSchema,
  syntheticDebugIntakeRecordSchema,
  syntheticDebugRootCauseRecordSchema,
} from './records.js';

export type SyntheticDebugAgentRole = 'coordinator' | 'research' | 'engineering' | 'review';

export const DEBUG_CREATE_CASE_TOOL_NAME = 'create_debug_case' as const;
export const DEBUG_INSPECT_CASE_TOOL_NAME = 'inspect_debug_case' as const;
export const DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME = 'request_debug_next_action' as const;
export const DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME = 'submit_debug_root_cause' as const;
export const DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME =
  'submit_debug_implementation_plan' as const;

const handleSchema = z
  .object({
    caseId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    projectId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  })
  .strict();

const requestSchema = z.object({ handle: handleSchema }).strict();
const createSchema = z.object({ intake: syntheticDebugIntakeRecordSchema }).strict();
const rootCauseSchema = z
  .object({ handle: handleSchema, rootCause: syntheticDebugRootCauseRecordSchema })
  .strict();
const implementationPlanSchema = z
  .object({ handle: handleSchema, plan: syntheticDebugImplementationPlanRecordSchema })
  .strict();

function safeFailure(result: SyntheticDebugApplicationResult): SyntheticDebugApplicationResult {
  return result;
}

function blocked(api: SyntheticDebugApplicationApi, handle: SyntheticDebugCaseHandle) {
  const current = api.getSnapshot(handle);
  if (!current.ok) return current;
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: 'TRANSITION_NOT_PERMITTED' as const,
      message: 'This agent role cannot request the current debug operation.',
      state: current.snapshot.state,
    }),
    snapshot: current.snapshot,
  });
}

async function requestNext(
  api: SyntheticDebugApplicationApi,
  role: SyntheticDebugAgentRole,
  handle: SyntheticDebugCaseHandle,
): Promise<SyntheticDebugApplicationResult> {
  const current = api.getSnapshot(handle);
  if (!current.ok) return safeFailure(current);
  const action = current.snapshot.nextAction.action;

  if (role === 'coordinator') {
    switch (action) {
      case 'START_DISCOVERY':
        return api.startDiscovery(handle);
      case 'RESOLVE_BASELINE':
        return await api.resolveTrustedBaseline(handle);
      case 'EVALUATE_IMPLEMENTATION_GATE':
        return api.evaluateImplementationGate(handle);
      case 'AWAIT_APPROVAL_DECISION':
        return await api.resolveWriteApproval(handle);
      case 'EVALUATE_VERIFICATION':
        return await api.evaluateVerification(handle);
      case 'EVALUATE_FINAL_DELIVERY':
        return await api.evaluateFinalDelivery(handle);
      case 'PERSIST_OUTCOME':
        return await api.persistOutcome(handle);
      default:
        return blocked(api, handle);
    }
  }
  if (role === 'research' && action === 'COLLECT_EVIDENCE') {
    return await api.completeDiscovery(handle);
  }
  if (role === 'engineering' && action === 'EXECUTE_APPROVED_IMPLEMENTATION') {
    return await api.executeApprovedImplementation(handle);
  }
  if (role === 'review' && action === 'REQUEST_INDEPENDENT_REVIEW') {
    return await api.requestIndependentReview(handle);
  }
  return blocked(api, handle);
}

const safeToolError = () =>
  JSON.stringify({
    ok: false,
    error: { code: 'INVALID_INPUT', message: 'The requested debug operation was rejected.' },
    snapshot: null,
  });

export function createSyntheticDebugAgentTools(
  api: SyntheticDebugApplicationApi,
  role: SyntheticDebugAgentRole,
): readonly Tool[] {
  const inspect = tool({
    name: DEBUG_INSPECT_CASE_TOOL_NAME,
    description:
      'Inspect the frozen, secret-free Debug case snapshot and authoritative next action.',
    parameters: requestSchema,
    errorFunction: safeToolError,
    execute: ({ handle }) => api.getSnapshot(handle),
  });
  const request = tool({
    name: DEBUG_REQUEST_NEXT_ACTION_TOOL_NAME,
    description:
      'Request the current role-permitted application action. The application chooses and validates the transition; no target state or authority can be supplied.',
    parameters: requestSchema,
    errorFunction: safeToolError,
    execute: async ({ handle }) => await requestNext(api, role, handle),
  });

  if (role === 'coordinator') {
    return [
      tool({
        name: DEBUG_CREATE_CASE_TOOL_NAME,
        description:
          'Submit strict model-safe Debug intake through the trusted application parser.',
        parameters: createSchema,
        errorFunction: safeToolError,
        execute: ({ intake }) => api.createCase(intake),
      }),
      inspect,
      request,
    ];
  }
  if (role === 'research') {
    return [
      inspect,
      tool({
        name: DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME,
        description:
          'Submit bounded evidence-linked analysis. It remains model evidence and cannot establish owner verification.',
        parameters: rootCauseSchema,
        errorFunction: safeToolError,
        execute: ({ handle, rootCause }) => api.recordEvidenceAndRootCause(handle, rootCause),
      }),
      request,
    ];
  }
  if (role === 'engineering') {
    return [
      inspect,
      tool({
        name: DEBUG_SUBMIT_ROOT_CAUSE_TOOL_NAME,
        description:
          'Submit a bounded evidence-linked root-cause proposal for application validation.',
        parameters: rootCauseSchema,
        errorFunction: safeToolError,
        execute: ({ handle, rootCause }) => api.recordEvidenceAndRootCause(handle, rootCause),
      }),
      tool({
        name: DEBUG_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
        description:
          'Submit a proposal-only bounded implementation plan. Trusted application code derives and requests approval; no grant, repository root, or command is accepted.',
        parameters: implementationPlanSchema,
        errorFunction: safeToolError,
        execute: ({ handle, plan }) => api.requestWriteApproval(handle, plan),
      }),
      request,
    ];
  }
  return [inspect, request];
}
