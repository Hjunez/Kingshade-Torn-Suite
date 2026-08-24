import { describe, expect, it, vi } from 'vitest';

import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugTaskDOperation,
  type SyntheticDebugTaskDRequest,
} from '../src/debug/orchestrator.js';
import type {
  ModelSyntheticDebugRecord,
  TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';

const BASELINE_SHA = 'a'.repeat(40);
const CURRENT_SHA = 'b'.repeat(40);
const CONFLICTING_SHA = 'c'.repeat(40);

const intake = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'INTAKE',
  caseId: 'synthetic-case-c3-3',
  projectId: 'synthetic',
  problem: 'The synthetic fixture has a deterministic regression.',
  affectedSurfaces: ['synthetic fixture'],
  evidenceReferences: [
    {
      evidenceId: 'synthetic-reproduction',
      kind: 'SYNTHETIC_FIXTURE',
      reference: 'fixture:deterministic-regression',
    },
  ],
} as const satisfies ModelSyntheticDebugRecord;

const trustedBaseline = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'BASELINE',
  caseId: intake.caseId,
  projectId: intake.projectId,
  sourceBoundary: 'TRUSTED_APPLICATION',
  commitSha: BASELINE_SHA,
  provenance: 'owner_verification',
  sourceReference: 'owner:baseline-a',
  ownerVerification: {
    status: 'OWNER_VERIFIED',
    evidenceReference: 'owner:baseline-a',
  },
  knownBlockers: [],
} as const satisfies TrustedSyntheticDebugBaselineRecord;

function evidence(
  commitSha: string,
  state: 'verified_good' | 'failed' | 'candidate' | 'unknown',
  source: 'owner_verification' | 'regression_suite' | 'release_record' | 'manual_review',
  observedAt: string,
  sourceReference: string,
) {
  return {
    sourceReference,
    evidence: {
      project: intake.projectId,
      commitSha,
      state,
      source,
      observedAt,
    },
  } as const;
}

interface CapabilityOptions {
  readonly repository?: unknown;
  readonly memory?: unknown;
  readonly baseline?: unknown;
  readonly deniedOperation?: SyntheticDebugTaskDOperation;
  readonly malformedAuthorization?: boolean;
  readonly repositoryError?: Error;
  readonly calls?: string[];
  readonly requests?: SyntheticDebugTaskDRequest[];
}

function dependencies(options: CapabilityOptions = {}) {
  return {
    taskD: {
      authorize: vi.fn((request: SyntheticDebugTaskDRequest) => {
        options.calls?.push(`authorize:${request.operation}`);
        options.requests?.push(request);
        if (options.malformedAuthorization === true) return 'not-a-decision';
        return request.operation !== options.deniedOperation;
      }),
      readRepositoryDiscovery: vi.fn((request: SyntheticDebugTaskDRequest) => {
        options.calls?.push('repository');
        options.requests?.push(request);
        if (options.repositoryError !== undefined) throw options.repositoryError;
        return (
          options.repository ?? {
            currentCandidate: {
              commitSha: CURRENT_SHA,
              observedAt: '2026-01-03T00:00:00.000Z',
              sourceReference: 'repository:current-b',
            },
            baselineEvidence: [
              evidence(
                CURRENT_SHA,
                'verified_good',
                'release_record',
                '2026-01-03T00:00:00.000Z',
                'release:current-b',
              ),
            ],
          }
        );
      }),
      readAuthorizedMemoryEvidence: vi.fn((request: SyntheticDebugTaskDRequest) => {
        options.calls?.push('memory');
        options.requests?.push(request);
        return (
          options.memory ?? {
            authorizationAppliedBeforeRanking: true,
            baselineEvidence: [
              evidence(
                BASELINE_SHA,
                'verified_good',
                'owner_verification',
                '2026-01-01T00:00:00.000Z',
                trustedBaseline.sourceReference,
              ),
            ],
          }
        );
      }),
      readTrustedBaseline: vi.fn((request: SyntheticDebugTaskDRequest) => {
        options.calls?.push('baseline');
        options.requests?.push(request);
        return options.baseline === undefined ? trustedBaseline : options.baseline;
      }),
    },
  };
}

