# Trusted pair export (v1)

For an already authorized Linux operator environment only. No deployment, migration,
credential acquisition, upload, or evaluation is performed. This task does not authorize
running the exporter against a database. Later authorized usage with existing dependencies:

```
pnpm exec tsx scripts/export-review-investigation-pair.ts --manifest /protected/pair.json --output /protected/export/pair.json
```

The output directory must already exist, belong to the operator and have mode 0700.
Output is atomically published with mode 0600; existing entries and symlinks are refused.
Findings never go to stdout. Errors are deliberately generic (unavailable or denied);
missing/pruned/retention-expired evidence produces no partial artifact. Reuse TTL and
certificate expiry are preserved and do not prohibit a retained historical export.

An administrator must independently provision the root-owned, non-group/world-writable
file `/etc/reviewrouter/review-investigation-pair-scope.json`, with similarly protected
ancestors and no symlinks. Do not derive this policy from a submitted manifest. Schema:
`{repository:"777genius/review-router-saas-e2e", immutableRepositoryId:"1228051727",
scope:{workspaceId,repositoryConnectionId,scmRepositoryIdentityId,pullRequestNumber,
trustDomain,authorizationScopeHash}, privacyExportAllowed:true, validUntilMs}`.
The administrator must verify the internal SCM identity and connection really map to
GitHub repository 1228051727, authorize this PR/scope and retention/privacy access,
and set a short policy expiry. This is an independent local trust boundary, not a
repository name check. No policy bootstrap or privilege elevation is provided.
The runtime environment supplies restricted DB access through the existing DB factory.

Manifest schema is `PairSelection` in `lib/review-investigation-pair-export.ts`:
version 1, pairing `same_execution`, four exact IDs (`legacyObservationId`,
`shadowEvidenceId`, `investigationId`, `certificateId`), full scope and revision,
and `legacy`/`investigation` objects with every field in the exported `legacyKeys`
and `shadowKeys` lists. Unknown fields, oversized input, wildcards, and separate-run
pairs fail closed. Expected provider and actual model are independent on each side.
Only prompt-only, agentic-unbounded, or context-gateway legacy profiles are permitted.
No discovery or candidate/TTL lookup is used. Reads share a read-only repeatable-read
transaction. Policy authorization is checked before reads and again before building output.

The versioned artifact retains both domain records with separate labels, all available
provenance, canonical certificate, retention metadata, accounting and stored/recomputed
hashes. `exportBodyHash` is SHA-256 of domain `stableJson(body)` UTF-8; byte count uses
those same bytes. It is an integrity checksum, not a signature or metadata authentication.
Shadow authority stays `non_authoritative`. Shadow storage has no separate attempt,
invocation or manifest facts; v1 records that limitation and does not invent them.

Export is not evaluation: `NotCompared` remains explicit. Promotion still needs ground
truth, security assessment and a signed subject bound to exact terminal telemetry.
Never substitute the terminal findings digest for `terminalSamplePayloadHash`.
