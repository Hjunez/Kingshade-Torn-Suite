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

No Core agent receives a generic shell or process-execution primitive. Persistent project memory and knowledge ingestion, plus the full Debug MVP orchestration state machine, remain pending after Phase C1. Phase C2 adds the bounded memory and curated-ingestion foundation; the Debug MVP orchestration state machine remains pending.

## Phase C2 persistent project memory

Phase C2 composes two deliberately separate forms of continuity:

- A conversation session retains dialogue through an OpenAI Conversations identifier.
- Durable project memory retains explicit structured facts, decisions, baselines, failures, test evidence, security decisions, and curated Torn notes in the configured local state directory.

Conversations are not automatically copied, summarized, or indexed into project memory. Each durable record identifies its project, knowledge zone, source and provenance class, verification state, timestamps, and lifecycle or supersession relationship. Exact duplicates and identifier collisions are handled deterministically. Supersession and invalidation preserve the older record for audit, and unresolved contradictory active records remain visible instead of allowing the newest record to win automatically.

Trusted application wiring supplies actor identity, role, project grants, allowed zones, and any owner or faction scope. Records are filtered against that context before text scoring or result ranking, so unauthorized records cannot affect ranking or summaries. Missing context, unknown zones, ungranted projects, mismatched private owners, and mismatched faction scopes deny access. The model cannot change or escalate this context.

The local CLI uses an explicit `OWNER_DEVELOPER` context as the minimum safe Phase C2 runtime boundary. It is not account management, faction administration, or a complete multi-user RBAC implementation. Agent-originated memory writes remain pending hypotheses and cannot assert owner verification.

Curated knowledge enters through a bounded, schema-validated manifest passed to the ingestion service. The parser does not recursively scan directories or fetch source URLs. The same access, validation, provenance, and persistence path applies to curated entries and direct memory writes. Content checks reject oversized, NUL/binary-like, likely-secret, and identifiable unrelated personal-data payloads on a best-effort basis without echoing rejected values.

See `docs/PERSISTENT_MEMORY.md` for the complete C2 boundary.

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
- Write operations: scoped to an exact commit, separate branch, isolated worktree, approved paths, private one-time grant, SDK approval, required tests, and rollback state.
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

Stage B runs on Node.js 22 or newer and uses Git's native worktree isolation on Windows. The model receives only fixed, schema-validated Worker operations; process execution remains inside trusted application code and test-profile definitions. Controlled writes require an exact 40-character baseline, a private application-issued approval grant, an SDK approval interruption, an approved path set, a separate `ks-leslie/...` branch, and cleanup on failure or scope violation.

Docker is optional and was not available for the Stage B acceptance run. It may become an additional isolation backend later, but it is not required by the current Worker implementation.

Repository Intelligence uses the same read-only interface for local Git and fixed-host GitHub reads. Mutable refs are resolved once to full commit SHAs, repository-origin checks guard local fallback selection, and agent-facing evidence is bounded, provenance-labelled, treated as untrusted data, and secret-redacted.
