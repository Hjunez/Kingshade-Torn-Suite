# Phase C2 persistent project memory

## Purpose and boundary

Phase C2 adds durable, structured Torn/Kingshade project memory. It records deliberately submitted facts, decisions, evidence, baselines, failures, verification results, architecture and security decisions, and curated Torn notes across Leslie restarts.

It is not a conversation transcript, an automatic chat summary, an arbitrary filesystem index, a general personal knowledge base, or proof that a claim is true. It does not implement the full multi-user/faction RBAC product or the Debug MVP orchestration state machine, and it does not make KS Leslie complete.

## Conversation continuity versus project memory

OpenAI Conversations state and durable project memory are separate:

- Conversation state stores the identifier used to continue dialogue.
- Project memory stores schema-validated records under the configured Leslie state directory in a separate durable store.

Opening or continuing a conversation does not grant access to project memory. Leslie does not silently persist whole transcripts or auto-summarize every chat into permanent records.

## Durable records

Each record has a stable identifier, project, semantic category, knowledge zone, factual content or summary, evidence/provenance class, source reference or description, creation and update timestamps, verification state, and active or invalidated lifecycle state. Owner and faction/tenant scope are required where their zones need them. A record may identify another record that it supersedes or invalidates.

The store validates its schema on reads and writes, handles duplicate identifiers deterministically, bounds record and store growth, and reports corruption rather than silently dropping it. Durable updates use crash-resistant replacement behavior. Tests use temporary directories and do not depend on conversations, models, or network calls.

Supersession and invalidation preserve the earlier record for audit. Contradictory active records remain visibly conflicting unless trusted evidence resolves them. Recency alone never selects a known-good baseline.

## Trusted access and pre-ranking authorization

The application supplies a trusted access context containing actor identity, role/capability identity, project grants, allowed knowledge zones, and relevant owner or faction/tenant scope. Model tool input cannot choose or escalate this authority.

Authorization is default-deny. Missing context, unknown zones, ungranted projects, mismatched `USER_PRIVATE` ownership, and mismatched `FACTION_SHARED` faction/tenant scope are rejected. `PRIVATE_KINGSHADE_DEV` cannot be returned to a public or advisor-style context.

The retrieval service applies these authorization filters before text matching, scoring, ranking, limiting, or summary construction. Consequently, an unauthorized record cannot affect which authorized records are returned or how they rank.

The local CLI's explicit `OWNER_DEVELOPER` context is only the minimal trusted Phase C2 runtime boundary. It is not full user management, faction administration, sharing, or multi-user RBAC.

## Provenance and verification

Memory keeps distinct provenance for:

- official/current Torn evidence;
- explicit trusted owner/user verification;
- community-derived evidence;
- automated tests and CI evidence; and
- inference or hypothesis.

Only explicit trusted owner/user-verification evidence can establish owner verification. A passing test or CI run, release record, newest commit, persisted claim, or model inference cannot do so. Automated evidence may support or invalidate a candidate, while inference remains labeled as hypothesis.

Model-originated writes remain pending hypotheses. They cannot request an owner-verified state or gain authority by selecting actor, role, project grants, zones, owner, or faction fields.

C4.9 workflow outcomes preserve `KNOWN_GOOD` and `DEFECT_REFERENCE` as distinct modes. Exception records retain the exact SHA/version, owner acknowledgement that the reference is not known-good, historical search boundary, reproducible defect provenance, known pre-existing defects and unrelated failures, selection reason, rollback semantics, separate write-decision provenance, verification, and independent-review outcome. Synthetic persistence remains `SUPPORTING`; reading the record back cannot promote a defect reference to owner-verified known-good.

## Curated manifests

Curated ingestion accepts a bounded, schema-validated manifest whose entries explicitly declare project, knowledge zone, provenance, source, content, and verification state. The service supports deterministic validation and collision behavior, and every accepted entry follows the same authorization, content-safety, and durable-write path as direct memory records.

The manifest parser does not recursively scan folders, discover arbitrary files, read environment files, fetch remote URLs, or ingest binary blobs. A URL may describe provenance but is never fetched by the parser. Repository fixtures contain synthetic examples only, not private Kingshade evidence or real user data.

## Content safety

Before persistence, the memory service validates content type and length and rejects NUL/binary-like data. Layered best-effort checks cover common API keys, access tokens, passwords, cookies and session material, authorization headers, private keys, environment-secret assignments, and identifiable unrelated personal-data categories.

Secret and personal-data detection is not perfect, so ingestion remains a strict curated process. Rejection errors state the category of failure without logging or echoing the rejected value.

## Agent boundary

Each Core agent receives only the memory capability and fixed application context appropriate to its role. Retrieval does not widen Repository Intelligence or Worker permissions. Torn Review remains read-only, Torn Engineering cannot convert memory access into Worker approval, and Torn Research does not inherit private access merely because the coordinator has it.

The full Debug MVP verification/repair orchestration, a real userscript regression, War Dibs work, mobile/PWA, and complete faction or multi-user RBAC remain later bounded milestones.
