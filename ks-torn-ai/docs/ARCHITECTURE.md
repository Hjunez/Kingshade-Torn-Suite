# KS Torn AI architecture

## Core principle

The AI model is not the source of truth. Evidence, repository state, test output, and current Torn documentation are the source of truth. The model coordinates those sources and tools.

## Layers

1. Coordinator — owns the user conversation and delegates specialist work.
2. Research specialist — current Torn research plus knowledge-base retrieval.
3. Engineering specialist — architecture, debugging, state machines, and implementation reasoning.
4. Review specialist — independent challenge of assumptions, regressions, compliance, and test coverage.
5. Session memory — persistent conversational context.
6. Knowledge memory — vector-store retrieval with provenance metadata; added in v0.2.
7. Workspace — isolated repository filesystem and execution; added after read-only repository intelligence.
8. External tools — Torn API, Git/GitHub, documentation sources, and test runners, each with explicit permissions.

## Trust boundaries

- OpenAI API key: environment only; never indexed or committed.
- Torn API key: future environment/secret store only; never indexed or committed.
- Production repositories: read-only before v0.4.
- Write operations: scoped to an isolated branch/workspace with explicit approval and rollback state.
- Torn gameplay: no automated gameplay actions.

## Evidence taxonomy

Every material conclusion should be attributable to one of these classes:

- OFFICIAL_CURRENT — current Torn documentation, Swagger/API, rules, or directly observed live Torn state.
- USER_VERIFIED — reproducible user artifact or test result.
- COMMUNITY — community-derived evidence that has not been officially confirmed.
- INFERENCE — a hypothesis or deduction requiring validation.

## Windows execution plan

OpenAI's current Sandbox Agents documentation requires Node.js 22+. On Windows, the supported local path is DockerSandboxClient rather than UnixLocalSandboxClient. The controlled-editing stage therefore targets Docker-backed isolation instead of executing unrestricted shell commands directly on the Windows host.
