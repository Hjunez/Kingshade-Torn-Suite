# KS Leslie architecture

## Core principle

The AI model is not the source of truth. Evidence, repository state, test output, and current Torn documentation are the source of truth. The model coordinates those sources and tools.

## Layers

1. Coordinator — owns the user conversation and delegates specialist work.
2. Research specialist — current Torn research plus knowledge-base retrieval.
3. Engineering specialist — architecture, debugging, state machines, and implementation reasoning.
4. Review specialist — independent challenge of assumptions, regressions, compliance, and test coverage.
5. Identity and authorization — server-side role, capability, project, and knowledge-zone enforcement.
6. Session memory — OpenAI Conversations dialogue continuity, stored independently from project memory.
7. Project memory — local, schema-validated Torn/Kingshade records with provenance, verification, lifecycle history, and pre-ranking authorization.
8. Core service — remote-accessible Leslie brain, conversations, policies, research, and orchestration.
9. Local Worker — authenticated outbound-connected Windows worker for isolated repository and test execution.
10. External tools — Torn API, Git/GitHub, documentation sources, and test runners, each with explicit permissions.

## Phase C1 core orchestration

Phase C1 makes the Core capability topology explicit and enforces it through agent/tool wiring:

- KS Leslie coordinates the conversation, may inspect read-only Repository Intelligence, and delegates specialist work. It has no direct Worker capability and cannot mutate code.
- Torn Research handles current web research and optional configured vector/file search. It classifies evidence and uncertainty and receives no Worker or repository-mutation capability.
- Torn Engineering receives read-only Repository Intelligence and, only when trusted application configuration supplies it, the existing Worker tool layer. Worker operations that can create a candidate are reachable only through Engineering and still require the existing private application-issued grant, SDK approval, exact baseline, isolated worktree, scoped paths, and verification gates. Engineering cannot self-approve a candidate.
- Torn Review independently inspects repository evidence, assumptions, regression risk, Torn compliance, secret leakage, state-machine behavior, PDA/mobile/browser impact, and missing coverage. Review is read-only, receives no Worker tools, and does not grant implementation approval.

No Core agent receives a generic shell or process-execution primitive. Phase C2 added bounded memory and curated ingestion, and Phase C3 now adds the synthetic Debug MVP orchestration described below.

## Phase C2 persistent project memory

Phase C2 composes two deliberately separate forms of continuity:

- A conversation session retains dialogue through an OpenAI Conversations identifier.
- Durable project memory retains explicit structured facts, decisions, baselines, failures, test evidence, security decisions, and curated Torn notes in the configured local state directory.

Conversations are not automatically copied, summarized, or indexed into project memory. Each durable record identifies its project, knowledge zone, source and provenance class, verification state, timestamps, and lifecycle or supersession relationship. Exact duplicates and identifier collisions are handled deterministically. Supersession and invalidation preserve the older record for audit, and unresolved contradictory active records remain visible instead of allowing the newest record to win automatically.

Trusted application wiring supplies actor identity, role, project grants, allowed zones, and any owner or faction scope. Records are filtered against that context before text scoring or result ranking, so unauthorized records cannot affect ranking or summaries. Missing context, unknown zones, ungranted projects, mismatched private owners, and mismatched faction scopes deny access. The model cannot change or escalate this context.

The local CLI uses an explicit `OWNER_DEVELOPER` context as the minimum safe Phase C2 runtime boundary. It is not account management, faction administration, or a complete multi-user RBAC implementation. Agent-originated memory writes remain pending hypotheses and cannot assert owner verification.

Curated knowledge enters through a bounded, schema-validated manifest passed to the ingestion service. The parser does not recursively scan directories or fetch source URLs. The same access, validation, provenance, and persistence path applies to curated entries and direct memory writes. Content checks reject oversized, NUL/binary-like, likely-secret, and identifiable unrelated personal-data payloads on a best-effort basis without echoing rejected values.

See `docs/PERSISTENT_MEMORY.md` for the complete C2 boundary.

## Phase C3 synthetic Debug MVP

Phase C3 composes the existing Repository Intelligence, Worker, and C2 memory services behind one trusted application facade. The deterministic state path is `INTAKE` -> `DISCOVERY` -> `EVIDENCE_READY` -> `BASELINE_READY` -> `ROOT_CAUSE_READY` -> `IMPLEMENTATION_READY` -> `AWAITING_WRITE_APPROVAL` -> `IMPLEMENTING` -> `VERIFYING` -> `REVIEWING` -> `TEST_READY`; policy, execution, or user decisions can instead end in protected terminal `BLOCKED`, `FAILED`, or `CANCELLED` states.

The model-facing boundary accepts only bounded schema-validated analysis and exposes bounded next actions plus safe snapshots and errors. Trusted application code owns identities, authorization, owner verification, write approval, reviewer binding, transitions, and final disposition. There is no arbitrary target-state API. Approval grants and secrets never enter model inputs, safe snapshots, reports, or durable memory.

Baseline selection requires explicit owner verification; current/newest commits, releases, and automated test or CI results are supporting evidence only. Conflicts block, failed candidates are not promoted, and executions are never patch-stacked. Engineering reaches a controlled Worker only through the application facade, bound to an exact baseline, isolated worktree, approved paths, allowlisted profiles, and cleanup/rollback rules. Verification reuses the cached trusted Worker result and validates required profiles, scope, candidate/rollback integrity, and finalization without re-executing it.

