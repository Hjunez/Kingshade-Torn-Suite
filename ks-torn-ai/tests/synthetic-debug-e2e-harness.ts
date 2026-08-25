import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  createSyntheticDebugDiscoveryController,
  type SyntheticDebugOrchestrationResult,
  type SyntheticDebugOrchestrationSnapshot,
  type SyntheticDebugTaskDRequest,
  type SyntheticDebugTaskFRequest,
  type SyntheticDebugTaskGRequest,
  type SyntheticDebugTaskIRequest,
} from '../src/debug/orchestrator.js';
import { SyntheticDebugMemorySink } from '../src/debug/memory-integration.js';
import type {
  SyntheticDebugImplementationPlanRecord,
  SyntheticDebugIntakeRecord,
  SyntheticDebugRootCauseRecord,
  TrustedSyntheticDebugBaselineRecord,
} from '../src/debug/records.js';
import { createTrustedMemoryAccessContext } from '../src/memory/access.js';
import { MemoryService } from '../src/memory/service.js';
import { DurableMemoryStore } from '../src/memory/store.js';
import { WorkerAgentService } from '../src/worker/agent-tools.js';
import { WriteApprovalStore } from '../src/worker/approval.js';
import { WorkerPolicyRegistry } from '../src/worker/policy.js';
import { runProcess } from '../src/worker/process-runner.js';

export const E2E_SECRET = '7'.repeat(64);
export const E2E_API_SECRET = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
export const E2E_PROFILE = 'suite-layout';
export const E2E_PATH = 'fixture.txt';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const PATCH = [
  'diff --git a/fixture.txt b/fixture.txt',
  '--- a/fixture.txt',
  '+++ b/fixture.txt',
  '@@ -1 +1 @@',
  '-alpha',
  '+beta',
  '',
].join('\n');

export interface SourceState {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface E2EOptions {
  readonly caseId?: string;
  readonly approval?: 'APPROVED' | 'DENIED' | 'CANCELLED';
  readonly intake?: SyntheticDebugIntakeRecord;
  readonly rootCause?: SyntheticDebugRootCauseRecord;
  readonly plan?: (baseline: string, caseId: string) => SyntheticDebugImplementationPlanRecord;
  readonly baselineInput?: (baseline: string, caseId: string) => unknown;
  readonly repositoryCandidate?: (baseline: string) => string | null;
  readonly memoryEvidence?: (baseline: string, caseId: string) => unknown;
  readonly approvalInput?: (request: SyntheticDebugTaskFRequest) => unknown;
  readonly reviewInput?: (request: SyntheticDebugTaskIRequest) => unknown;
  readonly workerInput?: (request: SyntheticDebugTaskGRequest) => unknown;
  readonly patch?: string;
}

export class SyntheticDebugE2EHarness {
  readonly caseId!: string;
  readonly holder!: string;
  readonly root!: string;
  readonly workspaces!: string;
  readonly memoryDirectory!: string;
  readonly baseline!: string;
  readonly store!: DurableMemoryStore;
  readonly memory!: MemoryService;
  readonly sink!: SyntheticDebugMemorySink;
  readonly controller!: ReturnType<typeof createSyntheticDebugDiscoveryController>;
  readonly options!: E2EOptions;
  workerCalls = 0;
  reviewCalls = 0;
  memoryCalls = 0;
  workerRequests: SyntheticDebugTaskGRequest[] = [];

  private constructor(input: {
    caseId: string;
    holder: string;
    root: string;
    workspaces: string;
    memoryDirectory: string;
    baseline: string;
    store: DurableMemoryStore;
    memory: MemoryService;
    sink: SyntheticDebugMemorySink;
    controller: ReturnType<typeof createSyntheticDebugDiscoveryController>;
    options: E2EOptions;
  }) {
    Object.assign(this, input);
  }

