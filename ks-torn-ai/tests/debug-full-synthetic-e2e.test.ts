/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { readdir } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTrustedMemoryAccessContext } from '../src/memory/access.js';
import { SyntheticDebugMemorySink } from '../src/debug/memory-integration.js';
import {
  E2E_API_SECRET,
  E2E_PATH,
  E2E_PROFILE,
  E2E_SECRET,
  SyntheticDebugE2EHarness,
  intake,
  passingReview,
  plan,
  rootCause,
} from './synthetic-debug-e2e-harness.js';

const harnesses: SyntheticDebugE2EHarness[] = [];
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
const make = async (options: Parameters<typeof SyntheticDebugE2EHarness.create>[0] = {}) => {
  const harness = await SyntheticDebugE2EHarness.create(options);
  harnesses.push(harness);
  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

function allSafeSurfaces(harness: SyntheticDebugE2EHarness, final: unknown, records: unknown) {
  return JSON.stringify({
    final,
    records,
    workerRequests: harness.workerRequests,
  });
}

describe('C3.11 full synthetic end-to-end acceptance', () => {
  it('drives C3.1-C3.10 and the real Stage B Worker to one durable TEST_READY result', async () => {
    const harness = await make();
    const sourceBefore = await harness.sourceState();
    const final = await harness.driveToFinal();

    expect(final).toMatchObject({
      ok: true,
      status: 'ADVANCED',
      snapshot: {
        machine: { state: 'TEST_READY', outcome: 'SUCCESS' },
        knownGoodBaseline: { commitSha: harness.baseline },
        implementationGate: { allowed: true, blockers: [] },
        writeApprovalDecision: { decision: 'APPROVED' },
        workerExecution: {
          status: 'SUCCEEDED',
          baselineSha: harness.baseline,
          rollbackSha: harness.baseline,
          changedPaths: [E2E_PATH],
        },
        verificationDecision: { status: 'PASSED', requiredProfileIds: [E2E_PROFILE] },
        independentReview: { disposition: 'pass' },
        finalDelivery: { status: 'TEST_READY', gate: { allowed: true, blockers: [] } },
      },
    });
    if (!final.ok || final.snapshot.finalDelivery === null)
      throw new Error('expected final report');
    const snapshot = final.snapshot;
    if (snapshot.finalDelivery === null) throw new Error('expected final report');
    const report = snapshot.finalDelivery;
    expect(report.workflowKind).toBe('synthetic');
    expect(report.caseId).toBe(harness.caseId);
    expect(report.projectId).toBe('synthetic');
    expect(report.baselineSha).toBe(harness.baseline);
    expect(report.rollbackSha).toBe(harness.baseline);
    expect(report.rollbackRef).toBe(harness.baseline);
    expect(report.candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.candidateSha).not.toBe(harness.baseline);
    expect(report.problemEvidence).toHaveLength(1);
    expect(report.rootCause).toContain('bounded fixture');
    expect(report.approvedPaths).toEqual([E2E_PATH]);
    expect(report.changedPaths).toEqual([E2E_PATH]);
    expect(report.verification).toMatchObject([{ profileId: E2E_PROFILE, status: 'passed' }]);
    expect(report.review.status).toBe('passed');
    expect(report.unresolvedBlockingUncertainty).toEqual([]);
    expect(Object.isFrozen(report)).toBe(true);

    const firstPersistence = await harness.persist(snapshot);
    const replayPersistence = await harness.persist(snapshot);
    expect(firstPersistence.records).toHaveLength(3);
    expect(replayPersistence.records.every(({ status }) => status === 'duplicate')).toBe(true);
    expect(await harness.store.readAuditEvents()).toHaveLength(3);
    const authorized = await harness.memory.retrieve(
      createTrustedMemoryAccessContext({
        actorId: 'authorized-reader',
        role: 'OWNER_DEVELOPER',
        capabilities: ['MEMORY_READ'],
        projectGrants: ['synthetic'],
        allowedZones: ['PRIVATE_KINGSHADE_DEV'],
        tenantGrants: [],
      }),
      { query: 'Synthetic C3', limit: 8 },
    );
    const unauthorized = await harness.memory.retrieve(
      createTrustedMemoryAccessContext({
        actorId: 'unauthorized-reader',
        role: 'OWNER_DEVELOPER',
        capabilities: ['MEMORY_READ'],
        projectGrants: ['other'],
        allowedZones: ['PRIVATE_KINGSHADE_DEV'],
        tenantGrants: [],
      }),
      { query: 'Synthetic C3', limit: 8 },
    );
    expect(authorized.records).toHaveLength(3);
    expect(
      authorized.records.every(
        (record) =>
          record.evidenceClassification === 'AUTOMATED_TEST' &&
          record.verificationState === 'SUPPORTING',
      ),
    ).toBe(true);
    expect(unauthorized.records).toEqual([]);
    expect(await harness.sourceState()).toEqual(sourceBefore);
    expect(harness.workerCalls).toBe(1);
    expect(harness.reviewCalls).toBe(1);
    expect(harness.memoryCalls).toBe(2);

    const terminalReplay = await harness.controller.evaluateFinalDelivery(snapshot);
    expect(terminalReplay).toEqual(final);
    expect(harness.controller.startDiscovery(snapshot)).toMatchObject({
      ok: false,
      error: { code: 'TERMINAL_STATE' },
    });
    expect(harness.workerCalls).toBe(1);
    const safe = allSafeSurfaces(harness, final, authorized.records);
    expect(safe).not.toContain(E2E_SECRET);
    expect(safe).not.toContain(E2E_API_SECRET);
    expect(safe).not.toMatch(/approvalToken|approvalGrant|credential/i);
  });

  it.each([
    [
      'missing owner baseline',
      {
        memoryEvidence: () => ({ authorizationAppliedBeforeRanking: true, baselineEvidence: [] }),
        baselineInput: () => null,
      },
    ],
    [
      'automated evidence only',
      {
        memoryEvidence: (baseline: string) => ({
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [
            {
              sourceReference: 'ci:test',
              evidence: {
                project: 'synthetic',
                commitSha: baseline,
                state: 'verified_good',
                source: 'regression_suite',
                observedAt: '2026-08-25T09:00:00.000Z',
              },
            },
          ],
        }),
        baselineInput: () => null,
      },
    ],
    [
      'contradictory baseline evidence',
      {
        memoryEvidence: (baseline: string) => ({
          authorizationAppliedBeforeRanking: true,
          baselineEvidence: [ownerEvidence(baseline, 'one'), ownerEvidence('b'.repeat(40), 'two')],
        }),
      },
    ],
    [
      'invalid non-full baseline',
      {
        baselineInput: (_baseline: string, caseId: string) => ({
          ...trustedBaseline('a'.repeat(40), caseId),
          commitSha: 'short',
        }),
      },
    ],
  ] as const)('blocks %s before Worker mutation', async (_label, options) => {
    const harness = await make({
      caseId: `c3-11-${_label.replaceAll(' ', '-')}`,
      ...options,
    });
    const sourceBefore = await harness.sourceState();
    const result = await harness.driveToPending();
    expect(result.ok ? result.status : 'REJECTED').not.toBe('ADVANCED');
    expect(result.snapshot.machine.state).toMatch(/BLOCKED|FAILED/);
    expect(harness.workerCalls).toBe(0);
    expect(await harness.sourceState()).toEqual(sourceBefore);
  });

  it.each([
    [
      'no reproducible evidence',
      { intake: { ...intake('c3-11-no-evidence'), evidenceReferences: [] } },
    ],
    [
      'root cause missing',
      { rootCause: { ...rootCause('c3-11-root-cause-missing'), explanation: '' } },
    ],
    [
      'blocking uncertainty',
      {
        rootCause: {
          ...rootCause('c3-11-blocking-uncertainty'),
          unresolvedUncertainty: ['The bounded cause is uncertain.'],
        },
      },
    ],
  ] as [string, NonNullable<Parameters<typeof make>[0]>][])(
    'blocks %s before Worker',
    async (_label, options) => {
      const caseId = `c3-11-${_label.replaceAll(' ', '-')}`;
      const normalized =
        options.intake === undefined
          ? options.rootCause === undefined
            ? options
            : { ...options, rootCause: { ...options.rootCause, caseId } }
          : { ...options, intake: { ...options.intake, caseId } };
      const harness = await make({ caseId, ...normalized });
      const result = await harness.driveToPending();
      expect(result.ok ? result.status : 'REJECTED').not.toBe('ADVANCED');
      expect(harness.workerCalls).toBe(0);
    },
  );

  it('blocks a stale repository candidate before the Worker can mutate', async () => {
    const harness = await make({
      caseId: 'c3-11-stale-baseline',
      repositoryCandidate: () => 'b'.repeat(40),
      memoryEvidence: () => ({
        authorizationAppliedBeforeRanking: true,
        baselineEvidence: [ownerEvidence('b'.repeat(40), 'stale')],
      }),
      baselineInput: (_baseline, caseId) => trustedBaseline('b'.repeat(40), caseId),
    });
    const before = await harness.sourceState();
    const result = await harness.driveToExecuted();
    expect(result.snapshot.machine.state).not.toBe('VERIFYING');
    expect(harness.workerCalls).toBe(0);
    expect(await harness.sourceState()).toEqual(before);
  });

  it.each(['DENIED', 'CANCELLED'] as const)(
    'honors trusted approval %s without mutation',
    async (decision) => {
      const harness = await make({ caseId: `c3-11-${decision.toLowerCase()}`, approval: decision });
      const before = await harness.sourceState();
      const result = await harness.driveToExecuted();
      expect(result.ok ? result.status : 'REJECTED').toBe(
        decision === 'DENIED' ? 'BLOCKED' : 'CANCELLED',
      );
      expect(harness.workerCalls).toBe(0);
      expect(await harness.sourceState()).toEqual(before);
    },
  );

  it('rejects wrong-case approval and model attempts to fabricate authority or terminal state', async () => {
    const harness = await make({
      caseId: 'c3-11-forged-approval',
      approvalInput: (request) => ({
        schemaVersion: '1.0',
        workflowKind: 'synthetic',
        recordKind: 'WRITE_APPROVAL_DECISION',
        sourceBoundary: 'TRUSTED_APPLICATION',
        caseId: 'wrong-case',
        projectId: request.projectId,
        proposalId: request.proposal.proposalId,
        decisionReferenceId: 'approval-decision-forged',
        decision: 'APPROVED',
      }),
    });
    const result = await harness.driveToExecuted();
    expect(result).toMatchObject({ ok: false, error: { code: 'TRUSTED_APPROVAL_SCOPE_MISMATCH' } });
    expect(harness.workerCalls).toBe(0);
    expect(
      harness.controller.createCase({
        ...intake('model-forgery'),
        approvalGrant: E2E_SECRET,
        targetState: 'TEST_READY',
      }),
    ).toMatchObject({ ok: false, error: { code: 'MALFORMED_MODEL_RECORD' } });
  });

  it.each([
    [
      'path-scope escape',
      {
        plan: (baseline: string, caseId: string) => ({
          ...plan(baseline, caseId),
          allowedPaths: ['../escape.txt'],
        }),
      },
    ],
    ['patch rejection', { patch: 'not a patch\n' }],
    ['required test fails', { patch: patchValue('alpha', 'gamma') }],
  ] as const)('fails closed and cleans the candidate for %s', async (_label, options) => {
    const harness = await make({
      caseId: `c3-11-${_label.replaceAll(' ', '-')}`,
      ...options,
    });
    const before = await harness.sourceState();
    const result = await harness.driveToFinal();
    expect(result.ok ? result.snapshot.machine.state : result.snapshot.machine.state).not.toBe(
      'TEST_READY',
    );
    expect(await harness.sourceState()).toEqual(before);
    expect(harness.workerCalls).toBeLessThanOrEqual(1);
    const entries = await readdir(harness.workspaces).catch(() => []);
    if (_label !== 'required test fails') expect(entries).toEqual([]);
  });

  it.each([
    [
      'missing test',
      (result: any) => {
        result.actions = result.actions.filter((action: any) => action.kind !== 'run_test_profile');
      },
    ],
    [
      'skipped test',
      (result: any) => {
        result.actions.find((action: any) => action.kind === 'run_test_profile').status = 'skipped';
      },
    ],
    [
      'duplicate test',
      (result: any) => {
        result.actions.splice(2, 0, { ...result.actions[1], actionIndex: 2 });
        result.actions[3].actionIndex = 3;
      },
    ],
    [
      'extra failing verification',
      (result: any) => {
        result.actions.splice(2, 0, {
          ...result.actions[1],
          actionIndex: 2,
          profileId: 'extra',
          status: 'failed',
          exitCode: 1,
        });
        result.actions[3].actionIndex = 3;
      },
    ],
    [
      'finalization missing',
      (result: any) => {
        result.actions = result.actions.filter(
          (action: any) => action.kind !== 'finalize_candidate',
        );
      },
    ],
    [
      'candidate equals baseline',
      (result: any) => {
        result.headShaAfter = result.headShaBefore;
      },
    ],
    [
      'rollback mismatch',
      (result: any) => {
        result.baselineRef = 'b'.repeat(40);
      },
    ],
  ] as const)('verification prevents TEST_READY for %s', async (_label, mutate) => {
    let captured: unknown;
    const harness = await make({
      caseId: `c3-11-${_label.replaceAll(' ', '-')}`,
      workerInput: async (request) => {
        const actual = await (harness as any).executeWorker(request, patchValue('alpha', 'beta'));
        captured = structuredClone(actual);
        mutate(captured as any);
        return captured;
      },
    });
    const result = await harness.driveToFinal();
    expect(result.snapshot.machine.state).not.toBe('TEST_READY');
    expect(harness.workerCalls).toBe(1);
  });

  it.each([
    [
      'review fails',
      (request: any) => ({
        ...passingReview(request),
        disposition: 'fail',
        summary: 'Independent review failed.',
        blockers: ['review blocker'],
      }),
    ],
    ['review missing', () => undefined],
    [
      'review mismatch',
      (request: any) => ({ ...passingReview(request), candidateSha: 'b'.repeat(40) }),
    ],
    [
      'review fabricates state',
      (request: any) => ({
        ...passingReview(request),
        targetState: 'TEST_READY',
        approvalGrant: E2E_SECRET,
      }),
    ],
  ] as const)('independent review prevents TEST_READY when %s', async (_label, reviewInput) => {
    const harness = await make({
      caseId: `c3-11-${_label.replaceAll(' ', '-')}`,
      reviewInput,
    });
    const result = await harness.driveToFinal();
    expect(result.snapshot.machine.state).toBe('BLOCKED');
    expect(result.snapshot.finalDelivery).toBeNull();
    expect(harness.workerCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(E2E_SECRET);
  });

  it('persists failed history, rejects unauthorized writes, and never promotes latest evidence', async () => {
    const harness = await make();
    const final = await harness.driveToFinal();
    if (!final.ok) throw new Error('expected success');
    await harness.persist(final.snapshot);
    await harness.sink.persist({
      schemaVersion: '1.0',
      workflowKind: 'synthetic',
      caseId: 'c3-11-failed-history',
      projectId: 'synthetic',
      finalDisposition: 'BLOCKED',
      baselineMode: 'KNOWN_GOOD',
      baselineSha: harness.baseline,
      referenceVersion: null,
      referenceWasOwnerVerifiedKnownGood: true,
      ownerAcknowledgement: {
        status: 'OWNER_VERIFIED_KNOWN_GOOD',
        evidenceReference: `owner:${harness.caseId}:baseline`,
      },
      historicalSearchBoundary: null,
      defectEvidenceProvenance: [],
      knownPreExistingDefects: [],
      knownUnrelatedFailures: [],
      referenceSelectionReason: null,
      rollbackReferenceSemantics: null,
      writeApprovalProvenance: null,
      candidateSha: null,
      verificationDecisionId: 'verification-failed-history',
      verificationStatus: 'FAILED',
      verificationProfiles: [{ profileId: E2E_PROFILE, status: 'failed' }],
      reviewId: null,
      reviewDisposition: 'not_run',
      failureCodes: ['TEST_PROFILE_FAILED'],
    });
    const records = await harness.store.listRecords();
    expect(records.filter(({ kind }) => kind === 'PROJECT_DECISION')).toHaveLength(2);
    expect(records.filter(({ kind }) => kind === 'FAILED_CANDIDATE')).toHaveLength(1);
    expect(records.every(({ lifecycle }) => lifecycle.status === 'ACTIVE')).toBe(true);
    const unauthorizedSink = new SyntheticDebugMemorySink(
      harness.memory,
      createTrustedMemoryAccessContext({
        actorId: 'denied',
        role: 'OWNER_DEVELOPER',
        capabilities: ['MEMORY_INGEST'],
        projectGrants: ['other'],
        allowedZones: ['PRIVATE_KINGSHADE_DEV'],
        tenantGrants: [],
      }),
      'synthetic',
    );
    await expect(unauthorizedSink.persist({ bad: true })).rejects.toThrow();
  });

  it('does not patch-stack or re-execute Worker during verification, review, delivery, memory, or replay', async () => {
    const harness = await make();
    const executed = await harness.driveToExecuted();
    if (!executed.ok || executed.status !== 'ADVANCED') throw new Error('expected execution');
    const execution = executed.snapshot.workerExecution;
    const verification = await harness.controller.evaluateVerification(executed.snapshot);
    if (!verification.ok || verification.status !== 'ADVANCED')
      throw new Error('expected verification');
    const review = await harness.controller.evaluateIndependentReview(verification.snapshot);
    if (!review.ok || review.status !== 'ADVANCED') throw new Error('expected review');
    const delivery = await harness.controller.evaluateFinalDelivery(review.snapshot);
    if (!delivery.ok) throw new Error('expected delivery');
    await harness.persist(delivery.snapshot);
    expect(harness.workerCalls).toBe(1);
    expect(delivery.snapshot.workerExecution).toEqual(execution);
    expect(
      delivery.snapshot.workerExecution?.actions.filter(({ kind }) => kind === 'apply_patch'),
    ).toHaveLength(1);
    expect(await harness.controller.executeApprovedImplementation(executed.snapshot)).toMatchObject(
      { ok: false, error: { code: 'OUT_OF_ORDER' } },
    );
    expect(harness.workerCalls).toBe(1);
  });

  it('redacts secret-shaped dependency errors without echo across public surfaces', async () => {
    const harness = await make({
      caseId: 'c3-11-secret-error',
      reviewInput: () => {
        throw new Error(`${E2E_API_SECRET}:${E2E_SECRET}`);
      },
    });
    const result = await harness.driveToFinal();
    const serialized = JSON.stringify(result);
    expect(result.snapshot.machine.state).toBe('FAILED');
    expect(serialized).not.toContain(E2E_SECRET);
    expect(serialized).not.toContain(E2E_API_SECRET);
  });
});

function patchValue(from: string, to: string): string {
  return [
    'diff --git a/fixture.txt b/fixture.txt',
    '--- a/fixture.txt',
    '+++ b/fixture.txt',
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
    '',
  ].join('\n');
}

function trustedBaseline(baseline: string, caseId: string) {
  const reference = `owner:${caseId}:baseline`;
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'BASELINE',
    caseId,
    projectId: 'synthetic',
    sourceBoundary: 'TRUSTED_APPLICATION',
    commitSha: baseline,
    provenance: 'owner_verification',
    sourceReference: reference,
    ownerVerification: { status: 'OWNER_VERIFIED', evidenceReference: reference },
    knownBlockers: [],
  };
}

function ownerEvidence(baseline: string, suffix: string) {
  return {
    sourceReference: `owner:${suffix}:baseline`,
    evidence: {
      project: 'synthetic',
      commitSha: baseline,
      state: 'verified_good',
      source: 'owner_verification',
      observedAt: '2026-08-25T09:00:00.000Z',
    },
  };
}
