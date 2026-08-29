# External agent code intake

This process applies to external AI-agent code offered for reuse in KS Leslie, including the friend's Jarvis project.

## Goal

Reuse proven components when they materially accelerate the KS Leslie Debug MVP, while preventing inherited secrets, unsafe execution paths, incompatible licenses, architectural coupling, or weaker security boundaries.

## Required intake evidence

Prefer the complete repository or a complete source archive rather than isolated pasted snippets. Preserve the original structure, dependency manifests, lockfiles, documentation, tests, configuration examples, and license files. Do not request or ingest real API keys, cookies, passwords, access tokens, private certificates, or unrelated personal data.

The provider must have the right to share the code for the intended use. Any license or redistribution restrictions must be identified before code is copied into KS Leslie.

## Quarantine review

External code is treated as untrusted until reviewed. Before execution or dependency installation, inspect:

- dependency manifests and lockfiles;
- install, postinstall, prepare, and lifecycle scripts;
- shell/process execution;
- filesystem access and path boundaries;
- network endpoints, webhooks, tunnels, and remote-control mechanisms;
- authentication and session handling;
- secret loading, logging, telemetry, and tracing;
- database and memory persistence;
- Git/GitHub write operations;
- automatic code execution or self-modification;
- update mechanisms;
- embedded credentials, tokens, keys, cookies, or personal data;
- license and provenance.

## Component comparison

Map useful Jarvis components against the KS Leslie critical path:

1. repository intelligence and Git history;
2. baseline/version tracking;
3. local Worker or sandbox execution;
4. test execution and structured result capture;
5. patch/edit workflow;
6. approval gates and rollback handling;
7. persistent memory and retrieval;
8. remote Core/Worker communication;
9. authentication/RBAC;
10. mobile/web client.

A component is a reuse candidate only if it is faster or safer to adapt than the existing Leslie implementation and does not weaken Leslie's invariants.

## Import rules

- Do not replace a verified Leslie component merely because external code is larger or more feature-rich.
- Prefer small, independently testable components over wholesale merges.
- Preserve Leslie's default-deny Worker scope, explicit write approval, stale-baseline protection, evidence taxonomy, and no-gameplay-automation boundary.
- Adapt external code behind Leslie interfaces where possible instead of coupling Leslie to the external architecture.
- Add or port tests before adopting behavior that affects repository writes, shell execution, authentication, memory isolation, or secrets.
- Record original source/provenance and any license obligations for every imported component.

## Acceptance

External code is accepted only after the relevant Leslie tests pass and an independent review confirms that the imported behavior does not bypass Debug MVP gates, repository boundaries, RBAC boundaries, secret handling, or rollback protection.
