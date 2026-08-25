# KS Leslie Debug MVP

## Mission

The Debug MVP exists to remove repetitive manual script-debugging work from the owner as early as possible. It is the release blocker for all lower-priority KS Leslie product features.

## Implemented Phase C3 workflow

Phase C3 implements a deterministic synthetic workflow through the trusted application facade. Its actual states are `INTAKE`, `DISCOVERY`, `EVIDENCE_READY`, `BASELINE_READY`, `ROOT_CAUSE_READY`, `IMPLEMENTATION_READY`, `AWAITING_WRITE_APPROVAL`, `IMPLEMENTING`, `VERIFYING`, `REVIEWING`, and the terminal states `TEST_READY`, `BLOCKED`, `FAILED`, or `CANCELLED`. Terminal states reject further transitions.

### 1. Intake

Accept a concise natural-language bug report or engineering goal. Resolve the relevant project and current working state from repository and project evidence before asking the owner to repeat information that is already available.

### 2. Baseline discovery

Identify the current candidate, latest genuinely verified known-good baseline, relevant Git history, previous failed attempts, and existing regression tests. Newest/current commits, releases, and CI success are not automatically known-good: explicit owner verification is required. Conflicting evidence blocks selection, and a failed candidate never becomes the next baseline automatically. Do not patch-stack.

### 3. Evidence collection

Search source, tests, logs, DOM probes, recorded observations, and available project documentation. Classify material claims as official/current, user-verified, community-derived, or inference.

### 4. Root-cause analysis

Prefer a reproducible explanation over a speculative patch. Where possible, create or identify a regression test that fails for the defect before changing production logic.

### 5. Controlled implementation

After the trusted application records implementation readiness, it enters `AWAITING_WRITE_APPROVAL`. Models cannot approve their own work. Approval identities and private grants remain application-owned and are never exposed to models or persisted in safe snapshots, reports, or memory.

Engineering can participate only through the trusted application facade. The application binds one approved proposal to an exact baseline, an isolated Git worktree, approved paths, allowlisted test profiles, and rollback state. The Worker exposes no arbitrary shell, process, executable, repository-root, patch, or approval-secret input. Scope or execution failure cleans up the failed candidate and preserves the source working copy; successful synthetic work is retained only for trusted verification and delivery handling.

### 6. Verification loop

Verification consumes only the cached trusted Worker result; it does not execute or patch again. It checks the exact candidate and rollback binding, action order and scope, required profile coverage and status, candidate integrity, cleanup/rollback facts, and successful finalization. A patch applying is never sufficient for `TEST_READY`.

### 7. Independent review

A separate Review capability checks the proposed change for unsupported assumptions, regression risk, Torn compliance, secret leakage, state-machine errors, PDA/mobile/browser compatibility, and missing coverage. Review is independent from Engineering, read-only, has no Worker or approval authority, and submits bounded evidence through a trusted adapter that validates and binds it to the candidate. Missing, failed, mismatched, or conflicting review blocks delivery.

### 8. Delivery

`canDeliverTestCandidate` remains the authoritative final gate. The application produces `TEST_READY` only when all baseline, implementation, verification, independent-review, rollback, and finalization gates pass; otherwise it produces `BLOCKED`. Models cannot select an arbitrary target state or directly assert `TEST_READY`.

The application persists the final synthetic outcome through the existing Phase C2 memory service after authorization. Automated synthetic outcomes remain non-owner-verified, history and conflicts are preserved without latest-wins promotion, and persistence failure fails safely. The facade exposes only schema-bounded next actions, safe snapshots, and safe errors, never a generic target-state operation.

## Trust and agent boundaries

Models provide bounded analysis or input through strict schemas. Application code owns actor identity, authorization, owner verification, approval, reviewer authority, state transitions, and final disposition. The coordinator has no direct Worker; Research is read-only; Engineering reaches the Worker only through the trusted application boundary; Review is independent and read-only with no Worker. No agent receives generic shell or process execution.

## Phase C3 synthetic acceptance

C3.11 proved one deterministic intake-to-`TEST_READY` happy path using the real Stage B Worker against a temporary synthetic repository. It proved exactly-once Worker execution with no patch stacking, source-worktree preservation, required negative scenarios, approval-secret non-exposure, durable memory persistence and authorized retrieval, and a deterministic final report. This does not mean that a real Torn userscript has been repaired or accepted.

## Real-regression acceptance criteria

Debug MVP is accepted only after a real Kingshade regression can be handled end-to-end with the following evidence:

- Correct project and known-good baseline selected without manual reconstruction by the owner.
- Relevant code and history inspected.
- Root-cause evidence recorded.
- Isolated code change created.
- Relevant automated tests executed.
- At least one regression-specific check protects the defect when practical.
- Independent review completed.
- A TEST branch or equivalent controlled output is prepared.
- The known-good rollback baseline remains intact.
- The owner did not need to manually shuttle large code blocks between tools.

## Stage B acceptance boundary

The Stage B fixture exercise proves the local mechanism without changing a production userscript: read-only inspection, exact-baseline approval, isolated worktree and branch creation, scoped patching, required-test failure blocking, successful candidate commit, source-worktree preservation, cleanup, and machine-readable rollback reporting.

The fixture supplies a deterministic synthetic review record to exercise the delivery gate. It does not prove that the live Leslie review specialist reviewed a real change, that a production userscript works in Torn PDA, or that historical War Dibs browser profiles are currently portable and green. Those facts require the first real regression exercise and cannot be inferred from CI success.

## Priority order

1. Repository intelligence and baseline detection.
2. Safe Worker execution and isolated file editing.
3. Existing Kingshade test-suite execution and structured result capture.
4. Regression-specific test generation and repair loop.
5. Independent review and release reporting.
6. Mobile remote control after the debugging loop is useful.
7. Multi-user/faction product features after owner debugging is useful.

## Explicit non-goals before acceptance

The following must not delay the Debug MVP: polished dashboard UI, avatar/branding effects, faction self-service administration, broad Torn-advisor productization, intelligence graph visualization, background monitoring, or cosmetic wheel interactions.

Phase C3 does not claim completion of mobile/PWA, full faction RBAC, or real War Dibs acceptance.

## Before the first real userscript regression

After the final GitHub C3 checkpoint is verified, the owner must deliberately select the first real acceptance case. Leslie must then perform read-only discovery of the actual current local and remote project state, obtain an explicitly owner-verified known-good baseline, and gather verified real source, DOM, video, and other defect evidence as applicable. Production candidate changes require explicit write approval and the relevant real regression, browser, and PDA/mobile evidence. Nothing is automatically merged, released, or published.
