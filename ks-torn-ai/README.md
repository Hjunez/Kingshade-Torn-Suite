# KS Leslie

KS Leslie is a Torn-specific engineering and research agent. Its current priority is the Debug MVP: diagnose, change, test, independently review, and report on Kingshade scripts while preserving a verified rollback baseline.

## Debug MVP workflow

1. Resolve the project and inspect its source, history, and evidence.
2. Distinguish owner-verified facts from release, CI, community, and inferred evidence.
3. Record reproducible problem evidence and a root-cause statement.
4. Create a bounded change from an exact commit in an isolated branch and Git worktree.
5. Run only repository-owned, allowlisted verification profiles.
6. Block delivery on failed tests, scope violations, missing review, or unresolved uncertainty.
7. Produce a machine-readable TEST report with candidate and rollback SHAs.

Phase C3 completes and synthetically accepts this orchestration, but the Debug MVP is accepted for real use only after the loop succeeds on a real Kingshade regression with materially less manual work from the owner. No production Torn userscript has been repaired by C3.

## Implemented

- GPT-5.6 Sol coordinator with GPT-5.6 Terra research, engineering, and review specialists.
- Persistent OpenAI conversation state, current web research, and optional vector-store search.
- Schema-validated local project memory that persists independently from conversation state and retains record provenance, verification, and history.
- Default-deny memory retrieval that applies trusted project, knowledge-zone, owner, and faction scope before deterministic ranking.
- Strict curated-manifest ingestion with bounded content and best-effort secret, binary, and unrelated personal-data rejection.
- Deterministic project resolution for War Dibs, FFScouter Call Guard, War Tools, and Scout.
- Read-only GitHub and local Git readers with origin validation, immutable-ref provenance, and bounded outputs.
- Six strict Repository Intelligence tools for project resolution, metadata, source chunks, history, ref comparison, and supporting baseline evidence.
- Evidence-weighted baseline logic that cannot promote CI or release history to human-verified known-good.
- High-level Worker tools with no model-facing shell, executable, repository-root, patch, or approval-token input.
- Private one-time application grants, SDK approval, exact baselines, isolated Git worktrees, scoped patches, required tests, and stale-baseline rejection.
- Deterministic test profiles and structured implementation and delivery gates.
- Synthetic end-to-end acceptance covering read-only analysis, failed-test blocking, scoped patching, candidate commit, cleanup, source-worktree preservation, and rollback reporting.
- Deterministic C3 workflow from intake through evidence, an owner-verified baseline, root cause, trusted approval, isolated implementation, cached-result verification, independent review, and authoritative `TEST_READY`/`BLOCKED` delivery.
- One trusted application facade with bounded next actions and safe snapshots/errors; models cannot control identity, authorization, owner verification, approval, reviewer authority, target state, or final disposition.
- Durable synthetic outcome persistence through the C2 memory service, retaining authorization, provenance, history, and conflicts without promoting automated results to owner verification.
- Strict TypeScript, Vitest, ESLint, Prettier, locked installs, and runtime-only dependency auditing.

Worker tools are attached only to Torn Engineering when trusted application code injects a `WorkerAgentService`, or when the CLI's explicitly configured local repository root passes Worker Doctor. The coordinator and Torn Review never receive them. The CLI has no write-grant issuance flow, so its Engineering-connected Worker remains read-only. The controlled-write tool additionally requires both an SDK approval and a pending application-issued grant.

Conversation persistence provides dialogue continuity. Durable project memory stores only explicit, structured Torn/Kingshade facts, decisions, evidence, and hypotheses; conversations are not silently summarized or ingested. Model-originated writes remain pending hypotheses, and owner verification requires trusted application/user evidence. The local `OWNER_DEVELOPER` context is a minimal single-owner Phase C2 boundary, not the future multi-user RBAC product.

See [persistent memory](docs/PERSISTENT_MEMORY.md), [Stage B](docs/STAGE_B.md), [architecture](docs/ARCHITECTURE.md), and [Debug MVP](docs/DEBUG_MVP.md) for the exact boundaries.

## Remaining before a real regression

- Final GitHub verification of the Phase C3 checkpoint, followed by deliberate owner selection of the first real acceptance case.
- Read-only discovery of the actual current local and remote project state.
- Owner confirmation of a known-good full commit SHA and verified real defect evidence from source, DOM, video, or other applicable artifacts.
- A real independent review bound to the candidate rather than fixture-supplied review evidence.
- Restored remote War Dibs browser/compatibility profiles with portable, passing fixtures.
- Direct PDA/mobile and relevant browser evidence; CI alone cannot establish Torn PDA behavior.
- Explicit trusted write approval before any production candidate change; no automatic merge, release, or publish action.

Mobile/PWA, full faction RBAC, and real War Dibs acceptance remain incomplete.

## Roadmap

### Stage A - Repository intelligence

Core and agent-facing read-only tools are implemented. Phase C2 adds durable structured project evidence, while owner verification still requires explicit trusted evidence and cannot be inferred from repository history or automation.

### Stage B - Controlled Worker

Implemented for local Windows execution using native Git worktree isolation. Docker is an optional future backend, not a current requirement.

### Stage C - Automated verification loop

The synthetic orchestration and verification loop are complete through Phase C3. The first real Kingshade regression, including restored project-specific profiles and real browser/PDA evidence, remains pending.

### Stage D - Regression and release gate

Exercise the complete workflow on a real Kingshade defect with independent review and PDA/mobile/browser evidence.

## Safety invariants

- Never commit, prompt, or log API keys, cookies, passwords, tokens, or other secrets.
- Torn API access is read-only and minimum-permission.
- Do not automate Torn gameplay actions.
- Do not claim a change was tested unless its test output exists.
- Do not infer known-good from the newest version, release history, or CI success.
- Do not promote model inference, persistence, automated tests, or release records to owner verification.
- Reject likely secrets, binary payloads, and unrelated personal data before durable persistence without echoing rejected values.
- Preserve an owner-verified rollback baseline and treat PDA/mobile behavior as first-class evidence.
