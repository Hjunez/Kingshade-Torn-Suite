# Curated knowledge ingestion

This directory is for explicit Torn/Kingshade source manifests and synthetic examples, not a filesystem drop zone and never a secret store.

Each manifest entry must declare its project, knowledge zone, evidence/provenance class, source reference or description, content, and verification state. Entries pass through the same trusted authorization, validation, secret-safety, and durable-store service as other memory writes. Exact duplicates and identifier collisions are handled deterministically.

The parser validates only the manifest it is given. It does not recursively scan this directory or another folder, discover arbitrary local files, read environment files, fetch remote URLs, or turn conversation transcripts into durable memory. A source URL is provenance, not permission to fetch it.

Before persistence, bounded best-effort checks reject likely API keys, tokens, passwords, cookies/session material, authorization headers, private keys, environment-secret assignments, NUL/binary-like payloads, oversized content, and identifiable unrelated personal-data categories. Rejection messages must not echo the rejected value. These checks reduce risk but are not a claim of perfect secret or personal-data detection, so manifests must contain only deliberately curated Torn/Kingshade material.

Official/current, trusted owner/user-verified, community-derived, automated/test, and inference/hypothesis evidence remain distinct. CI, tests, release history, recency, and model inference cannot establish owner verification. Model-originated records remain pending hypotheses until an explicit trusted verification event occurs.

Supersession and invalidation preserve prior records for audit. Conflicting active records remain visible until trusted evidence resolves them; the newest entry does not automatically become known-good.