  static async create(options: E2EOptions = {}): Promise<SyntheticDebugE2EHarness> {
    const caseId = options.caseId ?? 'c3-11-happy';
    const holder = await mkdtemp(join(tmpdir(), 'ks-leslie-c3-11-'));
    const root = join(holder, 'source');
    const workspaces = join(holder, 'workspaces');
    const memoryDirectory = join(holder, 'memory');
    await mkdir(join(root, 'tools'), { recursive: true });
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'c3-11@example.invalid']);
    await git(root, ['config', 'user.name', 'KS Leslie C3.11']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await writeFile(join(root, E2E_PATH), 'alpha\n', 'utf8');
    await writeFile(join(root, 'tracked-owner.txt'), 'clean\n', 'utf8');
    await writeFile(
      join(root, 'tools', 'run-suite-validator.mjs'),
      "import { readFileSync } from 'node:fs';\nif (readFileSync('fixture.txt', 'utf8') !== 'beta\\n') process.exit(9);\n",
      'utf8',
    );
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'synthetic owner-verified baseline']);
    const baseline = await git(root, ['rev-parse', 'HEAD']);
    await writeFile(join(root, 'tracked-owner.txt'), 'owner dirty bytes\n', 'utf8');
    await writeFile(join(root, 'untracked-owner.txt'), 'owner untracked bytes\n', 'utf8');

    await mkdir(memoryDirectory, { recursive: true });
    let event = 0;
    const store = new DurableMemoryStore(memoryDirectory, {
      now: () => NOW,
      eventIdFactory: () => `c3-11-event-${String(++event)}`,
    });
    const memory = new MemoryService(store, { now: () => NOW });
    const access = createTrustedMemoryAccessContext({
      actorId: 'trusted-c3-11-harness',
      role: 'OWNER_DEVELOPER',
      capabilities: ['MEMORY_READ', 'MEMORY_INGEST'],
      projectGrants: ['synthetic'],
      allowedZones: ['PRIVATE_KINGSHADE_DEV'],
      tenantGrants: [],
    });
    const sink = new SyntheticDebugMemorySink(memory, access, 'synthetic');

    const harnessRef: { current?: SyntheticDebugE2EHarness } = {};
    const controller = createSyntheticDebugDiscoveryController({
      taskD: {
        authorize: () => true,
        readRepositoryDiscovery: (request: SyntheticDebugTaskDRequest) => {
          const candidate =
            options.repositoryCandidate === undefined
              ? baseline
              : options.repositoryCandidate(baseline);
          return {
            currentCandidate:
              candidate === null
                ? null
                : {
                    commitSha: candidate,
                    observedAt: '2026-08-25T10:00:00.000Z',
                    sourceReference: `repository:${request.caseId}:current`,
                  },
            baselineEvidence: [],
          };
        },
        readAuthorizedMemoryEvidence: () =>
          options.memoryEvidence?.(baseline, caseId) ?? {
            authorizationAppliedBeforeRanking: true,
            baselineEvidence: [ownerEvidence(baseline, caseId)],
          },
        readTrustedBaseline: () =>
          options.baselineInput?.(baseline, caseId) ?? trustedBaseline(baseline, caseId),
      },
      taskF: {
        readTrustedWriteApprovalDecision: (request) =>
          options.approvalInput?.(request) ?? approval(request, options.approval ?? 'APPROVED'),
      },
      taskG: {
        executeApprovedSyntheticImplementation: async (request) => {
          const harness = harnessRef.current;
          if (harness === undefined) throw new Error('E2E harness is not initialized');
          harness.workerCalls += 1;
          harness.workerRequests.push(request);
          if (options.workerInput !== undefined) return await options.workerInput(request);
          return await harness.executeWorker(request, options.patch ?? PATCH);
        },
      },
      taskI: {
        reviewVerifiedSyntheticCandidate: (request) => {
          const harness = harnessRef.current;
          if (harness === undefined) throw new Error('E2E harness is not initialized');
          harness.reviewCalls += 1;
          return options.reviewInput === undefined
            ? passingReview(request)
            : options.reviewInput(request);
        },
      },
    });
    const harness = new SyntheticDebugE2EHarness({
      caseId,
      holder,
      root,
      workspaces,
      memoryDirectory,
      baseline,
      store,
      memory,
      sink,
      controller,
      options,
    });
    harnessRef.current = harness;
    return harness;
  }

  async cleanup(): Promise<void> {
    await rm(this.holder, { recursive: true, force: true });
  }

  intake(): SyntheticDebugIntakeRecord {
    return this.options.intake ?? intake(this.caseId);
  }

  rootCause(): SyntheticDebugRootCauseRecord {
    return this.options.rootCause ?? rootCause(this.caseId);
  }

  plan(): SyntheticDebugImplementationPlanRecord {
    return this.options.plan?.(this.baseline, this.caseId) ?? plan(this.baseline, this.caseId);
  }

  async sourceState(): Promise<SourceState> {
    return {
      head: await git(this.root, ['rev-parse', 'HEAD']),
      branch: await git(this.root, ['branch', '--show-current']),
      status: await git(this.root, ['status', '--porcelain=v1', '--untracked-files=all']),
      files: await hashes(this.root),
    };
  }

  async driveToPending(): Promise<SyntheticDebugOrchestrationResult> {
    const created = this.controller.createCase(this.intake());
    if (!created.ok) throw new Error(created.error.message);
    const started = this.controller.startDiscovery(created.snapshot);
    if (!started.ok) return started;
    const discovered = await this.controller.completeDiscovery(started.snapshot);
    if (!discovered.ok || discovered.status !== 'ADVANCED') return discovered;
    const baseline = await this.controller.resolveTrustedBaseline(discovered.snapshot);
    if (!baseline.ok || baseline.status !== 'ADVANCED') return baseline;
    const recorded = this.controller.recordEvidenceAndRootCause(
      baseline.snapshot,
      this.rootCause(),
    );
    if (!recorded.ok || recorded.status !== 'ADVANCED') return recorded;
    const gated = this.controller.evaluateImplementationGate(recorded.snapshot);
    if (!gated.ok || gated.status !== 'ADVANCED') return gated;
    return this.controller.requestWriteApproval(gated.snapshot, this.plan());
  }

  async driveToExecuted(): Promise<SyntheticDebugOrchestrationResult> {
    const pending = await this.driveToPending();
    if (!pending.ok || pending.status !== 'ADVANCED') return pending;
    const approved = await this.controller.resolveWriteApproval(pending.snapshot);
    if (!approved.ok || approved.status !== 'ADVANCED') return approved;
    return await this.controller.executeApprovedImplementation(approved.snapshot);
  }

  async driveToFinal(): Promise<SyntheticDebugOrchestrationResult> {
    const executed = await this.driveToExecuted();
    if (!executed.ok || executed.status !== 'ADVANCED') return executed;
    const verified = await this.controller.evaluateVerification(executed.snapshot);
    if (!verified.ok || verified.status !== 'ADVANCED') return verified;
    const reviewed = await this.controller.evaluateIndependentReview(verified.snapshot);
    if (!reviewed.ok || reviewed.status !== 'ADVANCED') return reviewed;
    return await this.controller.evaluateFinalDelivery(reviewed.snapshot);
  }

  async persist(snapshot: SyntheticDebugOrchestrationSnapshot) {
    this.memoryCalls += 1;
    const report = snapshot.finalDelivery;
    return await this.sink.persist({
      schemaVersion: '1.0',
      workflowKind: 'synthetic',
      caseId: snapshot.caseId,
      projectId: snapshot.projectId,
      finalDisposition: report?.status ?? 'BLOCKED',
      baselineSha: report?.baselineSha ?? snapshot.knownGoodBaseline?.commitSha ?? null,
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
        .flatMap(({ reasons }) => reasons.map((reason) => reason.code))
        .filter(() => snapshot.machine.state !== 'TEST_READY'),
    });
  }

  private async executeWorker(request: SyntheticDebugTaskGRequest, patch: string) {
    const service = new WorkerAgentService({
      policies: new WorkerPolicyRegistry([
        {
          projectId: 'synthetic',
          repositoryRoot: this.root,
          readablePaths: [E2E_PATH, 'tools/run-suite-validator.mjs'],
          writablePaths: [E2E_PATH],
          allowedTestProfileIds: [E2E_PROFILE],
          requiredWriteTestProfileIds: [E2E_PROFILE],
          branchPrefix: 'ks-leslie/synthetic/',
        },
      ]),
      approvals: new WriteApprovalStore({ now: () => NOW, tokenFactory: () => E2E_SECRET }),
      workspaceBaseDir: this.workspaces,
      jobIdFactory: () => `worker-${this.caseId}`,
      now: () => NOW,
    });
    await service.issueWriteApproval({
      projectId: request.projectId,
      baselineSha: request.proposal.baselineSha,
      baselineOwnerVerified: true,
      problemEvidenceItems: 1,
      rootCauseRecorded: true,
      branch: request.proposal.proposedIsolatedBranch,
      allowedPaths: request.proposal.approvedPaths,
      patchId: request.proposal.proposalId,
      patch,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    return await service.applyApprovedPatch({ projectId: request.projectId });
  }
}

export function intake(caseId: string): SyntheticDebugIntakeRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INTAKE',
    caseId,
    projectId: 'synthetic',
    problem: 'The synthetic fixture contains alpha instead of beta.',
    affectedSurfaces: ['synthetic fixture'],
    evidenceReferences: [
      {
        evidenceId: `reproduction-${caseId}`,
        kind: 'SYNTHETIC_FIXTURE',
        reference: `fixture:${caseId}:alpha`,
      },
    ],
  };
}

