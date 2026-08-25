export const SYNTHETIC_DEBUG_STATES = [
  'INTAKE',
  'DISCOVERY',
  'EVIDENCE_READY',
  'BASELINE_READY',
  'ROOT_CAUSE_READY',
  'IMPLEMENTATION_READY',
  'AWAITING_WRITE_APPROVAL',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'TEST_READY',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;

export type SyntheticDebugState = (typeof SYNTHETIC_DEBUG_STATES)[number];

export const SYNTHETIC_DEBUG_EVENTS = [
  'START_DISCOVERY',
  'MARK_EVIDENCE_READY',
  'MARK_BASELINE_READY',
  'MARK_ROOT_CAUSE_READY',
  'MARK_IMPLEMENTATION_READY',
  'REQUEST_WRITE_APPROVAL',
  'GRANT_WRITE_APPROVAL',
  'START_VERIFICATION',
  'START_REVIEW',
  'COMPLETE_REVIEW',
  'MARK_TEST_READY',
  'BLOCK',
  'FAIL',
  'CANCEL',
] as const;

export type SyntheticDebugEvent = (typeof SYNTHETIC_DEBUG_EVENTS)[number];
export type SyntheticDebugOutcome = 'SUCCESS' | 'FAILURE';

type StateTransitionMap = Readonly<
  Record<SyntheticDebugState, Readonly<Partial<Record<SyntheticDebugEvent, SyntheticDebugState>>>>
>;

export const ALLOWED_SYNTHETIC_DEBUG_TRANSITIONS: StateTransitionMap = Object.freeze({
  INTAKE: Object.freeze({
    START_DISCOVERY: 'DISCOVERY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  DISCOVERY: Object.freeze({
    MARK_EVIDENCE_READY: 'EVIDENCE_READY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  EVIDENCE_READY: Object.freeze({
    MARK_BASELINE_READY: 'BASELINE_READY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  BASELINE_READY: Object.freeze({
    MARK_ROOT_CAUSE_READY: 'ROOT_CAUSE_READY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  ROOT_CAUSE_READY: Object.freeze({
    MARK_IMPLEMENTATION_READY: 'IMPLEMENTATION_READY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  IMPLEMENTATION_READY: Object.freeze({
    REQUEST_WRITE_APPROVAL: 'AWAITING_WRITE_APPROVAL',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  AWAITING_WRITE_APPROVAL: Object.freeze({
    GRANT_WRITE_APPROVAL: 'IMPLEMENTING',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
    CANCEL: 'CANCELLED',
  }),
  IMPLEMENTING: Object.freeze({
    START_VERIFICATION: 'VERIFYING',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  VERIFYING: Object.freeze({
    START_REVIEW: 'REVIEWING',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  REVIEWING: Object.freeze({
    COMPLETE_REVIEW: 'REVIEWING',
    MARK_TEST_READY: 'TEST_READY',
    BLOCK: 'BLOCKED',
    FAIL: 'FAILED',
  }),
  TEST_READY: Object.freeze({}),
  BLOCKED: Object.freeze({}),
  FAILED: Object.freeze({}),
  CANCELLED: Object.freeze({}),
});

export const SYNTHETIC_DEBUG_TERMINAL_OUTCOMES = Object.freeze({
  TEST_READY: 'SUCCESS',
  BLOCKED: 'FAILURE',
  FAILED: 'FAILURE',
  CANCELLED: 'FAILURE',
} as const satisfies Partial<Record<SyntheticDebugState, SyntheticDebugOutcome>>);

export type SyntheticDebugTerminalState = keyof typeof SYNTHETIC_DEBUG_TERMINAL_OUTCOMES;

export interface SyntheticDebugTransitionReason {
  readonly code: string;
  readonly summary: string;
}

export interface SyntheticDebugTransitionRequest {
  readonly event: SyntheticDebugEvent;
  readonly reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]];
}

export interface SyntheticDebugTransitionRecord {
  readonly sequence: number;
  readonly event: SyntheticDebugEvent;
  readonly from: SyntheticDebugState;
  readonly to: SyntheticDebugState;
  readonly reasons: readonly SyntheticDebugTransitionReason[];
}

export interface SyntheticDebugMachineSnapshot {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly state: SyntheticDebugState;
  readonly outcome: SyntheticDebugOutcome | null;
  readonly history: readonly SyntheticDebugTransitionRecord[];
}

export type SyntheticDebugTransitionErrorCode =
  | 'INVALID_REASON'
  | 'INVALID_TRANSITION'
  | 'TERMINAL_STATE';

export interface SyntheticDebugTransitionError {
  readonly code: SyntheticDebugTransitionErrorCode;
  readonly message: string;
  readonly state: SyntheticDebugState;
  readonly attemptedEvent: SyntheticDebugEvent;
  readonly allowedEvents: readonly SyntheticDebugEvent[];
}

export interface SyntheticDebugTransitionAccepted {
  readonly ok: true;
  readonly snapshot: SyntheticDebugMachineSnapshot;
  readonly transition: SyntheticDebugTransitionRecord;
}

export interface SyntheticDebugTransitionRejected {
  readonly ok: false;
  readonly snapshot: SyntheticDebugMachineSnapshot;
  readonly error: SyntheticDebugTransitionError;
}

export type SyntheticDebugTransitionResult =
  | SyntheticDebugTransitionAccepted
  | SyntheticDebugTransitionRejected;

const EMPTY_HISTORY = Object.freeze([]) as readonly SyntheticDebugTransitionRecord[];

function terminalOutcome(state: SyntheticDebugState): SyntheticDebugOutcome | null {
  const outcomes: Readonly<Partial<Record<SyntheticDebugState, SyntheticDebugOutcome>>> =
    SYNTHETIC_DEBUG_TERMINAL_OUTCOMES;
  return outcomes[state] ?? null;
}

export function isSyntheticDebugTerminalState(
  state: SyntheticDebugState,
): state is SyntheticDebugTerminalState {
  return terminalOutcome(state) !== null;
}

export function allowedSyntheticDebugEvents(
  state: SyntheticDebugState,
): readonly SyntheticDebugEvent[] {
  return Object.freeze(
    Object.keys(ALLOWED_SYNTHETIC_DEBUG_TRANSITIONS[state]),
  ) as readonly SyntheticDebugEvent[];
}

export function createSyntheticDebugMachine(): SyntheticDebugMachineSnapshot {
  return Object.freeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    state: 'INTAKE',
    outcome: null,
    history: EMPTY_HISTORY,
  });
}

function validReasons(
  reasons: readonly SyntheticDebugTransitionReason[],
): reasons is readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]] {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => reason.code.trim().length > 0 && reason.summary.trim().length > 0)
  );
}