Independent Review is read-only, has no Worker or approval authority, and returns bounded evidence through an application adapter that validates its candidate binding. The existing `canDeliverTestCandidate` gate is authoritative: only a fully passing bound review and all other gates permit `TEST_READY`; missing, failed, or conflicting evidence produces `BLOCKED`.

Final outcomes use the Phase C2 memory service with authorization before retrieval, preserved history and conflicts, no latest-wins promotion, and fail-safe persistence. Synthetic automated outcomes remain non-owner-verified. C3.11 exercised the complete path using the real Stage B Worker in a temporary repository, including negative cases, exactly-once execution, source-worktree preservation, secret non-exposure, memory retrieval, and deterministic reporting. It did not change or validate a production Torn userscript.

## Phase C4.9 baseline exception

`KNOWN_GOOD` remains the default and its owner-verification gates are unchanged. C4.9 adds a discriminated `DEFECT_REFERENCE` record for the narrow case where a documented historical boundary contains no owner-verified defect-free baseline. Only an injected trusted application capability can supply and authorize this record; model records and coordinator, Research, Engineering, and Review tools cannot select the mode or submit acknowledgement fields.

Before exception authorization, Research or Engineering may record evidence-linked root cause read-only in `EVIDENCE_READY`; proposal creation and Worker execution remain unavailable. A valid exception binds the case/project, exact SHA, reproducible evidence, historical boundary, owner acknowledgement that it is not known-good, known defects/failures, selection reason, and rollback semantics. It still requires a separate write decision, private Worker approval, isolated worktree, approved paths, allowlisted verification, independent read-only review, final delivery gate, and later owner verification before production or release.

Snapshots, Worker requests, verification decisions, review packages, durable memory, and final reports carry the baseline mode explicitly. `DEFECT_REFERENCE` provenance remains supporting/non-known-good on round-trip; no newest, release, CI, synthetic, persisted, or model evidence can promote it to `KNOWN_GOOD`.

## Access model

KS Leslie uses default-deny RBAC plus capability and project grants. Authorization is enforced before retrieval and before every tool invocation; prompts are not a security boundary. Knowledge is divided into PUBLIC_TORN, FACTION_SHARED, PRIVATE_KINGSHADE_DEV, and per-user USER_PRIVATE zones.

The detailed role and knowledge-isolation contract is defined in `docs/ACCESS_MODEL.md`.

## Core + Worker deployment

KS Leslie is designed as a remotely reachable Core plus an optional local Worker:

- Core remains available from PC and mobile for conversations, current research, authorized knowledge retrieval, GitHub-based reads, and orchestration.
- Worker runs on the owner's Windows PC and establishes an outbound authenticated connection to Core.
- Worker owns local repository access, native Git-worktree isolation, allowlisted local tests, and other workstation-only capabilities.
- If Worker is offline, Core remains usable but cannot execute Worker-only jobs.
- Non-development roles cannot address the Worker.

## Trust boundaries

- OpenAI API key: environment only; never indexed or committed.
- Torn API key: future environment/secret store only; never indexed or committed.
- Production repositories: read-only before controlled workspace support.
- Write operations: scoped to an exact owner-verified baseline or explicitly authorized defect-reference commit, separate branch, isolated worktree, approved paths, private one-time grant, SDK approval, required tests, and rollback state.
- Authorization: enforced in application code before retrieval or tool use.
- Mobile access: authenticates to Core; the PC is not exposed directly to the public internet.
- Torn gameplay: no automated gameplay actions.

## Evidence taxonomy

Every material conclusion should be attributable to one of these classes:

- OFFICIAL_CURRENT — current Torn documentation, Swagger/API, rules, or directly observed live Torn state.
- USER_VERIFIED — explicit trusted owner/user verification or a reproducible user artifact; automated evidence alone cannot grant this classification.
- AUTOMATED_TEST — CI, test, or other automated evidence that may support or invalidate a candidate but cannot establish owner verification by itself.
- COMMUNITY — community-derived evidence that has not been officially confirmed.
- INFERENCE — a hypothesis or deduction requiring validation.

Persistence does not improve evidence quality: releases, newer commits, CI success, and model inference remain supporting or hypothetical evidence unless a trusted owner/user verification event explicitly says otherwise.

## Windows execution

Stage B runs on Node.js 22 or newer and uses Git's native worktree isolation on Windows. The model receives only fixed, schema-validated Worker operations; process execution remains inside trusted application code and test-profile definitions. Controlled writes require an exact 40-character selected reference, mode-appropriate trusted authorization, a separate private application-issued approval grant, an SDK approval interruption, an approved path set, a separate `ks-leslie/...` branch, and cleanup on failure or scope violation.

Docker is optional and was not available for the Stage B acceptance run. It may become an additional isolation backend later, but it is not required by the current Worker implementation.

Repository Intelligence uses the same read-only interface for local Git and fixed-host GitHub reads. Mutable refs are resolved once to full commit SHAs, repository-origin checks guard local fallback selection, and agent-facing evidence is bounded, provenance-labelled, treated as untrusted data, and secret-redacted.
