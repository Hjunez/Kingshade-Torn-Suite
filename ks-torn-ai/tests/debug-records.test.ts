import { describe, expect, it } from 'vitest';

import {
  modelSyntheticDebugRecordSchema,
  parseModelSyntheticDebugRecord,
  parseSyntheticDebugWorkflowRecord,
  parseTrustedSyntheticDebugBaselineRecord,
  parseTrustedSyntheticDebugReviewRecord,
  syntheticDebugImplementationPlanRecordSchema,
  trustedSyntheticDebugBaselineRecordSchema,
  trustedSyntheticDebugReviewRecordSchema,
  type ModelSyntheticDebugRecord,
  type TrustedSyntheticDebugBaselineRecord,
  type TrustedSyntheticDebugReviewRecord,
} from '../src/debug/records.js';

const baselineSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);

const intake = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'INTAKE',
  caseId: 'synthetic-case-1',
  projectId: 'synthetic',
  problem: 'The synthetic fixture contains the wrong deterministic value.',
  affectedSurfaces: ['synthetic fixture'],
  evidenceReferences: [
    {
      evidenceId: 'fixture-reproduction',
      kind: 'SYNTHETIC_FIXTURE',
      reference: 'fixture:wrong-value',
    },
  ],
} as const satisfies ModelSyntheticDebugRecord;

const rootCause = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'ROOT_CAUSE',
  caseId: 'synthetic-case-1',
  projectId: 'synthetic',
  rootCauseId: 'root-cause-1',
  explanation: 'The fixture starts with alpha instead of the expected beta value.',
  evidenceReferences: ['fixture-reproduction'],
  status: 'verified',
  confidence: 'high',
  unresolvedUncertainty: [],
} as const satisfies ModelSyntheticDebugRecord;

const implementationPlan = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'IMPLEMENTATION_PLAN',
  caseId: 'synthetic-case-1',
  projectId: 'synthetic',
  planId: 'implementation-plan-1',
  authority: 'PROPOSAL_ONLY',
  allowedPaths: ['fixture.txt'],
  requiredTestProfileIds: ['synthetic-check'],
  boundedChangeSummary: 'Change the synthetic fixture from alpha to beta.',
  rollbackSha: baselineSha,
  rollbackRef: baselineSha,
  proposedIsolatedBranch: 'ks-leslie/synthetic/case-1',
  proposedWorkspaceId: 'synthetic-workspace-1',
} as const satisfies ModelSyntheticDebugRecord;

const trustedBaseline = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'BASELINE',
  caseId: 'synthetic-case-1',
  projectId: 'synthetic',
  sourceBoundary: 'TRUSTED_APPLICATION',
  commitSha: baselineSha,
  provenance: 'owner_verification',
  sourceReference: 'owner-fixture:baseline-a',
  ownerVerification: {
    status: 'OWNER_VERIFIED',
    evidenceReference: 'owner-fixture:baseline-a',
  },
  knownBlockers: [],
} as const satisfies TrustedSyntheticDebugBaselineRecord;

const trustedReview = {
  schemaVersion: '1.0',
  workflowKind: 'synthetic',
  recordKind: 'INDEPENDENT_REVIEW',
  caseId: 'synthetic-case-1',
  projectId: 'synthetic',
  sourceBoundary: 'INDEPENDENT_REVIEW_SERVICE',
  reviewId: 'synthetic-review-1',
  reviewPackageId: `review-package-${'c'.repeat(64)}`,
  candidateSha,
  disposition: 'pass',
  summary: 'The synthetic plan is bounded and supported by its fixture evidence.',
  findings: ['The proposed path and test profile are bounded.'],
  blockers: [],
  evidenceInspected: ['fixture-reproduction'],
} as const satisfies TrustedSyntheticDebugReviewRecord;

const MODEL_FORBIDDEN_FIELDS = [
  'actorId',
  'role',
  'capabilities',
  'projectGrants',
  'zone',
  'allowedZones',
  'ownerId',
  'tenantId',
  'approvalToken',
  'approvalGrant',
  'baselineOwnerVerified',
  'ownerVerified',
  'ownerVerification',
  'verifiedByActorId',
  'repositoryRoot',
  'workspacePath',
  'patch',
  'command',
  'executable',
  'args',
  'cwd',
  'env',
  'state',
  'event',
  'outcome',
  'history',
  'reviewId',
  'disposition',
] as const;

