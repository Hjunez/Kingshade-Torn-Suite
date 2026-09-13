# Kingshade Codex Instructions

## Knowledge base
Before solving a task, consult `docs/knowledge/README.md` and the source notes relevant to the task.

Use the knowledge base as a retrieval source, not as prompt cargo: read only the sections needed for the current task.

## Source discipline
- Do not invent claims that are not supported by the referenced source or current repository evidence.
- Distinguish verified source material from inference.
- For time-sensitive external facts, verify against current official documentation before relying on them.
- Treat `docs/knowledge/sources.md` as the source-status registry.
- When two sources conflict, prefer current official documentation for tool/platform behavior, and document the conflict.

## Engineering use
For design and implementation work, explicitly consider:
1. Problem specification.
2. Algorithm/approach.
3. Correctness and failure modes.
4. Runtime/resource cost.
5. Verification strategy.

Prefer focused tests first. Do not expand scope, start extra hardening layers, or run full suites unless the task explicitly authorizes it.

## Project safety
Do not merge to `main`, force-push `main`, release, or broaden task scope without explicit authorization.
