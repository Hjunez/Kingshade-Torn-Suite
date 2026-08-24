# KS Leslie Debug MVP

## Mission

The Debug MVP exists to remove repetitive manual script-debugging work from the owner as early as possible. It is the release blocker for all lower-priority KS Leslie product features.

## Required workflow

### 1. Intake

Accept a concise natural-language bug report or engineering goal. Resolve the relevant project and current working state from repository and project evidence before asking the owner to repeat information that is already available.

### 2. Baseline discovery

Identify the current candidate, latest genuinely verified known-good baseline, relevant Git history, previous failed attempts, and existing regression tests. Never assume that newest means known-good.

### 3. Evidence collection

Search source, tests, logs, DOM probes, recorded observations, and available project documentation. Classify material claims as official/current, user-verified, community-derived, or inference.

### 4. Root-cause analysis

Prefer a reproducible explanation over a speculative patch. Where possible, create or identify a regression test that fails for the defect before changing production logic.

### 5. Controlled implementation

Make a bounded change in an isolated workspace or branch based on the known-good baseline. Preserve rollback state. Avoid unrelated cleanup during regression work.

### 6. Verification loop

Run the smallest relevant checks first, then the broader affected test set. Capture structured command, exit status, and failure evidence. Failed checks must drive diagnosis; they must not be summarized as success.

### 7. Independent review

A separate review pass checks the proposed change for unsupported assumptions, regression risk, Torn compliance, secret leakage, state-machine errors, PDA/mobile/browser compatibility, and missing coverage.

### 8. Delivery

Prepare a TEST result that states: baseline, root cause, bounded change, tests actually run, pass/fail status, unresolved uncertainty, affected surfaces, and rollback point.

## Acceptance criteria

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