function createdSnapshot(
  controller = createSyntheticDebugDiscoveryController(dependencies()),
): SyntheticDebugOrchestrationSnapshot {
  const created = controller.createCase(intake);
  if (!created.ok) throw new Error(created.error.message);
  return created.snapshot;
}

function discoverySnapshot(
  controller = createSyntheticDebugDiscoveryController(dependencies()),
): SyntheticDebugOrchestrationSnapshot {
  const started = controller.startDiscovery(createdSnapshot(controller));
  if (!started.ok) throw new Error(started.error.message);
  return started.snapshot;
}

async function evidenceReadySnapshot(
  controller = createSyntheticDebugDiscoveryController(dependencies()),
): Promise<SyntheticDebugOrchestrationSnapshot> {
  const completed = await controller.completeDiscovery(discoverySnapshot(controller));
  if (!completed.ok) throw new Error(completed.error.message);
  return completed.snapshot;
}

describe('C3.3 synthetic discovery and baseline orchestrator', () => {
  it('progresses explicitly through BASELINE_READY with candidate and known-good separated', async () => {
    const calls: string[] = [];
    const requests: SyntheticDebugTaskDRequest[] = [];
    const baselineInput = structuredClone(trustedBaseline);
    const baselineBefore = JSON.stringify(baselineInput);
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({ calls, requests, baseline: baselineInput }),
    );
    const intakeInput = structuredClone(intake);
    const intakeBefore = JSON.stringify(intakeInput);

    const created = controller.createCase(intakeInput);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    expect(created.snapshot.machine.state).toBe('INTAKE');

    const started = controller.startDiscovery(created.snapshot);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.transition).toMatchObject({
      event: 'START_DISCOVERY',
      from: 'INTAKE',
      to: 'DISCOVERY',
      reasons: [{ code: 'INTAKE_ACCEPTED' }],
    });

    const completed = await controller.completeDiscovery(started.snapshot);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.transition).toMatchObject({
      event: 'MARK_EVIDENCE_READY',
      from: 'DISCOVERY',
      to: 'EVIDENCE_READY',
      reasons: [{ code: 'READ_ONLY_DISCOVERY_COMPLETED' }],
    });
    expect(completed.snapshot.discovery).toMatchObject({
      currentCandidate: { commitSha: CURRENT_SHA, confidence: 'CANDIDATE' },
      knownGoodResolution: { status: 'RESOLVED', commitSha: BASELINE_SHA },
    });
    expect(completed.snapshot.knownGoodBaseline).toBeNull();

    const resolved = await controller.resolveTrustedBaseline(completed.snapshot);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.transition).toMatchObject({
      event: 'MARK_BASELINE_READY',
      from: 'EVIDENCE_READY',
      to: 'BASELINE_READY',
      reasons: [{ code: 'OWNER_VERIFIED_BASELINE_RESOLVED' }],
    });
    expect(resolved.snapshot.machine.history.map(({ event }) => event)).toEqual([
      'START_DISCOVERY',
      'MARK_EVIDENCE_READY',
      'MARK_BASELINE_READY',
    ]);
    expect(resolved.snapshot.discovery?.currentCandidate?.commitSha).toBe(CURRENT_SHA);
    expect(resolved.snapshot.knownGoodBaseline?.commitSha).toBe(BASELINE_SHA);
    expect(calls).toEqual([
      'authorize:READ_ONLY_DISCOVERY',
      'repository',
      'memory',
      'authorize:RESOLVE_TRUSTED_BASELINE',
      'baseline',
    ]);
    expect(requests.map(({ accessMode }) => accessMode)).toEqual([
      'READ_ONLY',
      'READ_ONLY',
      'READ_ONLY',
      'READ_ONLY',
      'READ_ONLY',
    ]);
    expect(JSON.stringify(intakeInput)).toBe(intakeBefore);
    expect(JSON.stringify(baselineInput)).toBe(baselineBefore);
    expect(resolved.snapshot.intake).not.toBe(intakeInput);
    expect(resolved.snapshot.knownGoodBaseline).not.toBe(baselineInput);
    expect(Object.isFrozen(resolved.snapshot)).toBe(true);
    expect(Object.isFrozen(resolved.snapshot.discovery?.baselineEvidence)).toBe(true);
    expect(Object.isFrozen(resolved.snapshot.knownGoodBaseline?.knownBlockers)).toBe(true);
  });

  it('rejects out-of-order and later-checkpoint records without calling the capability', async () => {
    const calls: string[] = [];
    const controller = createSyntheticDebugDiscoveryController(dependencies({ calls }));
    const intakeState = createdSnapshot(controller);

    const prematureDiscovery = await controller.completeDiscovery(intakeState);
    expect(prematureDiscovery).toMatchObject({
      ok: false,
      snapshot: intakeState,
      error: { code: 'OUT_OF_ORDER', state: 'INTAKE' },
    });
    const prematureBaseline = await controller.resolveTrustedBaseline(intakeState);
    expect(prematureBaseline).toMatchObject({
      ok: false,
      snapshot: intakeState,
      error: { code: 'OUT_OF_ORDER', state: 'INTAKE' },
    });
    expect(calls).toEqual([]);

    expect(
      controller.createCase({
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'ROOT_CAUSE',
        caseId: intake.caseId,
        projectId: intake.projectId,
        rootCauseId: 'future-root-cause',
        explanation: 'Task E is intentionally not implemented in C3.3.',
        evidenceReferences: ['synthetic-reproduction'],
        status: 'verified',
        confidence: 'high',
        unresolvedUncertainty: [],
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_RECORD_KIND' } });
    expect(
      controller.createCase({
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'IMPLEMENTATION_PLAN',
        caseId: intake.caseId,
        projectId: intake.projectId,
        planId: 'future-plan',
        authority: 'PROPOSAL_ONLY',
        allowedPaths: ['fixture.txt'],
        requiredTestProfileIds: ['synthetic-check'],
        boundedChangeSummary: 'Task E remains outside C3.3.',
        rollbackSha: BASELINE_SHA,
        rollbackRef: BASELINE_SHA,
        proposedIsolatedBranch: 'ks-leslie/synthetic/future-plan',
        proposedWorkspaceId: 'future-workspace',
      }),
    ).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_RECORD_KIND' } });
  });

  it('rejects specialist attempts to self-authorize, self-transition, or supply trusted data', async () => {
    const controller = createSyntheticDebugDiscoveryController(dependencies());
    for (const role of ['RESEARCH', 'ENGINEERING', 'REVIEW'] as const) {
      expect(
        controller.createCase({
          ...intake,
          role,
          capabilities: ['AUTHORIZED_MEMORY_READ'],
          state: 'BASELINE_READY',
          event: 'MARK_BASELINE_READY',
        }),
      ).toMatchObject({ ok: false, error: { code: 'MALFORMED_MODEL_RECORD' } });
    }
    expect(controller.createCase(trustedBaseline)).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_MODEL_RECORD' },
    });

    const spoofController = createSyntheticDebugDiscoveryController(
      dependencies({ baseline: { ...trustedBaseline, role: 'ENGINEERING' } }),
    );
    const spoofed = await spoofController.resolveTrustedBaseline(
      await evidenceReadySnapshot(spoofController),
    );
    expect(spoofed).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'MALFORMED_TRUSTED_BASELINE' }] },
    });
  });

  it('blocks missing or denied injected authority before reads', async () => {
    const missingController = createSyntheticDebugDiscoveryController();
    const missing = await missingController.completeDiscovery(discoverySnapshot(missingController));
    expect(missing).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      snapshot: { machine: { state: 'BLOCKED', outcome: 'FAILURE' } },
      transition: { reasons: [{ code: 'READ_ONLY_DISCOVERY_CAPABILITY_MISSING' }] },
    });

    const discoveryCalls: string[] = [];
    const deniedDiscoveryController = createSyntheticDebugDiscoveryController(
      dependencies({ deniedOperation: 'READ_ONLY_DISCOVERY', calls: discoveryCalls }),
    );
    const deniedDiscovery = await deniedDiscoveryController.completeDiscovery(
      discoverySnapshot(deniedDiscoveryController),
    );
    expect(deniedDiscovery).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      transition: { reasons: [{ code: 'DISCOVERY_AUTHORIZATION_DENIED' }] },
    });
    expect(discoveryCalls).toEqual(['authorize:READ_ONLY_DISCOVERY']);

    const baselineCalls: string[] = [];
    const deniedBaselineController = createSyntheticDebugDiscoveryController(
      dependencies({ deniedOperation: 'RESOLVE_TRUSTED_BASELINE', calls: baselineCalls }),
    );
    const deniedBaseline = await deniedBaselineController.resolveTrustedBaseline(
      await evidenceReadySnapshot(deniedBaselineController),
    );
    expect(deniedBaseline).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      transition: { reasons: [{ code: 'BASELINE_AUTHORIZATION_DENIED' }] },
    });
    expect(baselineCalls.at(-1)).toBe('authorize:RESOLVE_TRUSTED_BASELINE');
    expect(baselineCalls).not.toContain('baseline');
  });

  it('does not promote newest, release, CI-like, or newest-memory evidence', async () => {
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({
        repository: {
          currentCandidate: {
            commitSha: CURRENT_SHA,
            observedAt: '2026-03-03T00:00:00.000Z',
            sourceReference: 'repository:newest-b',
          },
          baselineEvidence: [
            evidence(
              CURRENT_SHA,
              'verified_good',
              'release_record',
              '2026-03-03T00:00:00.000Z',
              'release:newest-b',
            ),
          ],
        },
        memory: {
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            evidence(
              CONFLICTING_SHA,
              'verified_good',
              'regression_suite',
              '2026-03-04T00:00:00.000Z',
              'ci:newest-memory-c',
            ),
          ],
        },
        baseline: null,
      }),
    );
    const ready = await evidenceReadySnapshot(controller);
    expect(ready.discovery).toMatchObject({
      currentCandidate: { commitSha: CURRENT_SHA },
      knownGoodResolution: { status: 'MISSING', commitSha: null, consideredCommits: 2 },
    });

    const blocked = await controller.resolveTrustedBaseline(ready);
    expect(blocked).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      transition: { reasons: [{ code: 'OWNER_VERIFIED_BASELINE_MISSING' }] },
    });
  });

  it('blocks contradictory active owner baselines and preserves all trusted blockers', async () => {
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({
        memory: {
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            evidence(
              BASELINE_SHA,
              'verified_good',
              'owner_verification',
              '2026-01-01T00:00:00.000Z',
              trustedBaseline.sourceReference,
            ),
            evidence(
              CONFLICTING_SHA,
              'verified_good',
              'owner_verification',
              '2026-02-01T00:00:00.000Z',
              'owner:baseline-c',
            ),
          ],
        },
        baseline: {
          ...trustedBaseline,
          knownBlockers: ['Owner verification is under review.'],
        },
      }),
    );
    const ready = await evidenceReadySnapshot(controller);
    expect(ready.discovery?.knownGoodResolution).toEqual({
      status: 'CONFLICT',
      commitSha: null,
      sourceReferences: [],
      conflictingCommitShas: [BASELINE_SHA, CONFLICTING_SHA],
      consideredCommits: 3,
    });

    const blocked = await controller.resolveTrustedBaseline(ready);
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.transition.reasons.map(({ code }) => code)).toEqual([
      'CONTRADICTORY_OWNER_VERIFIED_BASELINES',
      'BASELINE_KNOWN_BLOCKER',
    ]);
  });

  it('normalizes SHA case and retains later failure evidence that invalidates confidence', async () => {
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({
        repository: {
          currentCandidate: {
            commitSha: CURRENT_SHA.toUpperCase(),
            observedAt: '2026-01-02T00:00:00.000Z',
            sourceReference: 'repository:current-b',
          },
          baselineEvidence: [
            evidence(
              CURRENT_SHA,
              'failed',
              'regression_suite',
              '2026-01-04T00:00:00.000Z',
              'test:failed-b',
            ),
          ],
        },
        memory: {
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            evidence(
              BASELINE_SHA.toUpperCase(),
              'verified_good',
              'owner_verification',
              '2026-01-01T00:00:00.000Z',
              trustedBaseline.sourceReference,
            ),
            evidence(
              BASELINE_SHA,
              'failed',
              'regression_suite',
              '2026-01-05T00:00:00.000Z',
              'test:failed-a',
            ),
          ],
        },
      }),
    );
    const ready = await evidenceReadySnapshot(controller);
    expect(ready.discovery?.currentCandidate).toEqual({
      commitSha: CURRENT_SHA,
      observedAt: '2026-01-02T00:00:00.000Z',
      sourceReference: 'repository:current-b',
      confidence: 'INVALIDATED',
      invalidatedBy: ['test:failed-b'],
    });
    expect(ready.discovery?.knownGoodResolution).toMatchObject({
      status: 'MISSING',
      commitSha: null,
      consideredCommits: 2,
    });
    expect(ready.discovery?.baselineEvidence).toHaveLength(3);
    expect(
      ready.discovery?.baselineEvidence.map(({ sourceReference }) => sourceReference),
    ).toContain('test:failed-a');
  });

  it('blocks valid but unverified and explicitly blocked baseline records', async () => {
    const unverifiedController = createSyntheticDebugDiscoveryController(
      dependencies({
        baseline: {
          ...trustedBaseline,
          provenance: 'release_record',
          sourceReference: 'release:baseline-a',
          ownerVerification: { status: 'UNVERIFIED', evidenceReference: null },
        },
      }),
    );
    const unverified = await unverifiedController.resolveTrustedBaseline(
      await evidenceReadySnapshot(unverifiedController),
    );
    if (!unverified.ok) throw new Error(unverified.error.message);
    expect(unverified.status).toBe('BLOCKED');
    expect(unverified.transition.reasons.map(({ code }) => code)).toContain(
      'BASELINE_NOT_OWNER_VERIFIED',
    );

    const blockerController = createSyntheticDebugDiscoveryController(
      dependencies({
        baseline: {
          ...trustedBaseline,
          knownBlockers: ['Owner verification is under review.'],
        },
      }),
    );
    const explicitlyBlocked = await blockerController.resolveTrustedBaseline(
      await evidenceReadySnapshot(blockerController),
    );
    expect(explicitlyBlocked).toMatchObject({
      ok: true,
      status: 'BLOCKED',
      transition: { reasons: [{ code: 'BASELINE_KNOWN_BLOCKER' }] },
    });
  });

  it('fails closed when repository evidence claims owner-verification authority', async () => {
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({
        repository: {
          currentCandidate: null,
          baselineEvidence: [
            evidence(
              BASELINE_SHA,
              'verified_good',
              'owner_verification',
              '2026-01-01T00:00:00.000Z',
              trustedBaseline.sourceReference,
            ),
          ],
        },
      }),
    );
    const failed = await controller.completeDiscovery(discoverySnapshot(controller));
    expect(failed).toMatchObject({
      ok: true,
      status: 'FAILED',
      snapshot: { machine: { state: 'FAILED', outcome: 'FAILURE' } },
      transition: { reasons: [{ code: 'MALFORMED_DISCOVERY_RESULT' }] },
    });
  });

  it('fails closed on missing pre-ranking authorization and dependency exceptions', async () => {
    const unauthorizedMemoryController = createSyntheticDebugDiscoveryController(
      dependencies({
        memory: { authorizationAppliedBeforeRanking: false, baselineEvidence: [] },
      }),
    );
    const malformed = await unauthorizedMemoryController.completeDiscovery(
      discoverySnapshot(unauthorizedMemoryController),
    );
    expect(malformed).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'MALFORMED_DISCOVERY_RESULT' }] },
    });

    const secret = 'synthetic-secret-that-must-not-leak';
    const throwingController = createSyntheticDebugDiscoveryController(
      dependencies({ repositoryError: new Error(secret) }),
    );
    const failed = await throwingController.completeDiscovery(
      discoverySnapshot(throwingController),
    );
    expect(failed).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'DISCOVERY_DEPENDENCY_ERROR' }] },
    });
    expect(JSON.stringify(failed)).not.toContain(secret);
  });

  it('requires canonical UTC discovery timestamps', async () => {
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({
        repository: {
          currentCandidate: {
            commitSha: CURRENT_SHA,
            observedAt: 'January 3, 2026',
            sourceReference: 'repository:ambiguous-time',
          },
          baselineEvidence: [],
        },
      }),
    );
    const failed = await controller.completeDiscovery(discoverySnapshot(controller));
    expect(failed).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'MALFORMED_DISCOVERY_RESULT' }] },
    });
  });

  it('returns identical results for repeated inputs without mutating dependency records', async () => {
    const repository = {
      currentCandidate: {
        commitSha: CURRENT_SHA,
        observedAt: '2026-01-03T00:00:00.000Z',
        sourceReference: 'repository:current-b',
      },
      baselineEvidence: [
        evidence(
          CURRENT_SHA,
          'verified_good',
          'release_record',
          '2026-01-03T00:00:00.000Z',
          'release:current-b',
        ),
      ],
    };
    const memory = {
      authorizationAppliedBeforeRanking: true,
      baselineEvidence: [
        evidence(
          BASELINE_SHA,
          'verified_good',
          'owner_verification',
          '2026-01-01T00:00:00.000Z',
          trustedBaseline.sourceReference,
        ),
      ],
    };
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({ repository, memory }),
    );
    const snapshot = discoverySnapshot(controller);
    const before = JSON.stringify({ snapshot, repository, memory });

    const first = await controller.completeDiscovery(snapshot);
    const second = await controller.completeDiscovery(snapshot);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify({ snapshot, repository, memory })).toBe(before);
  });

  it('protects terminal states without invoking capabilities or changing snapshots', async () => {
    const calls: string[] = [];
    const controller = createSyntheticDebugDiscoveryController(
      dependencies({ deniedOperation: 'READ_ONLY_DISCOVERY', calls }),
    );
    const blocked = await controller.completeDiscovery(discoverySnapshot(controller));
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.snapshot.machine.state).toBe('BLOCKED');
    const callCount = calls.length;

    const repeated = await controller.completeDiscovery(blocked.snapshot);
    expect(repeated).toMatchObject({
      ok: false,
      snapshot: blocked.snapshot,
      error: { code: 'TERMINAL_STATE', state: 'BLOCKED' },
    });
    if (repeated.ok) throw new Error('Expected terminal-state rejection');
    expect(repeated.snapshot).toBe(blocked.snapshot);
    expect(calls).toHaveLength(callCount);
  });

  it('fails closed on cross-project discovery and baseline records', async () => {
    const crossProjectEvidence = evidence(
      BASELINE_SHA,
      'verified_good',
      'owner_verification',
      '2026-01-01T00:00:00.000Z',
      trustedBaseline.sourceReference,
    );
    const discoveryController = createSyntheticDebugDiscoveryController(
      dependencies({
        memory: {
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            {
              ...crossProjectEvidence,
              evidence: { ...crossProjectEvidence.evidence, project: 'different-project' },
            },
          ],
        },
      }),
    );
    const discoveryFailure = await discoveryController.completeDiscovery(
      discoverySnapshot(discoveryController),
    );
    expect(discoveryFailure).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'CROSS_PROJECT_DISCOVERY_EVIDENCE' }] },
    });

    const baselineController = createSyntheticDebugDiscoveryController(
      dependencies({ baseline: { ...trustedBaseline, caseId: 'different-case' } }),
    );
    const baselineFailure = await baselineController.resolveTrustedBaseline(
      await evidenceReadySnapshot(baselineController),
    );
    expect(baselineFailure).toMatchObject({
      ok: true,
      status: 'FAILED',
      transition: { reasons: [{ code: 'TRUSTED_BASELINE_SCOPE_MISMATCH' }] },
    });
  });
});
