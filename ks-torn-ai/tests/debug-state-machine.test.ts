import { describe, expect, it } from 'vitest';

import {
  ALLOWED_SYNTHETIC_DEBUG_TRANSITIONS,
  SYNTHETIC_DEBUG_EVENTS,
  SYNTHETIC_DEBUG_TERMINAL_OUTCOMES,
  allowedSyntheticDebugEvents,
  createSyntheticDebugMachine,
  transitionSyntheticDebugMachine,
  type SyntheticDebugEvent,
  type SyntheticDebugMachineSnapshot,
  type SyntheticDebugState,
  type SyntheticDebugTransitionReason,
  type SyntheticDebugTransitionRequest,
} from '../src/debug/state-machine.js';

const SUCCESS_PATH = [
  ['START_DISCOVERY', 'DISCOVERY'],
  ['MARK_EVIDENCE_READY', 'EVIDENCE_READY'],
  ['MARK_BASELINE_READY', 'BASELINE_READY'],
  ['MARK_ROOT_CAUSE_READY', 'ROOT_CAUSE_READY'],
  ['MARK_IMPLEMENTATION_READY', 'IMPLEMENTATION_READY'],
  ['REQUEST_WRITE_APPROVAL', 'AWAITING_WRITE_APPROVAL'],
  ['GRANT_WRITE_APPROVAL', 'IMPLEMENTING'],
  ['START_VERIFICATION', 'VERIFYING'],
  ['START_REVIEW', 'REVIEWING'],
  ['COMPLETE_REVIEW', 'REVIEWING'],
  ['MARK_TEST_READY', 'TEST_READY'],
] as const satisfies readonly (readonly [SyntheticDebugEvent, SyntheticDebugState])[];

function reason(code = 'SYNTHETIC_TEST', summary = 'Synthetic transition evidence.') {
  return { code, summary } satisfies SyntheticDebugTransitionReason;
}

function request(
  event: SyntheticDebugEvent,
  reasons: SyntheticDebugTransitionRequest['reasons'] = [reason()],
): SyntheticDebugTransitionRequest {
  return { event, reasons };
}

function accept(
  snapshot: SyntheticDebugMachineSnapshot,
  event: SyntheticDebugEvent,
  reasons: SyntheticDebugTransitionRequest['reasons'] = [reason()],
): SyntheticDebugMachineSnapshot {
  const result = transitionSyntheticDebugMachine(snapshot, request(event, reasons));
  if (!result.ok) {
    throw new Error(`Expected ${event} to be accepted: ${result.error.code}`);
  }
  return result.snapshot;
}

function successSnapshot(): SyntheticDebugMachineSnapshot {
  return SUCCESS_PATH.reduce(
    (snapshot, [event]) => accept(snapshot, event),
    createSyntheticDebugMachine(),
  );
}

