# KS Leslie access model

## Goal

KS Leslie is one shared Torn intelligence platform with strict per-user capability and knowledge boundaries. A user must never gain access to a tool, repository, secret, conversation, memory item, or knowledge source merely because another Leslie user can access it.

## Default-deny principle

Access is denied unless a role and policy explicitly grant it. Authorization is evaluated server-side before retrieval and before every tool invocation. Prompt instructions are not an authorization boundary.

## Phase C2 local runtime boundary

Phase C2 constructs one explicit local `OWNER_DEVELOPER` context in trusted application wiring. It carries the actor identity, role/capability identity, project grants, allowed knowledge zones, and any owner or faction scope used for authorization. The model cannot provide, replace, or escalate those fields.

This context is the minimum boundary needed for safe local memory. It is not a full identity service, account-management system, faction administrator, sharing workflow, or multi-user RBAC implementation. The broader roles below remain the intended access model, not a claim that the complete product exists in Phase C2.

## Initial roles

### OWNER_DEVELOPER

Intended for the system owner.

Capabilities:

- Public Torn research and current-web research.
- Private Kingshade development knowledge.
- Faction knowledge where explicitly granted.
- Git/GitHub repository intelligence.
- Local Worker access.
- Sandboxed code editing and test execution when that stage is enabled.
- Controlled branch, patch, commit, and pull-request preparation.
- Read-only Torn API tools.
- Administration of users, roles, projects, knowledge zones, and approvals.

### TORN_ADVISOR

Intended for trusted faction leadership or invited Torn-only users.

Capabilities:

- Public Torn knowledge.
- Current Torn research.
- Read-only Torn API information exposed by approved advisor tools.
- Optional faction-shared knowledge explicitly assigned to the user.

Explicitly denied:

- Source repositories and source-code retrieval.
- Script source, private development memory, DOM probes, private logs, internal test fixtures, and rollback history.
- Git/GitHub development tools.
- Local Worker access.
- Shell, filesystem, patch, build, or test tools.
- Secrets and private owner conversations.

### FACTION_MEMBER

Future reduced role for general faction access.

Capabilities are limited to explicitly published faction knowledge and approved Torn advisory tools. No development access.

### DEVELOPER

Future collaborator role. Repository and Worker permissions are granted per project rather than globally.

## Knowledge zones

### PUBLIC_TORN

Current official Torn documentation, public Torn mechanics, approved public community evidence, and public research.

### FACTION_SHARED

Faction playbooks, faction-specific notes, shared war guidance, approved internal faction information, and other material deliberately published to the faction zone.

### PRIVATE_KINGSHADE_DEV

Source-code intelligence, architecture decisions, versions, regression evidence, DOM probes, private test results, rollback baselines, unpublished tools, internal research, and development conversations.

### USER_PRIVATE

A user's own conversations, preferences, saved analyses, and private notes. This zone is isolated per user unless the user explicitly shares an item.

## Memory isolation

Conversation sessions and durable project memory are separate. A conversation identifier provides dialogue continuity; it does not authorize memory access and its transcript is not silently converted into durable records.

Each durable record carries its project, knowledge zone, provenance, verification state, and owner or tenant/faction scope where relevant. Trusted application context, rather than model input, determines the actor, role, grants, and allowed zones. Retrieval first excludes every unauthorized project, zone, owner, and faction record and only then scores and ranks the remaining records. Unauthorized material must not influence rankings or summaries and must never be retrieved and then hidden by the model afterward.

Missing context, unknown zones, ungranted projects, mismatched `USER_PRIVATE` owners, and mismatched `FACTION_SHARED` tenant/faction scopes are denied. `PRIVATE_KINGSHADE_DEV` is never exposed to a public or advisor-style context merely because another agent or user can retrieve it.

## Provenance and verification

Durable records distinguish official/current, trusted owner/user-verified, community-derived, automated/test, and inference/hypothesis evidence. Owner verification requires an explicit trusted application or user-verification event. CI success, passing tests, release records, newer commits, and model inference can support a candidate but cannot create owner verification.

Model-originated writes remain pending hypotheses. Persistence alone never promotes them. Supersession and invalidation retain prior records for audit, and contradictory active evidence remains visible until an explicit trusted resolution; there is no automatic latest-wins rule for known-good evidence.

## Curated ingestion boundary

Curated Torn/Kingshade knowledge is accepted only through an explicit schema-validated manifest. The ingestion path does not recursively scan folders, discover arbitrary files, or fetch remote URLs. Every entry supplies its project, zone, provenance, source description, content, and verification state and passes through the same authorization and durable-write service as other records.

Before persistence, bounded content checks reject NUL/binary-like payloads, likely credentials or session material, and identifiable unrelated personal-data categories. Detection is layered and best-effort rather than a guarantee. Rejection errors and audit metadata do not echo the rejected value.

## Tool authorization

Every tool declares required capabilities. The authorization layer validates the authenticated user before the tool can be invoked.

Examples:

- Public web research: TORN_RESEARCH.
- Torn API advisor query: TORN_API_READ.
- Repository search: REPO_READ plus project grant.
- Worker request: WORKER_USE plus project grant.
- Patch/test operation: CODE_WRITE or TEST_RUN plus project grant and applicable approval policy.

## Worker boundary

The local KS Leslie Worker trusts authenticated, signed Core jobs only. The Core cannot bypass Worker policy. The Worker maintains its own allowlist of repositories, operations, writable branches, execution limits, and secret-handling rules.

Advisor and faction roles can never address the Worker.

## Approval classes

- SAFE_READ: no approval for authorized read-only research and retrieval.
- DEV_READ: no approval for owner/developer repository reads once the project is granted.
- SANDBOX_WRITE: configurable approval for isolated workspace edits.
- GIT_PUBLISH: explicit approval before pushes, pull requests, merges, or release publication unless a later owner policy safely delegates a narrower action.
- SECRET_OR_PRODUCTION: never delegated by model judgment alone.

## Audit

Security-relevant operations record actor, role, requested capability, project, tool, decision, timestamp, and result metadata. Secrets and unnecessary sensitive payloads are not written to audit logs.

## Non-negotiable invariants

- Roles are enforced in application code, never only in prompts.
- Knowledge filtering happens before retrieval.
- Unauthorized records cannot influence ranking or summaries.
- Tool authorization happens before invocation.
- Model input cannot select or escalate actor identity, role, project grants, allowed zones, or tenant/faction authority.
- Automated, release, or inferred evidence cannot fabricate owner verification.
- No Torn gameplay automation.
- Torn API access remains read-only.
- No role receives a private development source through summaries, citations, embeddings, cached answers, or cross-user memory leakage.
- The least-privilege role is used by default.
