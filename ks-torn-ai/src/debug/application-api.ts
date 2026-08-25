import type { SyntheticDebugMemoryPersistenceResult } from './memory-integration.js';
import type {
  SyntheticDebugDiscoveryController,
  SyntheticDebugOrchestrationCreateResult,
  SyntheticDebugOrchestrationError,
  SyntheticDebugOrchestrationResult,
  SyntheticDebugOrchestrationSnapshot,
} from './orchestrator.js';
import type { DebugDeliveryReport } from './report.js';
import { isSyntheticDebugTerminalState, type SyntheticDebugState } from './state-machine.js';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type SyntheticDebugApplicationNextAction =
  | 'START_DISCOVERY'
  | 'COLLECT_EVIDENCE'
  | 'RESOLVE_BASELINE'
  | 'RECORD_ROOT_CAUSE'
  | 'AWAIT_DEFECT_REFERENCE_AUTHORIZATION'
  | 'EVALUATE_IMPLEMENTATION_GATE'
  | 'REQUEST_WRITE_APPROVAL'
  | 'AWAIT_APPROVAL_DECISION'
  | 'EXECUTE_APPROVED_IMPLEMENTATION'
  | 'EVALUATE_VERIFICATION'
  | 'REQUEST_INDEPENDENT_REVIEW'
  | 'EVALUATE_FINAL_DELIVERY'
  | 'PERSIST_OUTCOME'
  | 'NONE';

export interface SyntheticDebugCaseHandle {
  readonly caseId: string;
  readonly projectId: string;
}

export interface SyntheticDebugSafeSnapshot {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly caseId: string;
  readonly projectId: string;
  readonly state: SyntheticDebugState;
  readonly history: SyntheticDebugOrchestrationSnapshot['machine']['history'];
  readonly blockers: readonly { readonly code: string; readonly summary: string }[];
  readonly baselineMode: SyntheticDebugOrchestrationSnapshot['baselineMode'];
  readonly baselineSha: string | null;
  readonly referenceWasOwnerVerifiedKnownGood: boolean;
  readonly candidateSha: string | null;
  readonly rollbackRef: string | null;
  readonly verificationStatus: string | null;
  readonly reviewStatus: string | null;
  readonly pendingProposal: Readonly<{
    proposalId: string;
    boundedChangeSummary: string;
    approvedPaths: readonly string[];
    requiredTestProfileIds: readonly string[];
  }> | null;
  readonly finalReport: DeepReadonly<DebugDeliveryReport> | null;
  readonly persistenceStatus: 'NOT_PERSISTED' | 'PERSISTED' | 'FAILED';
  readonly nextAction: Readonly<{
    action: SyntheticDebugApplicationNextAction;
    blockers: readonly string[];
  }>;
}

export type SyntheticDebugApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'WRONG_CASE'
  | 'WRONG_PROJECT'
  | 'TRANSITION_NOT_PERMITTED'
  | 'MISSING_TRUSTED_CAPABILITY'
  | 'BLOCKED_BY_POLICY'
  | 'TRUSTED_DEPENDENCY_FAILURE'
  | 'TERMINAL_CASE'
  | 'INTERNAL_FAILURE';

export interface SyntheticDebugApplicationError {
  readonly code: SyntheticDebugApplicationErrorCode;
  readonly message: string;
  readonly state: SyntheticDebugState | null;
}

export type SyntheticDebugApplicationResult =
  | { readonly ok: true; readonly snapshot: SyntheticDebugSafeSnapshot }
  | {
      readonly ok: false;
      readonly error: SyntheticDebugApplicationError;
      readonly snapshot: SyntheticDebugSafeSnapshot | null;
    };

export interface SyntheticDebugApplicationDependencies {
  readonly orchestrator: SyntheticDebugDiscoveryController;
  readonly memorySink?: {
    persist(input: unknown): Promise<SyntheticDebugMemoryPersistenceResult>;
  };
}

