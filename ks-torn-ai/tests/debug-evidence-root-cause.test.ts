import { describe, expect, it, vi } from 'vitest';

import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugTaskDRequest,
} from '../src/debug/orchestrator.js';
import type {
  SyntheticDebugIntakeRecord,
  SyntheticDebugRootCauseRecord,
  TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';

const BASELINE_SHA = 'a'.repeat(40);
const CURRENT_SHA = 'b'.repeat(40);

const intake = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'INTAKE',
  caseId: 'synthetic-case-c3-4',
  projectId: 'synthetic',
  problem: 'The synthetic fixture has a reproducible regression.',
  affectedSurfaces: ['synthetic fixture'],
  evidenceReferences: [
    {
      evidenceId: 'synthetic-reproduction',
      kind: 'SYNTHETIC_FIXTURE',
      reference: 'fixture:deterministic-regression',
    },
  ],
} as const satisfies SyntheticDebugIntakeRecord;

const rootCause = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'ROOT_CAUSE',
  caseId: intake.caseId,
  projectId: intake.projectId,
  rootCauseId: 'root-cause-c3-4',
  explanation: 'The fixture retained the old deterministic value.',
  evidenceReferences: ['synthetic-reproduction'],
  status: 'verified',
  confidence: 'high',
  unresolvedUncertainty: [],
} as const satisfies SyntheticDebugRootCauseRecord;

const trustedBaseline = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'BASELINE',
  caseId: intake.caseId,
  projectId: intake.projectId,
  sourceBoundary: 'TRUSTED_APPLICATION',
  commitSha: BASELINE_SHA,
  provenance: 'owner_verification',
  sourceReference: 'owner:c3-4-baseline',
  ownerVerification: {
    status: 'OWNER_VERIFIED',
    evidenceReference: 'owner:c3-4-baseline',
  },
  knownBlockers: [],
} as const satisfies TrustedSyntheticDebugBaselineRecord;

interface ControllerOptions {
  readonly baseline?: unknown;
  readonly calls?: string[];
}

function controllerFor(options: ControllerOptions = {}): SyntheticDebugDiscoveryController {
  return createSyntheticDebugDiscoveryController({
    taskD: {
      authorize: vi.fn((request: SyntheticDebugTaskDRequest) => {
        options.calls?.push(`authorize:${request.operation}`);
        return true;
      }),
      readRepositoryDiscovery: vi.fn(() => {
        options.calls?.push('repository');
        return {
          currentCandidate: {
            commitSha: CURRENT_SHA,
            observedAt: '2026-08-24T10:00:00.000Z',
            sourceReference: 'repository:c3-4-current',
          },
          baselineEvidence: [],
        };
      }),
      readAuthorizedMemoryEvidence: vi.fn(() => {
        options.calls?.push('memory');
        return {
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            {
              sourceReference: trustedBaseline.sourceReference,
              evidence: {
                project: intake.projectId,
                commitSha: BASELINE_SHA,
                state: 'verified_good',
                source: 'owner_verification',
                observedAt: '2026-08-23T10:00:00.000Z',
              },
            },
          ],
        };
      }),
      readTrustedBaseline: vi.fn(() => {
        options.calls?.push('baseline');
        return options.baseline === undefined ? trustedBaseline : options.baseline;
      }),
    },
  });
}

function discoveryState(
  controller: SyntheticDebugDiscoveryController,
  intakeInput: SyntheticDebugIntakeRecord = intake,
): SyntheticDebugOrchestrationSnapshot {
  const created = controller.createCase(intakeInput);
  if (!created.ok) throw new Error(created.error.message);
  const started = controller.startDiscovery(created.snapshot);
  if (!started.ok) throw new Error(started.error.message);
  return started.snapshot;
}

async function evidenceReadyState(
  controller: SyntheticDebugDiscoveryController,
  intakeInput: SyntheticDebugIntakeRecord = intake,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const completed = await controller.completeDiscovery(discoveryState(controller, intakeInput));
  if (!completed.ok) throw new Error(completed.error.message);
  return completed.snapshot;
}