function rejectedTransition(
  snapshot: SyntheticDebugMachineSnapshot,
  request: SyntheticDebugTransitionRequest,
  code: SyntheticDebugTransitionErrorCode,
  message: string,
): SyntheticDebugTransitionRejected {
  return Object.freeze({
    ok: false,
    snapshot,
    error: Object.freeze({
      code,
      message,
      state: snapshot.state,
      attemptedEvent: request.event,
      allowedEvents: allowedSyntheticDebugEvents(snapshot.state),
    }),
  });
}

export function transitionSyntheticDebugMachine(
  snapshot: SyntheticDebugMachineSnapshot,
  request: SyntheticDebugTransitionRequest,
): SyntheticDebugTransitionResult {
  if (isSyntheticDebugTerminalState(snapshot.state)) {
    return rejectedTransition(
      snapshot,
      request,
      'TERMINAL_STATE',
      `State ${snapshot.state} is terminal and cannot transition`,
    );
  }

  if (!validReasons(request.reasons)) {
    return rejectedTransition(
      snapshot,
      request,
      'INVALID_REASON',
      'A transition requires at least one non-empty structured reason',
    );
  }

  const nextState = ALLOWED_SYNTHETIC_DEBUG_TRANSITIONS[snapshot.state][request.event];
  if (nextState === undefined) {
    return rejectedTransition(
      snapshot,
      request,
      'INVALID_TRANSITION',
      `Event ${request.event} is not allowed from state ${snapshot.state}`,
    );
  }

  const reasons = Object.freeze(request.reasons.map((reason) => Object.freeze({ ...reason })));
  const transition = Object.freeze({
    sequence: snapshot.history.length + 1,
    event: request.event,
    from: snapshot.state,
    to: nextState,
    reasons,
  });
  const nextSnapshot = Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    workflowKind: snapshot.workflowKind,
    state: nextState,
    outcome: terminalOutcome(nextState),
    history: Object.freeze([...snapshot.history, transition]),
  });

  return Object.freeze({
    ok: true,
    snapshot: nextSnapshot,
    transition,
  });
}