export function rootCause(caseId: string): SyntheticDebugRootCauseRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'ROOT_CAUSE',
    caseId,
    projectId: 'synthetic',
    rootCauseId: `root-cause-${caseId}`,
    explanation: 'The bounded fixture retained its deterministic old value.',
    evidenceReferences: [`reproduction-${caseId}`],
    status: 'verified',
    confidence: 'high',
    unresolvedUncertainty: [],
  };
}

export function plan(baseline: string, caseId: string): SyntheticDebugImplementationPlanRecord {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'IMPLEMENTATION_PLAN',
    caseId,
    projectId: 'synthetic',
    planId: `plan-${caseId}`,
    authority: 'PROPOSAL_ONLY',
    allowedPaths: [E2E_PATH],
    requiredTestProfileIds: [E2E_PROFILE],
    boundedChangeSummary: 'Change only fixture.txt from alpha to beta.',
    rollbackSha: baseline,
    rollbackRef: baseline,
    proposedIsolatedBranch: `ks-leslie/synthetic/${caseId}`,
    proposedWorkspaceId: `workspace-${caseId}`,
  };
}

function trustedBaseline(baseline: string, caseId: string): TrustedSyntheticDebugBaselineRecord {
  const sourceReference = `owner:${caseId}:baseline`;
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'BASELINE',
    caseId,
    projectId: 'synthetic',
    sourceBoundary: 'TRUSTED_APPLICATION',
    commitSha: baseline,
    provenance: 'owner_verification',
    sourceReference,
    ownerVerification: { status: 'OWNER_VERIFIED', evidenceReference: sourceReference },
    knownBlockers: [],
  };
}

