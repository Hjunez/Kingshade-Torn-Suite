import { z } from 'zod';

import { isValidRepositoryRef, redactRepositorySecrets } from '../repository/validation.js';
import { normalizeRelativeWorkerPath } from '../worker/path-policy.js';
import { isFullCommitSha } from './gates.js';

const MAX_RECORDS_PER_LIST = 30;

const recordIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const projectIdentifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const statementSchema = z.string().trim().min(1).max(2_000);
const shortStatementSchema = z.string().trim().min(1).max(500);
const referenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !value.includes('\0'), 'Reference cannot contain NUL');

const exactCommitShaSchema = z
  .string()
  .refine((value) => isFullCommitSha(value), 'Expected an exact 40-character commit SHA');

const repositoryRefSchema = z
  .string()
  .refine(isValidRepositoryRef, 'Expected a safe repository ref');

const workerPathSchema = z
  .string()
  .refine(
    (value) => value !== '.' && normalizeRelativeWorkerPath(value) === value,
    'Expected a canonical bounded repository-relative path',
  );

const testProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const approvalDecisionReferenceSchema = recordIdentifierSchema.refine(
  (value) =>
    value.startsWith('approval-decision-') &&
    value.length > 'approval-decision-'.length &&
    !/[0-9a-f]{64}/i.test(value) &&
    redactRepositorySecrets(value).redactionCount === 0,
  'Expected a non-secret approval decision reference',
);
const independentReviewIdentifierSchema = recordIdentifierSchema.refine(
  (value) => !/^[0-9a-f]{64}$/i.test(value) && redactRepositorySecrets(value).redactionCount === 0,
  'Expected a non-secret independent review identifier',
);
const independentReviewPackageIdentifierSchema = recordIdentifierSchema.regex(
  /^review-package-[0-9a-f]{64}$/i,
);

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const statementListSchema = z
  .array(shortStatementSchema)
  .max(MAX_RECORDS_PER_LIST)
  .refine(hasUniqueStrings, 'List entries must be unique');

const nonEmptyStatementListSchema = z
  .array(shortStatementSchema)
  .min(1)
  .max(MAX_RECORDS_PER_LIST)
  .refine(hasUniqueStrings, 'List entries must be unique');

const nonEmptyEvidenceIdListSchema = z
  .array(recordIdentifierSchema)
  .min(1)
  .max(MAX_RECORDS_PER_LIST)
  .refine(hasUniqueStrings, 'Evidence references must be unique');

const workflowRecordFields = {
  schemaVersion: z.literal('1.0'),
  workflowKind: z.literal('synthetic'),
  caseId: recordIdentifierSchema,
  projectId: projectIdentifierSchema,
};

export const syntheticDebugEvidenceReferenceSchema = z
  .object({
    evidenceId: recordIdentifierSchema,
    kind: z.enum([
      'USER_PROVIDED',
      'REPRODUCIBLE',
      'REPOSITORY',
      'AUTOMATED_TEST',
      'SYNTHETIC_FIXTURE',
    ]),
    reference: referenceSchema,
  })
  .strict();

const evidenceReferenceListSchema = z
  .array(syntheticDebugEvidenceReferenceSchema)
  .max(MAX_RECORDS_PER_LIST)
  .refine(
    (records) => hasUniqueStrings(records.map((record) => record.evidenceId)),
    'Evidence identifiers must be unique',
  );

export const syntheticDebugIntakeRecordSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('INTAKE'),
    problem: statementSchema,
    affectedSurfaces: nonEmptyStatementListSchema,
    evidenceReferences: evidenceReferenceListSchema,
  })
  .strict();

export const syntheticDebugRootCauseRecordSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('ROOT_CAUSE'),
    rootCauseId: recordIdentifierSchema,
    explanation: statementSchema,
    evidenceReferences: nonEmptyEvidenceIdListSchema,
    status: z.enum(['verified', 'hypothesis', 'unresolved']),
    confidence: z.enum(['high', 'medium', 'low']),
    unresolvedUncertainty: statementListSchema,
  })
  .strict();

const allowedPathListSchema = z
  .array(workerPathSchema)
  .min(1)
  .max(100)
  .refine(hasUniqueStrings, 'Allowed paths must be unique');

const requiredProfileListSchema = z
  .array(testProfileIdSchema)
  .min(1)
  .max(30)
  .refine(hasUniqueStrings, 'Required test profile identifiers must be unique');

const proposedSyntheticBranchSchema = repositoryRefSchema.refine(
  (value) =>
    value.startsWith('ks-leslie/synthetic/') && value.length > 'ks-leslie/synthetic/'.length,
  'Expected an isolated ks-leslie/synthetic branch',
);

export const syntheticDebugImplementationPlanRecordSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('IMPLEMENTATION_PLAN'),
    planId: recordIdentifierSchema,
    authority: z.literal('PROPOSAL_ONLY'),
    allowedPaths: allowedPathListSchema,
    requiredTestProfileIds: requiredProfileListSchema,
    boundedChangeSummary: statementSchema,
    rollbackSha: exactCommitShaSchema,
    rollbackRef: repositoryRefSchema,
    proposedIsolatedBranch: proposedSyntheticBranchSchema,
    proposedWorkspaceId: recordIdentifierSchema,
  })
  .strict();

export const syntheticDebugWriteProposalSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('WRITE_PROPOSAL'),
    proposalId: recordIdentifierSchema,
    planId: recordIdentifierSchema,
    baselineSha: exactCommitShaSchema,
    boundedChangeSummary: statementSchema,
    approvedPaths: allowedPathListSchema,
    requiredTestProfileIds: requiredProfileListSchema,
    rollbackSha: exactCommitShaSchema,
    rollbackRef: repositoryRefSchema,
    proposedIsolatedBranch: proposedSyntheticBranchSchema,
    proposedWorkspaceId: recordIdentifierSchema,
  })
  .strict();

