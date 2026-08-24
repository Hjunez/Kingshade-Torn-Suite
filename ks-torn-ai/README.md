# KS Leslie

KS Leslie is a dedicated Torn City engineering and research agent. It is intentionally separate from individual userscripts and is designed to become the control plane for research, implementation analysis, review, project memory, and eventually sandboxed repository work.

## v0.1 bootstrap

The first bootstrap contains:

- GPT-5.6 Sol coordinator.
- GPT-5.6 Terra research, engineering, and independent-review specialists.
- Current web research capability for the research specialist.
- Optional OpenAI vector-store/file-search capability for a Torn/Kingshade knowledge base.
- Persistent conversation state using the OpenAI Conversations API.
- Strict TypeScript configuration.
- Vitest, ESLint, and Prettier verification.
- A permanent Torn-specific evidence hierarchy and engineering policy.

It does not yet edit repositories or execute shell commands. Those capabilities are deliberately deferred until the workspace boundary, approvals, rollback rules, and regression test contract are implemented.

## Local start

Requires Node.js 22 or newer.

1. Copy `.env.example` to `.env`.
2. Add an OpenAI API key to `.env`.
3. Install dependencies.
4. Run the verification suite.
5. Start the CLI.

Never commit `.env` or API keys.

## Planned stages

### v0.2 — Knowledge ingestion

Create and maintain a vector store containing curated Torn documentation, Kingshade architecture decisions, verified DOM probes, test evidence, and release notes. Every source receives provenance metadata.

### v0.3 — Read-only repository intelligence

Allow the agent to inspect selected repositories, search source, compare versions, inspect Git history, and reason over test output without modifying files.

### v0.4 — Controlled engineering workspace

Add a Docker-backed sandbox on Windows for file editing, shell commands, tests, patches, snapshots, and resumable workspace state. Repository writes require explicit workspace boundaries and human approval.

### v0.5 — Torn API tools

Add read-only Torn API v2 tools with allowlisted endpoints, minimum-permission custom keys, rate-limit handling, secret redaction, caching awareness, and audit logs.

### v0.6 — Release gate

Add independent review, regression gates, known-good rollback baselines, PDA/browser compatibility profiles, and release-candidate reporting.

### v1.0 — KS Leslie

A persistent Torn-only engineering system that can research current Torn behavior, understand Kingshade projects, inspect and modify code in an isolated workspace, run tests, review itself, and prepare controlled Git changes without performing gameplay actions.