function ownerEvidence(baseline: string, caseId: string) {
  return {
    sourceReference: `owner:${caseId}:baseline`,
    evidence: {
      project: 'synthetic',
      commitSha: baseline,
      state: 'verified_good',
      source: 'owner_verification',
      observedAt: '2026-08-25T09:00:00.000Z',
    },
  };
}

function approval(
  request: SyntheticDebugTaskFRequest,
  decision: 'APPROVED' | 'DENIED' | 'CANCELLED',
) {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'WRITE_APPROVAL_DECISION',
    sourceBoundary: 'TRUSTED_APPLICATION',
    caseId: request.caseId,
    projectId: request.projectId,
    proposalId: request.proposal.proposalId,
    decisionReferenceId: `approval-decision-${request.caseId}`,
    decision,
  };
}

export function passingReview(request: SyntheticDebugTaskIRequest) {
  return {
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    recordKind: 'INDEPENDENT_REVIEW',
    sourceBoundary: 'INDEPENDENT_REVIEW_SERVICE',
    caseId: request.reviewPackage.caseId,
    projectId: request.reviewPackage.projectId,
    reviewId: `review-${request.reviewPackage.caseId}`,
    reviewPackageId: request.reviewPackage.reviewPackageId,
    candidateSha: request.reviewPackage.candidateSha,
    disposition: 'pass',
    summary: 'Independent review passed the bounded synthetic candidate.',
    findings: ['All trusted evidence is consistent.'],
    blockers: [],
    evidenceInspected: [...request.reviewPackage.evidenceReferences],
  };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await runProcess({ executable: 'git', args, cwd: root, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function hashes(root: string): Promise<Readonly<Record<string, string>>> {
  const output: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (directory === root && entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile())
        output[relative(root, absolute).replaceAll('\\', '/')] = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
    }
  }
  await visit(root);
  return output;
}