export const trustedOwnerVerificationSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('OWNER_VERIFIED'),
      evidenceReference: referenceSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('UNVERIFIED'),
      evidenceReference: z.null(),
    })
    .strict(),
]);

export const trustedSyntheticDebugBaselineRecordSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('BASELINE'),
    sourceBoundary: z.literal('TRUSTED_APPLICATION'),
    commitSha: exactCommitShaSchema,
    provenance: z.enum([
      'owner_verification',
      'regression_suite',
      'release_record',
      'manual_review',
    ]),
    sourceReference: referenceSchema,
    ownerVerification: trustedOwnerVerificationSchema,
    knownBlockers: statementListSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const ownerProvenance = record.provenance === 'owner_verification';
    const ownerVerified = record.ownerVerification.status === 'OWNER_VERIFIED';
    if (ownerProvenance !== ownerVerified) {
      context.addIssue({
        code: 'custom',
        path: ['ownerVerification'],
        message: 'Only trusted owner-verification provenance can establish owner verification',
      });
    }
    if (ownerVerified && record.ownerVerification.evidenceReference !== record.sourceReference) {
      context.addIssue({
        code: 'custom',
        path: ['ownerVerification', 'evidenceReference'],
        message: 'Owner-verification evidence must match the trusted source reference',
      });
    }
  });

export const trustedSyntheticDebugApprovalDecisionSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('WRITE_APPROVAL_DECISION'),
    sourceBoundary: z.literal('TRUSTED_APPLICATION'),
    proposalId: recordIdentifierSchema,
    decisionReferenceId: approvalDecisionReferenceSchema,
    decision: z.enum(['APPROVED', 'DENIED', 'CANCELLED']),
  })
  .strict();

export const trustedSyntheticDebugReviewRecordSchema = z
  .object({
    ...workflowRecordFields,
    recordKind: z.literal('INDEPENDENT_REVIEW'),
    sourceBoundary: z.literal('INDEPENDENT_REVIEW_SERVICE'),
    reviewId: independentReviewIdentifierSchema,
    reviewPackageId: independentReviewPackageIdentifierSchema,
    candidateSha: exactCommitShaSchema,
    disposition: z.enum(['pass', 'fail', 'blocked']),
    summary: statementSchema,
    findings: statementListSchema,
    blockers: statementListSchema,
    evidenceInspected: nonEmptyEvidenceIdListSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.disposition === 'pass' && record.blockers.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['blockers'],
        message: 'A passing independent review cannot contain blockers',
      });
    }
    if (record.disposition !== 'pass' && record.blockers.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['blockers'],
        message: 'A failed or blocked independent review must preserve its blockers',
      });
    }
  });

export const modelSyntheticDebugRecordSchema = z.discriminatedUnion('recordKind', [
  syntheticDebugIntakeRecordSchema,
  syntheticDebugRootCauseRecordSchema,
  syntheticDebugImplementationPlanRecordSchema,
]);

export const syntheticDebugWorkflowRecordSchema = z.union([
  modelSyntheticDebugRecordSchema,
  syntheticDebugWriteProposalSchema,
  trustedSyntheticDebugBaselineRecordSchema,
  trustedSyntheticDebugApprovalDecisionSchema,
  trustedSyntheticDebugReviewRecordSchema,
]);

export type SyntheticDebugEvidenceReference = z.infer<typeof syntheticDebugEvidenceReferenceSchema>;
export type SyntheticDebugIntakeRecord = z.infer<typeof syntheticDebugIntakeRecordSchema>;
export type SyntheticDebugRootCauseRecord = z.infer<typeof syntheticDebugRootCauseRecordSchema>;
export type SyntheticDebugImplementationPlanRecord = z.infer<
  typeof syntheticDebugImplementationPlanRecordSchema
>;
export type SyntheticDebugWriteProposal = z.infer<typeof syntheticDebugWriteProposalSchema>;
export type TrustedOwnerVerification = z.infer<typeof trustedOwnerVerificationSchema>;
export type TrustedSyntheticDebugBaselineRecord = z.infer<
  typeof trustedSyntheticDebugBaselineRecordSchema
>;
export type TrustedSyntheticDebugApprovalDecision = z.infer<
  typeof trustedSyntheticDebugApprovalDecisionSchema
>;
export type TrustedSyntheticDebugReviewRecord = z.infer<
  typeof trustedSyntheticDebugReviewRecordSchema
>;
export type ModelSyntheticDebugRecord = z.infer<typeof modelSyntheticDebugRecordSchema>;
export type SyntheticDebugWorkflowRecord = z.infer<typeof syntheticDebugWorkflowRecordSchema>;

export function parseModelSyntheticDebugRecord(input: unknown): ModelSyntheticDebugRecord {
  return modelSyntheticDebugRecordSchema.parse(input);
}

export function parseTrustedSyntheticDebugBaselineRecord(
  input: unknown,
): TrustedSyntheticDebugBaselineRecord {
  return trustedSyntheticDebugBaselineRecordSchema.parse(input);
}

export function parseTrustedSyntheticDebugApprovalDecision(
  input: unknown,
): TrustedSyntheticDebugApprovalDecision {
  return trustedSyntheticDebugApprovalDecisionSchema.parse(input);
}

export function parseTrustedSyntheticDebugReviewRecord(
  input: unknown,
): TrustedSyntheticDebugReviewRecord {
  return trustedSyntheticDebugReviewRecordSchema.parse(input);
}

export function parseSyntheticDebugWorkflowRecord(input: unknown): SyntheticDebugWorkflowRecord {
  return syntheticDebugWorkflowRecordSchema.parse(input);
}
