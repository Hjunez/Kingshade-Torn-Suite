export interface ImplementationGateInput {
  knownGoodBaselineSha: string | null;
  evidenceItems: number;
  rootCauseRecorded: boolean;
}

export interface DeliveryGateInput {
  isolatedBranch: string | null;
  rollbackRef: string | null;
  changedPaths: readonly string[];
  relevantTestsRun: number;
  requiredTestsFailed: number;
  independentReview: 'passed' | 'failed' | 'not_run';
  unresolvedBlockingUncertainty: readonly string[];
}

export interface GateDecision {
  allowed: boolean;
  blockers: readonly string[];
}

export function canStartImplementation(input: ImplementationGateInput): GateDecision {
  const blockers: string[] = [];

  if (input.knownGoodBaselineSha === null) {
    blockers.push('no explicitly verified known-good baseline');
  }
  if (input.evidenceItems < 1) {
    blockers.push('no defect evidence collected');
  }
  if (!input.rootCauseRecorded) {
    blockers.push('root cause has not been recorded');
  }

  return { allowed: blockers.length === 0, blockers };
}

export function canDeliverTestCandidate(input: DeliveryGateInput): GateDecision {
  const blockers: string[] = [];

  if (input.isolatedBranch === null) {
    blockers.push('no isolated branch or workspace');
  }
  if (input.rollbackRef === null) {
    blockers.push('rollback reference is missing');
  }
  if (input.changedPaths.length === 0) {
    blockers.push('no bounded code change recorded');
  }
  if (input.relevantTestsRun < 1) {
    blockers.push('no relevant tests were executed');
  }
  if (input.requiredTestsFailed > 0) {
    blockers.push('one or more required tests failed');
  }
  if (input.independentReview !== 'passed') {
    blockers.push(
      input.independentReview === 'failed'
        ? 'independent review failed'
        : 'independent review was not run',
    );
  }
  blockers.push(...input.unresolvedBlockingUncertainty.map((item) => `blocking uncertainty: ${item}`));

  return { allowed: blockers.length === 0, blockers };
}