function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function nextAction(snapshot: SyntheticDebugOrchestrationSnapshot, persisted: boolean) {
  const blockers = snapshot.machine.history.at(-1)?.reasons.map(({ summary }) => summary) ?? [];
  let action: SyntheticDebugApplicationNextAction;
  switch (snapshot.machine.state) {
    case 'INTAKE':
      action = 'START_DISCOVERY';
      break;
    case 'DISCOVERY':
      action = 'COLLECT_EVIDENCE';
      break;
    case 'EVIDENCE_READY':
      action =
        snapshot.discovery?.knownGoodResolution.status === 'MISSING'
          ? snapshot.rootCause === null
            ? 'RECORD_ROOT_CAUSE'
            : 'AWAIT_DEFECT_REFERENCE_AUTHORIZATION'
          : 'RESOLVE_BASELINE';
      break;
    case 'BASELINE_READY':
      action = 'RECORD_ROOT_CAUSE';
      break;
    case 'ROOT_CAUSE_READY':
      action = 'EVALUATE_IMPLEMENTATION_GATE';
      break;
    case 'IMPLEMENTATION_READY':
      action = 'REQUEST_WRITE_APPROVAL';
      break;
    case 'AWAITING_WRITE_APPROVAL':
      action = 'AWAIT_APPROVAL_DECISION';
      break;
    case 'IMPLEMENTING':
      action = 'EXECUTE_APPROVED_IMPLEMENTATION';
      break;
    case 'VERIFYING':
      action = 'EVALUATE_VERIFICATION';
      break;
    case 'REVIEWING':
      action =
        snapshot.independentReview?.disposition === 'pass'
          ? 'EVALUATE_FINAL_DELIVERY'
          : 'REQUEST_INDEPENDENT_REVIEW';
      break;
    default:
      action = persisted ? 'NONE' : 'PERSIST_OUTCOME';
  }
  return freeze({ action, blockers: action === 'NONE' ? [] : blockers });
}

function safeSnapshot(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  persistenceStatus: 'NOT_PERSISTED' | 'PERSISTED' | 'FAILED',
): SyntheticDebugSafeSnapshot {
  const proposal = snapshot.writeProposal;
  return freeze({
    schemaVersion: '1.0' as const,
    workflowKind: 'synthetic' as const,
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    state: snapshot.machine.state,
    history: snapshot.machine.history.map((transition) => ({
      ...transition,
      reasons: transition.reasons.map((reason) => ({ ...reason })),
    })),
    blockers: isSyntheticDebugTerminalState(snapshot.machine.state)
      ? (snapshot.machine.history.at(-1)?.reasons.map((reason) => ({ ...reason })) ?? [])
      : [],
    baselineMode: snapshot.baselineMode,
    baselineSha:
      snapshot.baselineMode === 'KNOWN_GOOD'
        ? (snapshot.knownGoodBaseline?.commitSha ?? null)
        : (snapshot.defectReference?.commitSha ?? null),
    referenceWasOwnerVerifiedKnownGood:
      snapshot.knownGoodBaseline?.ownerVerification.status === 'OWNER_VERIFIED',
    candidateSha: snapshot.workerExecution?.candidateSha ?? null,
    rollbackRef: proposal?.rollbackRef ?? null,
    verificationStatus: snapshot.verificationDecision?.status ?? null,
    reviewStatus: snapshot.independentReview?.disposition ?? null,
    pendingProposal:
      proposal === null
        ? null
        : {
            proposalId: proposal.proposalId,
            boundedChangeSummary: proposal.boundedChangeSummary,
            approvedPaths: [...proposal.approvedPaths],
            requiredTestProfileIds: [...proposal.requiredTestProfileIds],
          },
    finalReport: snapshot.finalDelivery === null ? null : structuredClone(snapshot.finalDelivery),
    persistenceStatus,
    nextAction: nextAction(snapshot, persistenceStatus === 'PERSISTED'),
  });
}

function mappedError(error: SyntheticDebugOrchestrationError): SyntheticDebugApplicationError {
  let code: SyntheticDebugApplicationErrorCode;
  if (error.code === 'MALFORMED_MODEL_RECORD' || error.code === 'UNSUPPORTED_RECORD_KIND') {
    code = 'INVALID_INPUT';
  } else if (error.code === 'TERMINAL_STATE') {
    code = 'TERMINAL_CASE';
  } else if (error.code === 'OUT_OF_ORDER' || error.code === 'TRANSITION_REJECTED') {
    code = 'TRANSITION_NOT_PERMITTED';
  } else if (error.code.includes('SCOPE_MISMATCH')) {
    code = 'WRONG_CASE';
  } else {
    code = 'BLOCKED_BY_POLICY';
  }
  return freeze({
    code,
    message: 'The requested debug operation was rejected.',
    state: error.state,
  });
}

