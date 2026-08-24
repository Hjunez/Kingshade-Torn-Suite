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

The Debug MVP is accepted only after this loop succeeds on a real Kingshade regression with materially less manual work from the owner. Stage B proves the mechanism with a synthetic fixture; it does not claim that real-regression acceptance yet.

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
- Strict TypeScript, Vitest, ESLint, Prettier, locked installs, and runtime-only dependency auditing.

Worker tools are attached only to Torn Engineering when trusted application code injects a `WorkerAgentService`, or when the CLI's explicitly configured local repository root passes Worker Doctor. The coordinator and Torn Review never receive them. The CLI has no write-grant issuance flow, so its Engineering-connected Worker remains read-only. The controlled-write tool additionally requires both an SDK approval and a pending application-issued grant.

Conversation persistence provides dialogue continuity. Durable project memory stores only explicit, structured Torn/Kingshade facts, decisions, evidence, and hypotheses; conversations are not silently summarized or ingested. Model-originated writes remain pending hypotheses, and owner verification requires trusted application/user evidence. The local `OWNER_DEVELOPER` context is a minimal single-owner Phase C2 boundary, not the future multi-user RBAC product.

See [persistent memory](docs/PERSISTENT_MEMORY.md), [Stage B](docs/STAGE_B.md), [architecture](docs/ARCHITECTURE.md), and [Debug MVP](docs/DEBUG_MVP.md) for the exact boundaries.

## Remaining before a real regression

- Owner confirmation of a known-good full commit SHA and reproducible defect evidence.
- A real independent review bound to the candidate rather than fixture-supplied review evidence.
- Restored remote War Dibs browser/compatibility profiles with portable, passing fixtures.
- Direct PDA/mobile and relevant browser evidence; CI alone cannot establish Torn PDA behavior.
- Application UI or service code that creates trusted project policies and explicit owner approval grants.

## Roadmap

### Stage A - Repository intelligence

Core and agent-facing read-only tools are implemented. Phase C2 adds durable structured project evidence, while owner verification still requires explicit trusted evidence and cannot be inferred from repository history or automation.

### Stage B - Controlled Worker

Implemented for local Windows execution using native Git worktree isolation. Docker is an optional future backend, not a current requirement.

### Stage C - Automated verification loop

Connect restored project regression profiles, capture structured failures, and permit bounded repair iterations.

Persistent memory does not complete this stage. The full Debug MVP orchestration and its first real Kingshade regression remain pending.

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