describe('synthetic debug workflow records', () => {
  it('validates and serializes every Task C record without side effects', () => {
    const records = [intake, rootCause, implementationPlan, trustedBaseline, trustedReview];

    for (const record of records) {
      const parsed = parseSyntheticDebugWorkflowRecord(record);
      expect(parsed).toEqual(record);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    }
  });

  it('keeps valid negative workflow evidence representable for later gates', () => {
    const intakeWithoutEvidence = {
      ...intake,
      evidenceReferences: [],
    };
    const unresolvedRootCause = {
      ...rootCause,
      status: 'unresolved' as const,
      confidence: 'low' as const,
      unresolvedUncertainty: ['The synthetic cause still needs reproduction.'],
    };
    const unverifiedBaseline = {
      ...trustedBaseline,
      provenance: 'regression_suite' as const,
      sourceReference: 'test-run:synthetic-check',
      ownerVerification: {
        status: 'UNVERIFIED' as const,
        evidenceReference: null,
      },
      knownBlockers: ['No explicit owner verification exists.'],
    };

    expect(parseModelSyntheticDebugRecord(intakeWithoutEvidence)).toEqual(intakeWithoutEvidence);
    expect(parseModelSyntheticDebugRecord(unresolvedRootCause)).toEqual(unresolvedRootCause);
    expect(parseTrustedSyntheticDebugBaselineRecord(unverifiedBaseline)).toEqual(
      unverifiedBaseline,
    );
  });

  it('requires exact baseline and rollback commit SHAs', () => {
    for (const invalidSha of ['', 'a'.repeat(39), 'g'.repeat(40), ` ${baselineSha}`]) {
      expect(
        trustedSyntheticDebugBaselineRecordSchema.safeParse({
          ...trustedBaseline,
          commitSha: invalidSha,
        }).success,
      ).toBe(false);
      expect(
        syntheticDebugImplementationPlanRecordSchema.safeParse({
          ...implementationPlan,
          rollbackSha: invalidSha,
        }).success,
      ).toBe(false);
    }
  });

  it('allows only trusted matching owner-verification provenance to establish verification', () => {
    for (const provenance of ['regression_suite', 'release_record', 'manual_review'] as const) {
      expect(
        trustedSyntheticDebugBaselineRecordSchema.safeParse({
          ...trustedBaseline,
          provenance,
        }).success,
        `${provenance} established owner verification`,
      ).toBe(false);
    }
    expect(
      trustedSyntheticDebugBaselineRecordSchema.safeParse({
        ...trustedBaseline,
        ownerVerification: {
          status: 'OWNER_VERIFIED',
          evidenceReference: 'different-owner-reference',
        },
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugBaselineRecordSchema.safeParse({
        ...trustedBaseline,
        provenance: 'owner_verification',
        ownerVerification: { status: 'UNVERIFIED', evidenceReference: null },
      }).success,
    ).toBe(false);
  });

  it('strictly excludes authority, execution and state fields from model records', () => {
    expect(modelSyntheticDebugRecordSchema.safeParse(intake).success).toBe(true);
    expect(modelSyntheticDebugRecordSchema.safeParse(rootCause).success).toBe(true);
    expect(modelSyntheticDebugRecordSchema.safeParse(implementationPlan).success).toBe(true);
    expect(modelSyntheticDebugRecordSchema.safeParse(trustedBaseline).success).toBe(false);
    expect(modelSyntheticDebugRecordSchema.safeParse(trustedReview).success).toBe(false);

    for (const field of MODEL_FORBIDDEN_FIELDS) {
      expect(
        modelSyntheticDebugRecordSchema.safeParse({
          ...intake,
          [field]: 'model-controlled',
        }).success,
        `model schema accepted ${field}`,
      ).toBe(false);
    }
  });

  it('keeps every record synthetic and every implementation plan proposal-only', () => {
    expect(
      modelSyntheticDebugRecordSchema.safeParse({
        ...intake,
        workflowKind: 'production',
      }).success,
    ).toBe(false);
    expect(
      syntheticDebugImplementationPlanRecordSchema.safeParse({
        ...implementationPlan,
        authority: 'APPROVED',
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugBaselineRecordSchema.safeParse({
        ...trustedBaseline,
        actorId: 'model-selected-owner',
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugReviewRecordSchema.safeParse({
        ...trustedReview,
        approvalToken: 'model-controlled',
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe or ambiguous implementation plan scope', () => {
    const invalidPlans = [
      { allowedPaths: ['../fixture.txt'] },
      { allowedPaths: ['C:/fixture.txt'] },
      { allowedPaths: ['fixture.txt', 'fixture.txt'] },
      { requiredTestProfileIds: ['synthetic-check', 'synthetic-check'] },
      { requiredTestProfileIds: ['synthetic check'] },
      { rollbackRef: '../main' },
      { proposedIsolatedBranch: 'ks-leslie/production/case-1' },
      { proposedIsolatedBranch: 'ks-leslie/synthetic/../case-1' },
    ];

    for (const invalid of invalidPlans) {
      expect(
        syntheticDebugImplementationPlanRecordSchema.safeParse({
          ...implementationPlan,
          ...invalid,
        }).success,
      ).toBe(false);
    }
  });

  it('preserves independent review blockers and rejects contradictory dispositions', () => {
    const blockedReview = {
      ...trustedReview,
      reviewId: 'synthetic-review-blocked',
      disposition: 'blocked' as const,
      summary: 'The synthetic review needs additional evidence.',
      blockers: ['Required synthetic evidence was not inspected.'],
    };
    expect(parseTrustedSyntheticDebugReviewRecord(blockedReview)).toEqual(blockedReview);

    expect(
      trustedSyntheticDebugReviewRecordSchema.safeParse({
        ...trustedReview,
        blockers: ['A blocking finding contradicts the pass disposition.'],
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugReviewRecordSchema.safeParse({
        ...blockedReview,
        blockers: [],
      }).success,
    ).toBe(false);
    expect(
      trustedSyntheticDebugReviewRecordSchema.safeParse({
        ...trustedReview,
        evidenceInspected: [],
      }).success,
    ).toBe(false);
  });

  it('parses repeated inputs deterministically without mutating them', () => {
    const input = JSON.parse(JSON.stringify(implementationPlan)) as unknown;
    const before = JSON.stringify(input);

    const first = parseModelSyntheticDebugRecord(input);
    const second = parseModelSyntheticDebugRecord(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(input)).toBe(before);
  });
});
