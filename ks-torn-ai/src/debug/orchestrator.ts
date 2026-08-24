import { z } from 'zod';

import { selectKnownGoodBaseline, type BaselineEvidence } from '../repository/baseline.js';
import { isFullCommitSha } from './gates.js';
import {
  parseModelSyntheticDebugRecord,
  parseTrustedSyntheticDebugBaselineRecord,
  type SyntheticDebugIntakeRecord,
  type TrustedSyntheticDebugBaselineRecord,
} from './records.js';
import {
  createSyntheticDebugMachine,
  isSyntheticDebugTerminalState,
  transitionSyntheticDebugMachine,
  type SyntheticDebugEvent,
  type SyntheticDebugMachineSnapshot,
  type SyntheticDebugState,
  type SyntheticDebugTransitionReason,
  type SyntheticDebugTransitionRecord,
} from './state-machine.js';

const MAX_DISCOVERY_EVIDENCE = 200;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const exactCommitShaSchema = z
  .string()
  .refine((value) => isFullCommitSha(value), 'Expected an exact 40-character commit SHA')
  .transform((value) => value.toLowerCase());

const canonicalTimestampSchema = z.string().refine((value) => {
  if (!CANONICAL_UTC_TIMESTAMP.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}, 'Expected a canonical UTC timestamp');

const sourceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !value.includes('\0'), 'Reference cannot contain NUL');

