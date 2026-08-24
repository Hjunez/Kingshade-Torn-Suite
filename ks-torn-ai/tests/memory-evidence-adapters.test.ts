import { describe, expect, it } from 'vitest';

import { baselineEvidenceToMemoryDraft } from '../src/memory/evidence-adapters.js';
import type { BaselineEvidence } from '../src/repository/baseline.js';

describe('durable-memory baseline evidence adapter', () => {
  it('keeps release and automated evidence supporting-only', () => {
    const release: BaselineEvidence = {
      project: 'war-dibs',
      commitSha: 'candidate',
      state: 'candidate',
      source: 'release_record',
      observedAt: '2026-08-24T00:00:00.000Z',
    };
    const testRun: BaselineEvidence = {
      ...release,
      source: 'regression_suite',
    };

    expect(baselineEvidenceToMemoryDraft(release)).toMatchObject({
      kind: 'BASELINE_EVIDENCE',
      evidenceClassification: 'RELEASE_RECORD',
      verificationState: 'SUPPORTING',
    });
    expect(baselineEvidenceToMemoryDraft(testRun)).toMatchObject({
      evidenceClassification: 'AUTOMATED_TEST',
      verificationState: 'SUPPORTING',
    });
  });

  it('preserves owner verification as evidence that still requires trusted write authority', () => {
    const owner: BaselineEvidence = {
      project: 'war-dibs',
      commitSha: 'known-good',
      state: 'verified_good',
      source: 'owner_verification',
      observedAt: '2026-08-24T00:00:00.000Z',
    };

    expect(baselineEvidenceToMemoryDraft(owner)).toMatchObject({
      evidenceClassification: 'OWNER_VERIFIED',
      verificationState: 'OWNER_VERIFIED',
      source: { kind: 'OWNER_ARTIFACT' },
    });
  });

  it('maps failure evidence without replacing or selecting a baseline', () => {
    const failed: BaselineEvidence = {
      project: 'war-dibs',
      commitSha: 'candidate',
      state: 'failed',
      source: 'regression_suite',
      observedAt: '2026-08-24T00:00:00.000Z',
    };

    expect(baselineEvidenceToMemoryDraft(failed)).toMatchObject({
      kind: 'FAILED_CANDIDATE',
      evidenceClassification: 'AUTOMATED_TEST',
      verificationState: 'SUPPORTING',
    });
  });
});