async function baselineReadyState(
  controller: SyntheticDebugDiscoveryController,
  intakeInput: SyntheticDebugIntakeRecord = intake,
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const resolved = await controller.resolveTrustedBaseline(
    await evidenceReadyState(controller, intakeInput),
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  if (resolved.snapshot.machine.state !== 'BASELINE_READY') {
    throw new Error(`Expected BASELINE_READY, received ${resolved.snapshot.machine.state}`);
  }
  return resolved.snapshot;
}

describe('C3.4 evidence and root-cause implementation gates', () => {
  it('progresses from BASELINE_READY through ROOT_CAUSE_READY to IMPLEMENTATION_READY', async () => {
    const calls: string[] = [];
    const controller = controllerFor({ calls });
    const baselineReady = await baselineReadyState(controller);
    const input = structuredClone(rootCause);
    const before = JSON.stringify(input);

    const recorded = controller.recordEvidenceAndRootCause(baselineReady, input);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect(recorded.transition).toMatchObject({
      event: 'MARK_ROOT_CAUSE_READY',
      from: 'BASELINE_READY',
      to: 'ROOT_CAUSE_READY',
      reasons: [{ code: 'EVIDENCE_AND_ROOT_CAUSE_RECORDED' }],
    });
    expect(recorded.snapshot.rootCause).toEqual(rootCause);
    expect(recorded.snapshot.rootCause).not.toBe(input);
    expect(recorded.snapshot.reproducibleDefectEvidence).toEqual(intake.evidenceReferences);
    expect(recorded.snapshot.implementationGate).toBeNull();

    const ready = controller.evaluateImplementationGate(recorded.snapshot);
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error(ready.error.message);
    expect(ready.status).toBe('ADVANCED');
    expect(ready.transition).toMatchObject({
      event: 'MARK_IMPLEMENTATION_READY',
      from: 'ROOT_CAUSE_READY',
      to: 'IMPLEMENTATION_READY',
      reasons: [{ code: 'IMPLEMENTATION_GATE_PASSED' }],
    });
    expect(ready.snapshot.implementationGate).toEqual({ allowed: true, blockers: [] });
    expect(ready.snapshot.machine.history.map(({ event }) => event)).toEqual([
      'START_DISCOVERY',
      'MARK_EVIDENCE_READY',
      'MARK_BASELINE_READY',
      'MARK_ROOT_CAUSE_READY',
      'MARK_IMPLEMENTATION_READY',
    ]);
    expect(ready.snapshot.machine.state).toBe('IMPLEMENTATION_READY');
    expect(ready.snapshot.machine.outcome).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(ready.snapshot)).toBe(true);
    expect(Object.isFrozen(ready.snapshot.rootCause)).toBe(true);
    expect(Object.isFrozen(ready.snapshot.implementationGate?.blockers)).toBe(true);
    expect(calls).toEqual([
      'authorize:READ_ONLY_DISCOVERY',
      'repository',
      'memory',
      'authorize:RESOLVE_TRUSTED_BASELINE',
      'baseline',
    ]);
  });

  it('blocks implementation when current-case evidence is absent or not reproducible', async () => {
    const nonReproducibleIntake = {
      ...intake,
      evidenceReferences: [
        {
          evidenceId: 'user-claim-only',
          kind: 'USER_PROVIDED' as const,
          reference: 'user:unreproduced-claim',
        },
      ],
    };
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller, nonReproducibleIntake);
    const recorded = controller.recordEvidenceAndRootCause(baselineReady, {
      ...rootCause,
      evidenceReferences: ['user-claim-only'],
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect(recorded.snapshot.machine.state).toBe('ROOT_CAUSE_READY');
    expect(recorded.snapshot.reproducibleDefectEvidence).toEqual([]);

    const blocked = controller.evaluateImplementationGate(recorded.snapshot);
    expect(blocked).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        implementationGate: {
          allowed: false,
          blockers: ['no reproducible defect evidence collected'],
        },
      },
      transition: {
        reasons: [
          {
            code: 'IMPLEMENTATION_GATE_BLOCKER',
            summary: 'no reproducible defect evidence collected',
          },
        ],
      },
    });

    const emptyController = controllerFor();
    const emptyBaselineReady = await baselineReadyState(emptyController, {
      ...intake,
      evidenceReferences: [],
    });
    const emptyBlocked = emptyController.recordEvidenceAndRootCause(emptyBaselineReady, null);
    expect(emptyBlocked).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        implementationGate: {
          allowed: false,
          blockers: [
            'no reproducible defect evidence collected',
            'root cause has not been recorded',
          ],
        },
      },
    });
  });

  it('maps an absent root cause through the existing gate directly to BLOCKED', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);

    const blocked = controller.recordEvidenceAndRootCause(baselineReady, null);
    expect(blocked).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: {
        rootCause: null,
        machine: { state: 'BLOCKED', outcome: 'FAILURE' },
        implementationGate: {
          allowed: false,
          blockers: ['root cause has not been recorded'],
        },
      },
      transition: {
        from: 'BASELINE_READY',
        to: 'BLOCKED',
        reasons: [
          {
            code: 'IMPLEMENTATION_GATE_BLOCKER',
            summary: 'root cause has not been recorded',
          },
        ],
      },
    });
  });

  it('cannot pass Task E after C3.3 blocks an unverified or unresolved baseline', async () => {
    const blockedBaselines = [
      {
        ...trustedBaseline,
        provenance: 'release_record' as const,
        sourceReference: 'release:unverified-baseline',
        ownerVerification: { status: 'UNVERIFIED' as const, evidenceReference: null },
      },
      {
        ...trustedBaseline,
        knownBlockers: ['Owner verification is still under review.'],
      },
    ];

    for (const baseline of blockedBaselines) {
      const controller = controllerFor({ baseline });
      const resolved = await controller.resolveTrustedBaseline(
        await evidenceReadyState(controller),
      );
      if (!resolved.ok) throw new Error(resolved.error.message);
      expect(resolved.snapshot.machine.state).toBe('BLOCKED');
      expect(controller.recordEvidenceAndRootCause(resolved.snapshot, rootCause)).toMatchObject({
        ok: false,
        snapshot: resolved.snapshot,
        error: { code: 'TERMINAL_STATE', state: 'BLOCKED' },
      });
    }
  });

  it('cannot pass Task E after C3.2 parsing fails a non-full trusted baseline SHA', async () => {
    const controller = controllerFor({
      baseline: { ...trustedBaseline, commitSha: 'a'.repeat(39) },
    });
    const failed = await controller.resolveTrustedBaseline(await evidenceReadyState(controller));
    if (!failed.ok) throw new Error(failed.error.message);
    expect(failed).toMatchObject({
      status: 'FAILED',
      snapshot: { machine: { state: 'FAILED', outcome: 'FAILURE' } },
      transition: { reasons: [{ code: 'MALFORMED_TRUSTED_BASELINE' }] },
    });
    expect(controller.recordEvidenceAndRootCause(failed.snapshot, rootCause)).toMatchObject({
      ok: false,
      snapshot: failed.snapshot,
      error: { code: 'TERMINAL_STATE', state: 'FAILED' },
    });
  });

  it('rejects evidence that is foreign to or ambiguous in the active case', async () => {
    const controller = controllerFor();
    expect(
      controller.createCase({
        ...intake,
        evidenceReferences: [
          {
            ...intake.evidenceReferences[0],
            reference: ' ',
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'MALFORMED_MODEL_RECORD' } });
    const baselineReady = await baselineReadyState(controller);
    const foreignEvidence = controller.recordEvidenceAndRootCause(baselineReady, {
      ...rootCause,
      evidenceReferences: ['evidence-from-another-case'],
    });
    expect(foreignEvidence).toMatchObject({
      ok: false,
      snapshot: baselineReady,
      error: { code: 'EVIDENCE_SCOPE_MISMATCH', state: 'BASELINE_READY' },
    });

    const corrupted = structuredClone(baselineReady);
    Object.assign(corrupted.intake, { caseId: 'different-case' });
    const wrongContainer = controller.recordEvidenceAndRootCause(corrupted, rootCause);
    expect(wrongContainer).toMatchObject({
      ok: false,
      snapshot: corrupted,
      error: { code: 'EVIDENCE_SCOPE_MISMATCH', state: 'BASELINE_READY' },
    });
  });

  it('rejects root-cause records from another case or project', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);

    for (const mismatch of [{ caseId: 'different-case' }, { projectId: 'different-project' }]) {
      expect(
        controller.recordEvidenceAndRootCause(baselineReady, { ...rootCause, ...mismatch }),
      ).toMatchObject({
        ok: false,
        snapshot: baselineReady,
        error: { code: 'ROOT_CAUSE_SCOPE_MISMATCH', state: 'BASELINE_READY' },
      });
    }
  });

  it('rejects model attempts to self-authorize evidence, root cause, or transitions', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);
    const attempts = [
      { sourceBoundary: 'TRUSTED_APPLICATION' },
      { authority: 'APPROVED' },
      { baselineOwnerVerified: true },
      { state: 'ROOT_CAUSE_READY' },
      { event: 'MARK_ROOT_CAUSE_READY' },
      { role: 'ENGINEERING' },
    ];

    for (const attempt of attempts) {
      expect(
        controller.recordEvidenceAndRootCause(baselineReady, { ...rootCause, ...attempt }),
      ).toMatchObject({
        ok: false,
        snapshot: baselineReady,
        error: { code: 'MALFORMED_MODEL_RECORD', state: 'BASELINE_READY' },
      });
    }
    expect(baselineReady.rootCause).toBeNull();
    expect(baselineReady.machine.state).toBe('BASELINE_READY');
  });

  it('preserves a hypothesis and blocks it as unresolved without promoting confidence', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);
    const hypothesis = {
      ...rootCause,
      status: 'hypothesis' as const,
      confidence: 'low' as const,
      unresolvedUncertainty: ['The suspected branch has not been isolated.'],
    };
    const recorded = controller.recordEvidenceAndRootCause(baselineReady, hypothesis);
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect(recorded.snapshot.rootCause).toEqual(hypothesis);

    const blocked = controller.evaluateImplementationGate(recorded.snapshot);
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.snapshot.rootCause).toEqual(hypothesis);
    expect(blocked.snapshot.implementationGate?.blockers).toEqual([
      'blocking uncertainty: root cause status remains hypothesis',
      'blocking uncertainty: The suspected branch has not been isolated.',
    ]);
  });

  it('blocks explicit unresolved uncertainty even when root-cause status is verified', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);
    const uncertain = {
      ...rootCause,
      unresolvedUncertainty: ['The second affected surface is not bounded yet.'],
    };
    const recorded = controller.recordEvidenceAndRootCause(baselineReady, uncertain);
    if (!recorded.ok) throw new Error(recorded.error.message);

    const blocked = controller.evaluateImplementationGate(recorded.snapshot);
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.snapshot.rootCause).toEqual(uncertain);
    expect(blocked.snapshot.implementationGate?.blockers).toEqual([
      'blocking uncertainty: The second affected surface is not bounded yet.',
    ]);
  });

  it('handles duplicate and replayed inputs deterministically without mutation', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);
    const input = structuredClone(rootCause);
    const before = JSON.stringify({ baselineReady, input });

    const first = controller.recordEvidenceAndRootCause(baselineReady, input);
    const second = controller.recordEvidenceAndRootCause(baselineReady, input);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify({ baselineReady, input })).toBe(before);
    if (!first.ok) throw new Error(first.error.message);
    expect(controller.recordEvidenceAndRootCause(first.snapshot, input)).toMatchObject({
      ok: false,
      snapshot: first.snapshot,
      error: { code: 'OUT_OF_ORDER', state: 'ROOT_CAUSE_READY' },
    });

    expect(
      controller.recordEvidenceAndRootCause(baselineReady, {
        ...rootCause,
        evidenceReferences: ['synthetic-reproduction', 'synthetic-reproduction'],
      }),
    ).toMatchObject({
      ok: false,
      snapshot: baselineReady,
      error: { code: 'MALFORMED_MODEL_RECORD', state: 'BASELINE_READY' },
    });
  });

  it('rejects skipped Task E transitions and preserves terminal snapshots', async () => {
    const controller = controllerFor();
    const baselineReady = await baselineReadyState(controller);
    expect(controller.evaluateImplementationGate(baselineReady)).toMatchObject({
      ok: false,
      snapshot: baselineReady,
      error: { code: 'OUT_OF_ORDER', state: 'BASELINE_READY' },
    });

    const blocked = controller.recordEvidenceAndRootCause(baselineReady, null);
    if (!blocked.ok) throw new Error(blocked.error.message);
    for (const result of [
      controller.recordEvidenceAndRootCause(blocked.snapshot, rootCause),
      controller.evaluateImplementationGate(blocked.snapshot),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        snapshot: blocked.snapshot,
        error: { code: 'TERMINAL_STATE', state: 'BLOCKED' },
      });
      if (result.ok) throw new Error('Expected terminal-state rejection');
      expect(result.snapshot).toBe(blocked.snapshot);
    }
  });

  it('keeps Worker internals, patch, verification decisions, and review unavailable', () => {
    const controller = controllerFor();
    expect(Object.keys(controller).sort()).toEqual([
      'completeDiscovery',
      'createCase',
      'evaluateImplementationGate',
      'executeApprovedImplementation',
      'recordEvidenceAndRootCause',
      'requestWriteApproval',
      'resolveTrustedBaseline',
      'resolveWriteApproval',
      'startDiscovery',
    ]);
    for (const forbidden of [
      'grantWriteApproval',
      'createPatchRequest',
      'createWriteProposal',
      'callWorker',
      'startImplementation',
      'startReview',
    ]) {
      expect(controller).not.toHaveProperty(forbidden);
    }
  });
});
