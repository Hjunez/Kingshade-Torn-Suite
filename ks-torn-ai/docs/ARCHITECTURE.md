# KS Leslie architecture

## Core principle

The AI model is not the source of truth. Evidence, repository state, test output, and current Torn documentation are the source of truth. The model coordinates those sources and tools.

## Layers

1. Coordinator — owns the user conversation and delegates specialist work.
2. Research specialist — current Torn research plus knowledge-base retrieval.
3. Engineering specialist — architecture, debugging, state machines, and implementation reasoning.
4. Review specialist — independent challenge of assumptions, regressions, compliance, and test coverage.
5. Identity and authorization — server-side role, capability, project, and knowledge-zone enforcement.
6. Session memory — persistent conversational context isolated by user and scope.
7. Knowledge memory — vector-store retrieval with provenance metadata and authorization filtering; added in v0.2.
8. Core service — remote-accessible Leslie brain, conversations, policies, research, and orchestration.
9. Local Worker — authenticated outbound-connected Windows worker for isolated repository and test execution.
10. External tools — Torn API, Git/GitHub, documentation sources, and test runners, each with explicit permissions.

## Access model

KS Leslie uses default-deny RBAC plus capability and project grants. Authorization is enforced before retrieval and before every tool invocation; prompts are not a security boundary. Knowledge is divided into PUBLIC_TORN, FACTION_SHARED, PRIVATE_KINGSHADE_DEV, and per-user USER_PRIVATE zones.

The detailed role and knowledge-isolation contract is defined in `docs/ACCESS_MODEL.md`.

## Core + Worker deployment

KS Leslie is designed as a remotely reachable Core plus an optional local Worker:

- Core remains available from PC and mobile for conversations, current research, authorized knowledge retrieval, GitHub-based reads, and orchestration.
- Worker runs on the owner's Windows PC and establishes an outbound authenticated connection to Core.
- Worker owns local repository access, Docker-backed sandboxes, local tests, and other workstation-only capabilities.
- If Worker is offline, Core remains usable but cannot execute Worker-only jobs.
- Non-development roles cannot address the Worker.

## Trust boundaries

- OpenAI API key: environment only; never indexed or committed.
- Torn API key: future environment/secret store only; never indexed or committed.
- Production repositories: read-only before controlled workspace support.
- Write operations: scoped to an isolated branch/workspace with explicit policy and rollback state.
- Authorization: enforced in application code before retrieval or tool use.
- Mobile access: authenticates to Core; the PC is not exposed directly to the public internet.
- Torn gameplay: no automated gameplay actions.

## Evidence taxonomy

Every material conclusion should be attributable to one of these classes:

- OFFICIAL_CURRENT — current Torn documentation, Swagger/API, rules, or directly observed live Torn state.
- USER_VERIFIED — reproducible user artifact or test result.
- COMMUNITY — community-derived evidence that has not been officially confirmed.
- INFERENCE — a hypothesis or deduction requiring validation.

## Windows execution plan

OpenAI's current Sandbox Agents documentation requires Node.js 22+. On Windows, the supported local path is DockerSandboxClient rather than UnixLocalSandboxClient. The controlled-editing stage therefore targets Docker-backed isolation instead of executing unrestricted shell commands directly on the Windows host.