describe('Synthetic Debug MVP state machine', () => {
  it('declares the complete allowed transition model explicitly', () => {
    expect(ALLOWED_SYNTHETIC_DEBUG_TRANSITIONS).toEqual({
      INTAKE: { START_DISCOVERY: 'DISCOVERY', BLOCK: 'BLOCKED', FAIL: 'FAILED' },
      DISCOVERY: { MARK_EVIDENCE_READY: 'EVIDENCE_READY', BLOCK: 'BLOCKED', FAIL: 'FAILED' },
      EVIDENCE_READY: { MARK_BASELINE_READY: 'BASELINE_READY', BLOCK: 'BLOCKED', FAIL: 'FAILED' },
      BASELINE_READY: {
        MARK_ROOT_CAUSE_READY: 'ROOT_CAUSE_READY',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
      },
      ROOT_CAUSE_READY: {
        MARK_IMPLEMENTATION_READY: 'IMPLEMENTATION_READY',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
      },
      IMPLEMENTATION_READY: {
        REQUEST_WRITE_APPROVAL: 'AWAITING_WRITE_APPROVAL',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
      },
      AWAITING_WRITE_APPROVAL: {
        GRANT_WRITE_APPROVAL: 'IMPLEMENTING',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
        CANCEL: 'CANCELLED',
      },
      IMPLEMENTING: {
        START_VERIFICATION: 'VERIFYING',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
      },
      VERIFYING: { START_REVIEW: 'REVIEWING', BLOCK: 'BLOCKED', FAIL: 'FAILED' },
      REVIEWING: {
        COMPLETE_REVIEW: 'REVIEWING',
        MARK_TEST_READY: 'TEST_READY',
        BLOCK: 'BLOCKED',
        FAIL: 'FAILED',
      },
      TEST_READY: {},
      BLOCKED: {},
      FAILED: {},
      CANCELLED: {},
    });
    expect(SYNTHETIC_DEBUG_TERMINAL_OUTCOMES).toEqual({
      TEST_READY: 'SUCCESS',
      BLOCKED: 'FAILURE',
      FAILED: 'FAILURE',
      CANCELLED: 'FAILURE',
    });
  });

  it('follows the complete valid path to terminal success without skipped states', () => {
    let snapshot = createSyntheticDebugMachine();

    for (const [event, expectedState] of SUCCESS_PATH) {
      const result = transitionSyntheticDebugMachine(
        snapshot,
        request(event, [reason(`VALID_${event}`, `Advance to ${expectedState}.`)]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.transition).toMatchObject({
        sequence: snapshot.history.length + 1,
        event,
        from: snapshot.state,
        to: expectedState,
      });
      snapshot = result.snapshot;
    }

    expect(snapshot.state).toBe('TEST_READY');
    expect(snapshot.outcome).toBe('SUCCESS');
    expect(snapshot.history).toHaveLength(SUCCESS_PATH.length);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('rejects skipped, backward and state-inappropriate transitions without changing state', () => {
    const intake = createSyntheticDebugMachine();
    const skipped = transitionSyntheticDebugMachine(intake, request('MARK_BASELINE_READY'));

    expect(skipped).toEqual({
      ok: false,
      snapshot: intake,
      error: {
        code: 'INVALID_TRANSITION',
        message: 'Event MARK_BASELINE_READY is not allowed from state INTAKE',
        state: 'INTAKE',
        attemptedEvent: 'MARK_BASELINE_READY',
        allowedEvents: ['START_DISCOVERY', 'BLOCK', 'FAIL'],
      },
    });
    expect(skipped.snapshot).toBe(intake);
    expect(intake).toEqual(createSyntheticDebugMachine());

    const discovery = accept(intake, 'START_DISCOVERY');
    const backward = transitionSyntheticDebugMachine(discovery, request('START_DISCOVERY'));
    expect(backward.ok).toBe(false);
    if (backward.ok) throw new Error('Expected backward transition rejection');
    expect(backward.error.code).toBe('INVALID_TRANSITION');
    expect(backward.snapshot).toBe(discovery);
    expect(discovery.state).toBe('DISCOVERY');
    expect(discovery.history).toHaveLength(1);
  });

  it('rejects every transition from success and failure terminal states', () => {
    const awaitingApproval = SUCCESS_PATH.slice(0, 6).reduce(
      (snapshot, [event]) => accept(snapshot, event),
      createSyntheticDebugMachine(),
    );
    const terminalSnapshots = [
      successSnapshot(),
      accept(createSyntheticDebugMachine(), 'BLOCK'),
      accept(createSyntheticDebugMachine(), 'FAIL'),
      accept(awaitingApproval, 'CANCEL'),
    ];

    for (const terminal of terminalSnapshots) {
      for (const event of SYNTHETIC_DEBUG_EVENTS) {
        const result = transitionSyntheticDebugMachine(terminal, request(event));
        expect(result).toEqual({
          ok: false,
          snapshot: terminal,
          error: {
            code: 'TERMINAL_STATE',
            message: `State ${terminal.state} is terminal and cannot transition`,
            state: terminal.state,
            attemptedEvent: event,
            allowedEvents: [],
          },
        });
        expect(result.snapshot).toBe(terminal);
      }
      expect(allowedSyntheticDebugEvents(terminal.state)).toEqual([]);
    }
  });

  it('returns deeply equal results for repeated identical inputs without mutating them', () => {
    const snapshot = accept(createSyntheticDebugMachine(), 'START_DISCOVERY');
    const transitionRequest = request('MARK_EVIDENCE_READY', [
      reason('EVIDENCE_RECORDED', 'Synthetic evidence was recorded.'),
    ]);
    const snapshotBefore = JSON.stringify(snapshot);
    const requestBefore = JSON.stringify(transitionRequest);

    const first = transitionSyntheticDebugMachine(snapshot, transitionRequest);
    const second = transitionSyntheticDebugMachine(snapshot, transitionRequest);

    expect(first).toEqual(second);
    expect(JSON.stringify(snapshot)).toBe(snapshotBefore);
    expect(JSON.stringify(transitionRequest)).toBe(requestBefore);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('handles explicit blocked, failed and cancelled outcomes with preserved reasons', () => {
    const verifying = SUCCESS_PATH.slice(0, 8).reduce(
      (snapshot, [event]) => accept(snapshot, event),
      createSyntheticDebugMachine(),
    );
    const blockingReasons = [
      reason('REQUIRED_TEST_FAILED', 'The synthetic required profile failed.'),
      reason('CANDIDATE_NOT_DELIVERABLE', 'Delivery remains blocked.'),
    ] as const;
    const blocked = transitionSyntheticDebugMachine(verifying, request('BLOCK', blockingReasons));
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.snapshot.state).toBe('BLOCKED');
    expect(blocked.snapshot.outcome).toBe('FAILURE');
    expect(blocked.transition.reasons).toEqual(blockingReasons);

    const failed = transitionSyntheticDebugMachine(
      createSyntheticDebugMachine(),
      request('FAIL', [reason('ORCHESTRATION_ERROR', 'Synthetic orchestration failed.')]),
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error(failed.error.message);
    expect(failed.snapshot.state).toBe('FAILED');
    expect(failed.snapshot.outcome).toBe('FAILURE');
    expect(failed.transition.reasons).toEqual([
      reason('ORCHESTRATION_ERROR', 'Synthetic orchestration failed.'),
    ]);

    const cancellationFromIntake = transitionSyntheticDebugMachine(
      createSyntheticDebugMachine(),
      request('CANCEL'),
    );
    expect(cancellationFromIntake.ok).toBe(false);
    if (cancellationFromIntake.ok) throw new Error('Expected invalid cancellation rejection');
    expect(cancellationFromIntake.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects missing or blank transition reasons with a machine-readable error', () => {
    const snapshot = createSyntheticDebugMachine();
    const invalidRequest = {
      event: 'START_DISCOVERY',
      reasons: [{ code: ' ', summary: '' }],
    } as SyntheticDebugTransitionRequest;
    const result = transitionSyntheticDebugMachine(snapshot, invalidRequest);

    expect(result).toEqual({
      ok: false,
      snapshot,
      error: {
        code: 'INVALID_REASON',
        message: 'A transition requires at least one non-empty structured reason',
        state: 'INTAKE',
        attemptedEvent: 'START_DISCOVERY',
        allowedEvents: ['START_DISCOVERY', 'BLOCK', 'FAIL'],
      },
    });
    expect(result.snapshot).toBe(snapshot);
  });
});