const baselineEvidenceSchema = z
  .object({
    project: z.string().trim().min(1).max(80),
    commitSha: exactCommitShaSchema,
    version: z.string().trim().min(1).max(128).optional(),
    state: z.enum(['verified_good', 'failed', 'candidate', 'unknown']),
    source: z.enum(['owner_verification', 'regression_suite', 'release_record', 'manual_review']),
    observedAt: canonicalTimestampSchema,
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const observationSchema = z
  .object({
    sourceReference: sourceReferenceSchema,
    evidence: baselineEvidenceSchema,
  })
  .strict();

const currentCandidateSchema = z
  .object({
    commitSha: exactCommitShaSchema,
    observedAt: canonicalTimestampSchema,
    sourceReference: sourceReferenceSchema,
  })
  .strict();

const repositoryDiscoverySchema = z
  .object({
    currentCandidate: currentCandidateSchema.nullable(),
    baselineEvidence: z.array(observationSchema).max(MAX_DISCOVERY_EVIDENCE),
  })
  .strict()
  .superRefine((result, context) => {
    for (const [index, observation] of result.baselineEvidence.entries()) {
      if (observation.evidence.source === 'owner_verification') {
        context.addIssue({
          code: 'custom',
          path: ['baselineEvidence', index, 'evidence', 'source'],
          message: 'Repository evidence cannot establish owner verification',
        });
      }
    }
  });

const authorizedMemoryDiscoverySchema = z
  .object({
    authorizationAppliedBeforeRanking: z.literal(true),
    baselineEvidence: z.array(observationSchema).max(MAX_DISCOVERY_EVIDENCE),
  })
  .strict();

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type DiscoveryObservation = DeepReadonly<
  z.infer<typeof observationSchema> & {
    origin: 'REPOSITORY_INTELLIGENCE' | 'AUTHORIZED_MEMORY';
  }
>;

export type SyntheticDebugTaskDOperation = 'READ_ONLY_DISCOVERY' | 'RESOLVE_TRUSTED_BASELINE';

export interface SyntheticDebugTaskDRequest {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly accessMode: 'READ_ONLY';
  readonly operation: SyntheticDebugTaskDOperation;
  readonly caseId: string;
  readonly projectId: string;
}

export interface SyntheticDebugTaskDCapability {
  readonly authorize: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readRepositoryDiscovery: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readAuthorizedMemoryEvidence: (request: SyntheticDebugTaskDRequest) => unknown;
  readonly readTrustedBaseline: (request: SyntheticDebugTaskDRequest) => unknown;
}

export interface SyntheticDebugOrchestratorDependencies {
  readonly taskD?: SyntheticDebugTaskDCapability;
}

export interface SyntheticDebugCurrentCandidate {
  readonly commitSha: string;
  readonly observedAt: string;
  readonly sourceReference: string;
  readonly confidence: 'CANDIDATE' | 'INVALIDATED';
  readonly invalidatedBy: readonly string[];
}

export interface SyntheticDebugKnownGoodResolution {
  readonly status: 'RESOLVED' | 'MISSING' | 'CONFLICT';
  readonly commitSha: string | null;
  readonly sourceReferences: readonly string[];
  readonly conflictingCommitShas: readonly string[];
  readonly consideredCommits: number;
}

export interface SyntheticDebugDiscoverySummary {
  readonly currentCandidate: SyntheticDebugCurrentCandidate | null;
  readonly baselineEvidence: readonly DiscoveryObservation[];
  readonly knownGoodResolution: SyntheticDebugKnownGoodResolution;
}

export interface SyntheticDebugOrchestrationSnapshot {
  readonly schemaVersion: '1.0';
  readonly workflowKind: 'synthetic';
  readonly caseId: string;
  readonly projectId: string;
  readonly machine: SyntheticDebugMachineSnapshot;
  readonly intake: DeepReadonly<SyntheticDebugIntakeRecord>;
  readonly discovery: SyntheticDebugDiscoverySummary | null;
  readonly knownGoodBaseline: DeepReadonly<TrustedSyntheticDebugBaselineRecord> | null;
}

export type SyntheticDebugOrchestrationOperation =
  | 'CREATE_CASE'
  | 'START_DISCOVERY'
  | 'COMPLETE_DISCOVERY'
  | 'RESOLVE_TRUSTED_BASELINE';

export type SyntheticDebugOrchestrationErrorCode =
  | 'MALFORMED_MODEL_RECORD'
  | 'UNSUPPORTED_RECORD_KIND'
  | 'OUT_OF_ORDER'
  | 'TERMINAL_STATE'
  | 'TRANSITION_REJECTED';

export interface SyntheticDebugOrchestrationError {
  readonly code: SyntheticDebugOrchestrationErrorCode;
  readonly operation: SyntheticDebugOrchestrationOperation;
  readonly message: string;
  readonly state: SyntheticDebugState | null;
}

export type SyntheticDebugOrchestrationCreateResult =
  | {
      readonly ok: true;
      readonly status: 'CREATED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
    }
  | {
      readonly ok: false;
      readonly status: 'REJECTED';
      readonly error: SyntheticDebugOrchestrationError;
    };

export type SyntheticDebugOrchestrationResult =
  | {
      readonly ok: true;
      readonly status: 'ADVANCED' | 'BLOCKED' | 'FAILED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
      readonly transition: SyntheticDebugTransitionRecord;
    }
  | {
      readonly ok: false;
      readonly status: 'REJECTED';
      readonly snapshot: SyntheticDebugOrchestrationSnapshot;
      readonly error: SyntheticDebugOrchestrationError;
    };

export interface SyntheticDebugDiscoveryController {
  createCase(input: unknown): SyntheticDebugOrchestrationCreateResult;
  startDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot): SyntheticDebugOrchestrationResult;
  completeDiscovery(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
  resolveTrustedBaseline(
    snapshot: SyntheticDebugOrchestrationSnapshot,
  ): Promise<SyntheticDebugOrchestrationResult>;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function error(
  code: SyntheticDebugOrchestrationErrorCode,
  operation: SyntheticDebugOrchestrationOperation,
  message: string,
  state: SyntheticDebugState | null,
): SyntheticDebugOrchestrationError {
  return Object.freeze({ code, operation, message, state });
}

function reject(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  code: SyntheticDebugOrchestrationErrorCode,
  message: string,
): SyntheticDebugOrchestrationResult {
  return Object.freeze({
    ok: false,
    status: 'REJECTED',
    snapshot,
    error: error(code, operation, message, snapshot.machine.state),
  });
}

function requireState(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  expected: SyntheticDebugState,
): SyntheticDebugOrchestrationResult | null {
  if (isSyntheticDebugTerminalState(snapshot.machine.state)) {
    return reject(
      snapshot,
      operation,
      'TERMINAL_STATE',
      `State ${snapshot.machine.state} is terminal`,
    );
  }
  if (snapshot.machine.state !== expected) {
    return reject(
      snapshot,
      operation,
      'OUT_OF_ORDER',
      `${operation} requires state ${expected}; current state is ${snapshot.machine.state}`,
    );
  }
  return null;
}

function apply(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  event: SyntheticDebugEvent,
  reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
  status: 'ADVANCED' | 'BLOCKED' | 'FAILED',
  patch: Partial<Pick<SyntheticDebugOrchestrationSnapshot, 'discovery' | 'knownGoodBaseline'>> = {},
): SyntheticDebugOrchestrationResult {
  const transitioned = transitionSyntheticDebugMachine(snapshot.machine, { event, reasons });
  if (!transitioned.ok) {
    return reject(
      snapshot,
      operation,
      'TRANSITION_REJECTED',
      `State machine rejected ${event}: ${transitioned.error.code}`,
    );
  }
  const next = deepFreeze({ ...snapshot, ...patch, machine: transitioned.snapshot });
  return Object.freeze({ ok: true, status, snapshot: next, transition: transitioned.transition });
}

function block(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  reasons: readonly [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
): SyntheticDebugOrchestrationResult {
  return apply(snapshot, operation, 'BLOCK', reasons, 'BLOCKED');
}

function fail(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugOrchestrationOperation,
  code: string,
  summary: string,
): SyntheticDebugOrchestrationResult {
  return apply(snapshot, operation, 'FAIL', [{ code, summary }], 'FAILED');
}

function request(
  snapshot: SyntheticDebugOrchestrationSnapshot,
  operation: SyntheticDebugTaskDOperation,
): SyntheticDebugTaskDRequest {
  return Object.freeze({
    schemaVersion: '1.0',
    workflowKind: 'synthetic',
    accessMode: 'READ_ONLY',
    operation,
    caseId: snapshot.caseId,
    projectId: snapshot.projectId,
  });
}

async function authorize(
  capability: SyntheticDebugTaskDCapability,
  operationRequest: SyntheticDebugTaskDRequest,
): Promise<'ALLOWED' | 'DENIED' | 'ERROR'> {
  try {
    const decision = await capability.authorize(operationRequest);
    return typeof decision === 'boolean' ? (decision ? 'ALLOWED' : 'DENIED') : 'ERROR';
  } catch {
    return 'ERROR';
  }
}

function candidateSummary(
  candidate: z.infer<typeof currentCandidateSchema> | null,
  observations: readonly DiscoveryObservation[],
): SyntheticDebugCurrentCandidate | null {
  if (candidate === null) return null;
  const candidateTime = Date.parse(candidate.observedAt);
  const invalidatedBy = observations
    .filter(
      ({ evidence }) =>
        evidence.commitSha === candidate.commitSha &&
        evidence.state === 'failed' &&
        Date.parse(evidence.observedAt) > candidateTime,
    )
    .map(({ sourceReference }) => sourceReference)
    .filter((reference, index, references) => references.indexOf(reference) === index)
    .sort();
  return deepFreeze({
    ...candidate,
    confidence: invalidatedBy.length > 0 ? ('INVALIDATED' as const) : ('CANDIDATE' as const),
    invalidatedBy,
  });
}

function knownGoodSummary(
  observations: readonly DiscoveryObservation[],
  projectId: string,
): SyntheticDebugKnownGoodResolution {
  const evidence: BaselineEvidence[] = observations.map(({ evidence: item }) => ({
    project: item.project,
    commitSha: item.commitSha,
    state: item.state,
    source: item.source,
    observedAt: item.observedAt,
    ...(item.version === undefined ? {} : { version: item.version }),
    ...(item.note === undefined ? {} : { note: item.note }),
  }));
  const decision = selectKnownGoodBaseline(evidence, projectId);
  const activeOwnerShas = decision.assessments
    .filter(({ eligible, ownerVerification }) => eligible && ownerVerification !== undefined)
    .map(({ commitSha }) => commitSha)
    .filter((sha, index, shas) => shas.indexOf(sha) === index)
    .sort();

  if (activeOwnerShas.length > 1) {
    return deepFreeze({
      status: 'CONFLICT' as const,
      commitSha: null,
      sourceReferences: [],
      conflictingCommitShas: activeOwnerShas,
      consideredCommits: decision.consideredCommits,
    });
  }
  if (decision.baseline === null) {
    return deepFreeze({
      status: 'MISSING' as const,
      commitSha: null,
      sourceReferences: [],
      conflictingCommitShas: [],
      consideredCommits: decision.consideredCommits,
    });
  }

  const selected = decision.baseline;
  const sourceReferences = observations
    .filter(
      ({ evidence }) =>
        evidence.commitSha === selected.commitSha &&
        evidence.source === selected.source &&
        evidence.state === selected.state &&
        evidence.observedAt === selected.observedAt,
    )
    .map(({ sourceReference }) => sourceReference)
    .filter((reference, index, references) => references.indexOf(reference) === index)
    .sort();
  return deepFreeze({
    status: 'RESOLVED' as const,
    commitSha: selected.commitSha,
    sourceReferences,
    conflictingCommitShas: [],
    consideredCommits: decision.consideredCommits,
  });
}

function discoverySummary(
  projectId: string,
  repository: z.infer<typeof repositoryDiscoverySchema>,
  memory: z.infer<typeof authorizedMemoryDiscoverySchema>,
): SyntheticDebugDiscoverySummary | null {
  const observations: DiscoveryObservation[] = [
    ...repository.baselineEvidence.map((observation) =>
      deepFreeze({ ...observation, origin: 'REPOSITORY_INTELLIGENCE' as const }),
    ),
    ...memory.baselineEvidence.map((observation) =>
      deepFreeze({ ...observation, origin: 'AUTHORIZED_MEMORY' as const }),
    ),
  ];
  if (observations.some(({ evidence }) => evidence.project !== projectId)) return null;
  return deepFreeze({
    currentCandidate: candidateSummary(repository.currentCandidate, observations),
    baselineEvidence: observations,
    knownGoodResolution: knownGoodSummary(observations, projectId),
  });
}

function baselineBlockers(
  discovery: SyntheticDebugDiscoverySummary,
  baseline: TrustedSyntheticDebugBaselineRecord | null,
): SyntheticDebugTransitionReason[] {
  const resolution = discovery.knownGoodResolution;
  const blockers: SyntheticDebugTransitionReason[] = [];
  if (resolution.status === 'CONFLICT') {
    blockers.push({
      code: 'CONTRADICTORY_OWNER_VERIFIED_BASELINES',
      summary: `Conflicting owner-verified baseline SHAs: ${resolution.conflictingCommitShas.join(', ')}.`,
    });
  } else if (resolution.status === 'MISSING') {
    blockers.push({
      code: 'OWNER_VERIFIED_BASELINE_MISSING',
      summary: 'No exact owner-verified known-good baseline is available.',
    });
  }
  if (baseline === null) {
    if (!blockers.some(({ code }) => code === 'OWNER_VERIFIED_BASELINE_MISSING')) {
      blockers.push({
        code: 'OWNER_VERIFIED_BASELINE_MISSING',
        summary: 'The trusted application did not supply a baseline record.',
      });
    }
    return blockers;
  }
  if (baseline.ownerVerification.status !== 'OWNER_VERIFIED') {
    blockers.push({
      code: 'BASELINE_NOT_OWNER_VERIFIED',
      summary: 'The supplied baseline does not carry trusted owner verification.',
    });
  }
  if (resolution.status === 'RESOLVED') {
    if (baseline.commitSha.toLowerCase() !== resolution.commitSha) {
      blockers.push({
        code: 'BASELINE_DOES_NOT_MATCH_DISCOVERY',
        summary: 'The supplied baseline SHA does not match the read-only discovery result.',
      });
    }
    if (!resolution.sourceReferences.includes(baseline.sourceReference)) {
      blockers.push({
        code: 'BASELINE_PROVENANCE_DOES_NOT_MATCH_DISCOVERY',
        summary:
          'The supplied owner-verification reference was not present in authorized evidence.',
      });
    }
  }
  blockers.push(
    ...baseline.knownBlockers.map((summary) => ({ code: 'BASELINE_KNOWN_BLOCKER', summary })),
  );
  return blockers;
}

export function createSyntheticDebugDiscoveryController(
  dependencies: SyntheticDebugOrchestratorDependencies = {},
): SyntheticDebugDiscoveryController {
  const capability = dependencies.taskD;
  return Object.freeze({
    createCase(input: unknown): SyntheticDebugOrchestrationCreateResult {
      let parsed;
      try {
        parsed = parseModelSyntheticDebugRecord(input);
      } catch {
        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          error: error(
            'MALFORMED_MODEL_RECORD',
            'CREATE_CASE',
            'Expected a strict model-safe synthetic debug record',
            null,
          ),
        });
      }
      if (parsed.recordKind !== 'INTAKE') {
        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          error: error(
            'UNSUPPORTED_RECORD_KIND',
            'CREATE_CASE',
            `Record kind ${parsed.recordKind} is not accepted at case creation`,
            null,
          ),
        });
      }
      const intake = deepFreeze(parsed);
      return Object.freeze({
        ok: true,
        status: 'CREATED',
        snapshot: deepFreeze({
          schemaVersion: '1.0' as const,
          workflowKind: 'synthetic' as const,
          caseId: intake.caseId,
          projectId: intake.projectId,
          machine: createSyntheticDebugMachine(),
          intake,
          discovery: null,
          knownGoodBaseline: null,
        }),
      });
    },

    startDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'START_DISCOVERY', 'INTAKE');
      if (invalid !== null) return invalid;
      return apply(
        snapshot,
        'START_DISCOVERY',
        'START_DISCOVERY',
        [{ code: 'INTAKE_ACCEPTED', summary: 'The model-safe synthetic intake was accepted.' }],
        'ADVANCED',
      );
    },

    async completeDiscovery(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'COMPLETE_DISCOVERY', 'DISCOVERY');
      if (invalid !== null) return invalid;
      if (capability === undefined) {
        return block(snapshot, 'COMPLETE_DISCOVERY', [
          {
            code: 'READ_ONLY_DISCOVERY_CAPABILITY_MISSING',
            summary: 'The trusted read-only Task D capability was not injected.',
          },
        ]);
      }

      const operationRequest = request(snapshot, 'READ_ONLY_DISCOVERY');
      const authorization = await authorize(capability, operationRequest);
      if (authorization === 'ERROR') {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'DISCOVERY_AUTHORIZATION_ERROR',
          'The injected Task D capability returned an invalid authorization result.',
        );
      }
      if (authorization === 'DENIED') {
        return block(snapshot, 'COMPLETE_DISCOVERY', [
          {
            code: 'DISCOVERY_AUTHORIZATION_DENIED',
            summary: 'Read-only synthetic discovery was not authorized.',
          },
        ]);
      }

      let repositoryInput: unknown;
      let memoryInput: unknown;
      try {
        repositoryInput = await capability.readRepositoryDiscovery(operationRequest);
        memoryInput = await capability.readAuthorizedMemoryEvidence(operationRequest);
      } catch {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'DISCOVERY_DEPENDENCY_ERROR',
          'The injected read-only Task D capability failed.',
        );
      }
      const repository = repositoryDiscoverySchema.safeParse(repositoryInput);
      const memory = authorizedMemoryDiscoverySchema.safeParse(memoryInput);
      if (!repository.success || !memory.success) {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'MALFORMED_DISCOVERY_RESULT',
          'The injected read-only Task D capability returned invalid data.',
        );
      }
      const discovery = discoverySummary(snapshot.projectId, repository.data, memory.data);
      if (discovery === null) {
        return fail(
          snapshot,
          'COMPLETE_DISCOVERY',
          'CROSS_PROJECT_DISCOVERY_EVIDENCE',
          'Read-only discovery returned evidence outside the requested project.',
        );
      }
      return apply(
        snapshot,
        'COMPLETE_DISCOVERY',
        'MARK_EVIDENCE_READY',
        [
          {
            code: 'READ_ONLY_DISCOVERY_COMPLETED',
            summary: 'Repository and pre-authorized memory discovery completed read-only.',
          },
        ],
        'ADVANCED',
        { discovery },
      );
    },

    async resolveTrustedBaseline(snapshot: SyntheticDebugOrchestrationSnapshot) {
      const invalid = requireState(snapshot, 'RESOLVE_TRUSTED_BASELINE', 'EVIDENCE_READY');
      if (invalid !== null) return invalid;
      if (capability === undefined) {
        return block(snapshot, 'RESOLVE_TRUSTED_BASELINE', [
          {
            code: 'TRUSTED_BASELINE_CAPABILITY_MISSING',
            summary: 'The trusted application baseline capability was not injected.',
          },
        ]);
      }

      const operationRequest = request(snapshot, 'RESOLVE_TRUSTED_BASELINE');
      const authorization = await authorize(capability, operationRequest);
      if (authorization === 'ERROR') {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'BASELINE_AUTHORIZATION_ERROR',
          'The injected Task D capability returned an invalid authorization result.',
        );
      }
      if (authorization === 'DENIED') {
        return block(snapshot, 'RESOLVE_TRUSTED_BASELINE', [
          {
            code: 'BASELINE_AUTHORIZATION_DENIED',
            summary: 'Trusted baseline resolution was not authorized.',
          },
        ]);
      }

      let baselineInput: unknown;
      try {
        baselineInput = await capability.readTrustedBaseline(operationRequest);
      } catch {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'TRUSTED_BASELINE_DEPENDENCY_ERROR',
          'The injected trusted baseline capability failed.',
        );
      }

      let baseline: TrustedSyntheticDebugBaselineRecord | null = null;
      if (baselineInput !== null && baselineInput !== undefined) {
        try {
          baseline = parseTrustedSyntheticDebugBaselineRecord(baselineInput);
        } catch {
          return fail(
            snapshot,
            'RESOLVE_TRUSTED_BASELINE',
            'MALFORMED_TRUSTED_BASELINE',
            'The injected trusted baseline capability returned an invalid record.',
          );
        }
        if (baseline.caseId !== snapshot.caseId || baseline.projectId !== snapshot.projectId) {
          return fail(
            snapshot,
            'RESOLVE_TRUSTED_BASELINE',
            'TRUSTED_BASELINE_SCOPE_MISMATCH',
            'The injected baseline did not match the active case and project.',
          );
        }
      }
      if (snapshot.discovery === null) {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'DISCOVERY_INVARIANT_MISSING',
          'A discovery summary is required before baseline resolution.',
        );
      }

      const blockers = baselineBlockers(snapshot.discovery, baseline);
      if (blockers.length > 0) {
        return block(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          blockers as [SyntheticDebugTransitionReason, ...SyntheticDebugTransitionReason[]],
        );
      }
      if (baseline === null) {
        return fail(
          snapshot,
          'RESOLVE_TRUSTED_BASELINE',
          'BASELINE_RESOLUTION_INVARIANT',
          'Baseline resolution passed without a trusted baseline record.',
        );
      }
      return apply(
        snapshot,
        'RESOLVE_TRUSTED_BASELINE',
        'MARK_BASELINE_READY',
        [
          {
            code: 'OWNER_VERIFIED_BASELINE_RESOLVED',
            summary: 'The exact owner-verified baseline matched authorized discovery evidence.',
          },
        ],
        'ADVANCED',
        { knownGoodBaseline: deepFreeze(baseline) },
      );
    },
  });
}
