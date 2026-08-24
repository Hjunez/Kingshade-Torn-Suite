# KS Leslie

KS Leslie is a dedicated Torn City engineering and research agent. Its first objective is not to become a complete Torn platform; its first objective is to reduce the time required to diagnose, modify, test, and review Kingshade scripts.

## Current priority: Debug MVP

All non-essential product work is deferred until the Debug MVP is usable.

The Debug MVP must let the owner give Leslie a bug or engineering goal in natural language and have Leslie:

1. Inspect the correct repository, current implementation, Git history, and known-good baseline.
2. Search relevant source, tests, DOM evidence, logs, and prior regression information.
3. Form a root-cause hypothesis and distinguish verified evidence from inference.
4. Create a bounded change in an isolated workspace or branch without modifying the known-good baseline.
5. Run the relevant TypeScript, ESLint, Vitest, Playwright, and project-specific checks that are available.
6. Iterate on failures without claiming success until evidence supports it.
7. Perform an independent review for regressions, Torn compliance, secret leakage, and PDA/browser compatibility.
8. Produce a concise TEST result containing the change, evidence, test status, remaining uncertainty, and rollback baseline.

The Debug MVP is considered useful only when it can complete that loop on a real Kingshade script with materially less manual work from the owner.

## Current pre-PC implementation status

Implemented and locally strict-TypeScript/smoke-verified where dependency-free:

- deterministic project resolution for War Dibs, FFScouter Call Guard, War Tools, and Scout;
- strict userscript-header and version inspection;
- evidence-weighted known-good baseline selection that requires explicit owner verification;
- Git release history and CI/test evidence adapters that cannot promote a baseline by themselves;
- read-only GitHub repository client for file reads, commit history, and ref comparison;
- composed Repository Intelligence Service with capped source-chunk retrieval;
- Worker job contract with read-only versus controlled-write modes;
- Worker path sandboxing, explicit write approval, isolated-branch requirement, and stale-baseline guard;
- allowlisted test-profile model rather than model-generated arbitrary shell commands;
- hard implementation and TEST-delivery gates;
- evidence-derived TEST readiness reporting that cannot mark failing verification as ready;
- Node 22 GitHub Actions validation workflow for the Leslie project;
- external-agent/Jarvis quarantine and component-reuse process.

Not implemented yet:

- a running local Worker connected to the Windows repository;
- actual filesystem editing or patch application;
- local Git branch creation/commit execution from Leslie;
- execution of the existing Kingshade Vitest/Playwright stack through Worker;
- agent-facing wrappers around Repository Intelligence;
- the first real end-to-end regression acceptance test.

## v0.1 bootstrap

The bootstrap contains:

- GPT-5.6 Sol coordinator.
- GPT-5.6 Terra research, engineering, and independent-review specialists.
- Current web research capability for the research specialist.
- Optional OpenAI vector-store/file-search capability for a Torn/Kingshade knowledge base.
- Persistent conversation state using the OpenAI Conversations API.
- Strict TypeScript configuration.
- Vitest, ESLint, and Prettier verification.
- A permanent Torn-specific evidence hierarchy and engineering policy.
- Core/Worker direction, RBAC, and isolated knowledge zones documented for later product stages.

It does not yet edit repositories or execute shell commands. Those are now the highest-priority capabilities to add safely.

## Critical path

### Stage A — Repository intelligence

Core foundation implemented. Remaining work is agent-facing tool wiring, richer project discovery, and importing durable owner-verified baseline evidence.

### Stage B — Controlled Worker

Add an isolated Windows/Docker-backed engineering workspace that can modify files, create patches, preserve snapshots, and resume work without unrestricted writes to production repositories.

### Stage C — Automated verification loop

Run the existing Kingshade validation stack, capture structured results, map failures back to the attempted change, and permit bounded repair iterations.

### Stage D — Regression and release gate

Use the implemented gates and report model with real Worker evidence, independent review, known-good rollback protection, PDA/mobile-browser/PC compatibility profiles, and clear TEST-build reporting.

### Debug MVP acceptance test

A real request such as a reproducible PDA userscript regression must be traceable from report to root-cause evidence, isolated change, relevant automated tests, independent review, and a prepared TEST branch while preserving the verified rollback baseline.

## Deferred until after Debug MVP

These remain planned but must not delay the debugging core:

- Mobile/PWA client and remote job queue.
- Faction accounts and user-facing RBAC administration.
- Faction knowledge features.
- Advanced Torn Intelligence Graph.
- Change-radar and background monitoring features.
- Cosmetic Leslie identity features and dashboards.

Security architecture for those features is still designed now where necessary to avoid rework, but their product implementation is deferred.

## Later platform stages

After Debug MVP, continue with curated Torn/Kingshade knowledge ingestion, read-only Torn API v2 tools, Core/Worker remote access, multi-user RBAC, faction-facing Torn Advisor access, and the broader KS Leslie platform.

## Safety invariants

- Never commit API keys, cookies, passwords, tokens, or other secrets.
- Torn API access is read-only and minimum-permission.
- Do not automate gameplay actions.
- Do not claim a change was tested unless test output exists.
- Do not patch-stack on an unverified regression; preserve and use the known-good rollback baseline.
- Treat Torn PDA/mobile behavior as a first-class compatibility target.
