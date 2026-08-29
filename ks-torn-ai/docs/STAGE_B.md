# Stage B implementation

Stage B connects read-only Repository Intelligence and the controlled local Worker to the KS Leslie agent boundary. It stops before any production Torn userscript change.

## Agent surfaces

Repository Intelligence always exposes six strict read-only tools: project resolution, metadata inspection, bounded source chunks, relevant history, project-scoped ref comparison, and supporting baseline evidence. Local Git is preferred only after top-level and exact GitHub-origin verification; fixed-host GitHub reads are the fallback. Requested refs and resolved full commit SHAs are both returned.

Worker tools are added when trusted application code injects a `WorkerAgentService`, or when the CLI's explicitly configured local repository root passes Worker Doctor. With no configured root, the CLI remains repository-intelligence-only. The CLI does not expose write-grant issuance, so its Worker surface is read-only. Agent inputs can select a registered project, an approved path, a literal search, validated refs, or a registered profile. They cannot select a repository root, process, executable, arbitrary command, write scope, approval token, or patch.

The controlled patch tool requires an SDK approval and a pending one-time application grant bound to the project, repository, current full baseline SHA, isolated branch, approved paths, patch identifier, patch digest, and expiry. Failed or out-of-scope work is cleaned up. A successful candidate remains in its isolated worktree until trusted application code delivers or removes it.

## Test profiles

Available profiles at the Stage B branch:

- `suite-layout`: `node tools/run-suite-validator.mjs`
- `userscript-syntax`: `node tools/check-js-syntax.mjs`
- `leslie-typecheck`, `leslie-tests`, `leslie-lint`, `leslie-format`, and `leslie-verify`: locked install followed by the corresponding `ks-torn-ai` package gate

Discovered but unavailable profiles:

- `kingshade-development-verify`: local-only commits `d8ed012` and `b5dc756`; LF checkout fails 15 of 20 historical integrity fixtures that encode CRLF hashes.
- `war-dibs-desktop`: local-only commit `32e57b2`; it intentionally records red production-baseline regressions.
- `war-dibs-arena-smoke` and `war-dibs-compatibility`: local-only commit `c4e34e0`; both depend on the intentionally red desktop harness.

These historical commits were inspected, not merged. The two portable Node runners were added without modifying userscripts.

## Remaining real-regression gate

Before Leslie prepares its first real Kingshade TEST candidate, the owner must provide or confirm a known-good full baseline and reproducible problem evidence. The workflow must bind a real independent review to the candidate, run the relevant restored regression and PDA/browser profiles, preserve rollback state, and disclose unresolved uncertainty. Passing CI or release history alone does not establish a known-good baseline or PDA compatibility.
