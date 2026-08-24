import { createHash } from 'node:crypto';

import type { BaselineEvidence } from '../repository/baseline.js';
import { trustedMemoryDraftSchema, type TrustedMemoryDraft } from './service.js';

function stableEvidenceRecordId(evidence: BaselineEvidence): string {
  const digest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 32);
  return `baseline-${digest}`;
}

export function baselineEvidenceToMemoryDraft(evidence: BaselineEvidence): TrustedMemoryDraft {
  const evidenceClassification =
    evidence.source === 'owner_verification'
      ? ('OWNER_VERIFIED' as const)
      : evidence.source === 'regression_suite'
        ? ('AUTOMATED_TEST' as const)
        : evidence.source === 'release_record'
          ? ('RELEASE_RECORD' as const)
          : ('COMMUNITY_DERIVED' as const);
  const verificationState =
    evidence.source === 'owner_verification'
      ? ('OWNER_VERIFIED' as const)
      : ('SUPPORTING' as const);
  const kind = evidence.state === 'failed' ? ('FAILED_CANDIDATE' as const) : 'BASELINE_EVIDENCE';
  const sourceKind =
    evidence.source === 'owner_verification'
      ? ('OWNER_ARTIFACT' as const)
      : evidence.source === 'regression_suite'
        ? ('TEST_RUN' as const)
        : evidence.source === 'release_record'
          ? ('RELEASE_RECORD' as const)
          : ('TRUSTED_APPLICATION' as const);

  return trustedMemoryDraftSchema.parse({
    id: stableEvidenceRecordId(evidence),
    projectId: evidence.project,
    kind,
    zone: 'PRIVATE_KINGSHADE_DEV',
    subject: `Baseline evidence for ${evidence.commitSha}`,
    content: [
      `Commit ${evidence.commitSha} was observed as ${evidence.state}.`,
      ...(evidence.version === undefined ? [] : [`Version: ${evidence.version}.`]),
      ...(evidence.note === undefined ? [] : [`Note: ${evidence.note}`]),
    ].join(' '),
    evidenceClassification,
    source: {
      kind: sourceKind,
      reference: `baseline:${evidence.project}:${evidence.commitSha}`,
      description: `${evidence.source} observed at ${evidence.observedAt}`,
    },
    verificationState,
  });
}
