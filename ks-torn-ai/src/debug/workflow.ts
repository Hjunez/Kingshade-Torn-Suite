import type { WorkerJobResult } from '../worker/contracts.js';
import {
  buildDebugDeliveryReport,
  type DefectReferenceReportContext,
  type DebugDeliveryReport,
  type IndependentReviewRecord,
  type ProblemEvidenceRecord,
  type VerificationRecord,
} from './report.js';
import type { SyntheticDebugBaselineMode } from './baseline-mode.js';

export interface DebugWorkflowReportInput {
  workflowKind: 'production' | 'synthetic';
  workerResult: WorkerJobResult;
  baselineMode?: SyntheticDebugBaselineMode;
  baselineOwnerVerified: boolean;
  referenceWasOwnerVerifiedKnownGood?: boolean;
  defectReference?: DefectReferenceReportContext | null;
  problemEvidence: readonly ProblemEvidenceRecord[];
  rootCause: string;
  approvedPaths: readonly string[];
  affectedSurfaces: readonly string[];
  requiredProfileIds: readonly string[];
  review: IndependentReviewRecord;
  rollbackRef?: string;
  unresolvedBlockingUncertainty: readonly string[];
  unresolvedNonBlockingUncertainty: readonly string[];
}

function verificationFromWorker(result: WorkerJobResult): readonly VerificationRecord[] {
  return result.actions
    .filter(
      (
        action,
      ): action is typeof action & {
        profileId: string;
      } => action.kind === 'run_test_profile' && action.profileId !== undefined,
    )
    .map((action) => ({
      profileId: action.profileId,
      required: true,
      status:
        action.status === 'passed'
          ? 'passed'
          : action.status === 'failed'
            ? 'failed'
            : action.status === 'error'
              ? 'error'
              : 'skipped',
      ...(action.exitCode === undefined ? {} : { exitCode: action.exitCode }),
      startedAt: action.startedAt,
      finishedAt: action.finishedAt,
      summary: action.summary,
    }));
}

export function buildDebugWorkflowReport(input: DebugWorkflowReportInput): DebugDeliveryReport {
  const finalized = input.workerResult.actions.some(
    (action) => action.kind === 'finalize_candidate' && action.status === 'passed',
  );
  const candidateSha =
    finalized &&
    input.workerResult.headShaAfter.toLowerCase() !== input.workerResult.baselineRef.toLowerCase()
      ? input.workerResult.headShaAfter
      : null;
  return buildDebugDeliveryReport({
    workflowKind: input.workflowKind,
    workerJobId: input.workerResult.jobId,
    projectId: input.workerResult.projectId,
    ...(input.baselineMode === undefined ? {} : { baselineMode: input.baselineMode }),
    baselineSha: input.workerResult.baselineRef,
    baselineOwnerVerified: input.baselineOwnerVerified,
    ...(input.referenceWasOwnerVerifiedKnownGood === undefined
      ? {}
      : { referenceWasOwnerVerifiedKnownGood: input.referenceWasOwnerVerifiedKnownGood }),
    ...(input.defectReference === undefined ? {} : { defectReference: input.defectReference }),
    candidateSha,
    isolatedBranch: input.workerResult.workspaceBranch ?? null,
    workspacePath: input.workerResult.workspacePath ?? null,
    rollbackRef: input.rollbackRef ?? input.workerResult.baselineRef,
    rollbackSha: input.workerResult.baselineRef,
    problemEvidence: input.problemEvidence,
    rootCause: input.rootCause,
    approvedPaths: input.approvedPaths,
    changedPaths: input.workerResult.changedPaths,
    affectedSurfaces: input.affectedSurfaces,
    requiredProfileIds: input.requiredProfileIds,
    verification: verificationFromWorker(input.workerResult),
    review: input.review,
    unresolvedBlockingUncertainty: input.unresolvedBlockingUncertainty,
    unresolvedNonBlockingUncertainty: input.unresolvedNonBlockingUncertainty,
  });
}