function durableOutcome(snapshot: SyntheticDebugOrchestrationSnapshot) {
  const report = snapshot.finalDelivery;
  const knownGood = snapshot.knownGoodBaseline;
  const defectReference = snapshot.defectReference;
  const baselineSha =
    report?.baselineSha ??
    (snapshot.baselineMode === 'KNOWN_GOOD' ? knownGood?.commitSha : defectReference?.commitSha) ??
    null;
  const defectEvidenceIds = new Set(defectReference?.defectEvidenceReferences ?? []);
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
    finalDisposition: report?.status ?? 'BLOCKED',
    baselineMode: snapshot.baselineMode,
    baselineSha,
    referenceVersion: defectReference?.referenceVersion ?? null,
    referenceWasOwnerVerifiedKnownGood: knownGood?.ownerVerification.status === 'OWNER_VERIFIED',
    ownerAcknowledgement:
      snapshot.baselineMode === 'KNOWN_GOOD'
        ? knownGood?.ownerVerification.status === 'OWNER_VERIFIED'
          ? {
              status: 'OWNER_VERIFIED_KNOWN_GOOD' as const,
              evidenceReference: knownGood.ownerVerification.evidenceReference,
            }
          : null
        : defectReference === null
          ? null
          : {
              status: 'OWNER_ACKNOWLEDGED_DEFECT_REFERENCE' as const,
              evidenceReference: defectReference.ownerAcknowledgement.evidenceReference,
            },
    historicalSearchBoundary: defectReference?.historicalSearchBoundary ?? null,
    defectEvidenceProvenance: snapshot.intake.evidenceReferences
      .filter(({ evidenceId }) => defectEvidenceIds.has(evidenceId))
      .map(({ evidenceId, kind, reference }) => ({ evidenceId, kind, reference })),
    knownPreExistingDefects: defectReference?.knownPreExistingDefects ?? [],
    knownUnrelatedFailures: defectReference?.knownUnrelatedFailures ?? [],
    referenceSelectionReason: defectReference?.reasonSelected ?? null,
    rollbackReferenceSemantics: defectReference?.rollbackReferenceSemantics ?? null,
    writeApprovalProvenance:
      snapshot.writeApprovalDecision === null
        ? null
        : {
            decisionReferenceId: snapshot.writeApprovalDecision.decisionReferenceId,
            decision: snapshot.writeApprovalDecision.decision,
          },
    candidateSha: report?.candidateSha ?? snapshot.workerExecution?.candidateSha ?? null,
    verificationDecisionId:
      snapshot.verificationDecision === null ? null : `verification-${snapshot.caseId}`,
    verificationStatus: snapshot.verificationDecision?.status ?? null,
    verificationProfiles:
      snapshot.verificationDecision?.profileResults.map(({ profileId, status }) => ({
        profileId,
        status,
      })) ?? [],
    reviewId: snapshot.independentReview?.reviewId ?? null,
    reviewDisposition: snapshot.independentReview?.disposition ?? 'not_run',
    failureCodes: snapshot.machine.history
      .flatMap(({ reasons }) => reasons.map(({ code }) => code))
      .filter(() => snapshot.machine.state !== 'TEST_READY'),
  };
}

/** Trusted application facade. It is not a model-tool schema or an authorization boundary. */
export class SyntheticDebugApplicationApi {
  readonly #orchestrator: SyntheticDebugDiscoveryController;
  readonly #memorySink: SyntheticDebugApplicationDependencies['memorySink'];
  #snapshot: SyntheticDebugOrchestrationSnapshot | null = null;
  #persistenceStatus: 'NOT_PERSISTED' | 'PERSISTED' | 'FAILED' = 'NOT_PERSISTED';

  constructor(dependencies: SyntheticDebugApplicationDependencies) {
    this.#orchestrator = dependencies.orchestrator;
    this.#memorySink = dependencies.memorySink;
    Object.freeze(this);
  }

  createCase(modelSafeIntake: unknown): SyntheticDebugApplicationResult {
    if (this.#snapshot !== null) return this.#failure('TRANSITION_NOT_PERMITTED', 'Case exists');
    const result = this.#orchestrator.createCase(modelSafeIntake);
    return this.#captureCreate(result);
  }

  getSnapshot(handle: SyntheticDebugCaseHandle): SyntheticDebugApplicationResult {
    const invalid = this.#identity(handle);
    return invalid ?? this.#success();
  }

  startDiscovery(handle: SyntheticDebugCaseHandle) {
    return this.#runSync(handle, (snapshot) => this.#orchestrator.startDiscovery(snapshot));
  }

  completeDiscovery(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.completeDiscovery(snapshot));
  }

  resolveTrustedBaseline(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.resolveTrustedBaseline(snapshot));
  }

  /** Trusted application entry point. DEFECT_REFERENCE data is read from an injected capability. */
  authorizeDefectReference(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.authorizeDefectReference(snapshot));
  }

  recordEvidenceAndRootCause(handle: SyntheticDebugCaseHandle, modelSafeRootCause: unknown) {
    return this.#runSync(handle, (snapshot) =>
      this.#orchestrator.recordEvidenceAndRootCause(snapshot, modelSafeRootCause),
    );
  }

  evaluateImplementationGate(handle: SyntheticDebugCaseHandle) {
    return this.#runSync(handle, (snapshot) =>
      this.#orchestrator.evaluateImplementationGate(snapshot),
    );
  }

  requestWriteApproval(handle: SyntheticDebugCaseHandle, modelSafePlan: unknown) {
    return this.#runSync(handle, (snapshot) =>
      this.#orchestrator.requestWriteApproval(snapshot, modelSafePlan),
    );
  }

  resolveWriteApproval(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.resolveWriteApproval(snapshot));
  }

  executeApprovedImplementation(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) =>
      this.#orchestrator.executeApprovedImplementation(snapshot),
    );
  }

  evaluateVerification(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.evaluateVerification(snapshot));
  }

  requestIndependentReview(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.evaluateIndependentReview(snapshot));
  }

  evaluateFinalDelivery(handle: SyntheticDebugCaseHandle) {
    return this.#run(handle, (snapshot) => this.#orchestrator.evaluateFinalDelivery(snapshot));
  }

  async persistOutcome(handle: SyntheticDebugCaseHandle): Promise<SyntheticDebugApplicationResult> {
    const invalid = this.#identity(handle);
    if (invalid !== null) return invalid;
    const snapshot = this.#snapshot;
    if (snapshot === null) return this.#failure('INVALID_INPUT', 'Case is not created');
    if (!isSyntheticDebugTerminalState(snapshot.machine.state)) {
      return this.#failure('TRANSITION_NOT_PERMITTED', 'Outcome is not terminal');
    }
    if (this.#persistenceStatus === 'PERSISTED') return this.#success();
    if (this.#memorySink === undefined) {
      return this.#failure('MISSING_TRUSTED_CAPABILITY', 'Memory capability is unavailable');
    }
    try {
      await this.#memorySink.persist(durableOutcome(snapshot));
      this.#persistenceStatus = 'PERSISTED';
      return this.#success();
    } catch {
      this.#persistenceStatus = 'FAILED';
      return this.#failure('TRUSTED_DEPENDENCY_FAILURE', 'Outcome persistence failed');
    }
  }

  #identity(handle: SyntheticDebugCaseHandle): SyntheticDebugApplicationResult | null {
    if (this.#snapshot === null) return this.#failure('INVALID_INPUT', 'Case is not created');
    if (handle.caseId !== this.#snapshot.caseId)
      return this.#failure('WRONG_CASE', 'Case identity does not match');
    if (handle.projectId !== this.#snapshot.projectId)
      return this.#failure('WRONG_PROJECT', 'Project identity does not match');
    return null;
  }

  #captureCreate(result: SyntheticDebugOrchestrationCreateResult): SyntheticDebugApplicationResult {
    if (!result.ok) return freeze({ ok: false, error: mappedError(result.error), snapshot: null });
    this.#snapshot = result.snapshot;
    return this.#success();
  }

  #capture(result: SyntheticDebugOrchestrationResult): SyntheticDebugApplicationResult {
    if (result.ok) {
      this.#snapshot = result.snapshot;
      return this.#success();
    }
    return freeze({ ok: false, error: mappedError(result.error), snapshot: this.#safe() });
  }

  #runSync(
    handle: SyntheticDebugCaseHandle,
    operation: (snapshot: SyntheticDebugOrchestrationSnapshot) => SyntheticDebugOrchestrationResult,
  ): SyntheticDebugApplicationResult {
    const invalid = this.#identity(handle);
    if (invalid !== null) return invalid;
    const snapshot = this.#snapshot;
    if (snapshot === null) return this.#failure('INVALID_INPUT', 'Case is not created');
    return this.#capture(operation(snapshot));
  }

  async #run(
    handle: SyntheticDebugCaseHandle,
    operation: (
      snapshot: SyntheticDebugOrchestrationSnapshot,
    ) => Promise<SyntheticDebugOrchestrationResult>,
  ): Promise<SyntheticDebugApplicationResult> {
    const invalid = this.#identity(handle);
    if (invalid !== null) return invalid;
    const snapshot = this.#snapshot;
    if (snapshot === null) return this.#failure('INVALID_INPUT', 'Case is not created');
    return this.#capture(await operation(snapshot));
  }

  #safe() {
    return this.#snapshot === null ? null : safeSnapshot(this.#snapshot, this.#persistenceStatus);
  }

  #success(): SyntheticDebugApplicationResult {
    const snapshot = this.#safe();
    return snapshot === null
      ? freeze({
          ok: false,
          error: { code: 'INTERNAL_FAILURE', message: 'Case snapshot is unavailable', state: null },
          snapshot: null,
        })
      : freeze({ ok: true, snapshot });
  }

  #failure(
    code: SyntheticDebugApplicationErrorCode,
    message: string,
  ): SyntheticDebugApplicationResult {
    return freeze({
      ok: false,
      error: { code, message, state: this.#snapshot?.machine.state ?? null },
      snapshot: this.#safe(),
    });
  }
}
