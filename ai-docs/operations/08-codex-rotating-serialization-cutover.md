# Fenced rotating OAuth cutover (000060 + 000061)

This is the fail-closed release gate for the ordered combined release
`000060_codex_oauth_setup_serialization` then
`000061_codex_oauth_provider_mutation_fence`. The general release and git-flow
rules remain in
[`07-environments-and-release-management.md`](./07-environments-and-release-management.md).
Never apply only one migration as a completed production rollout.

Production starts with both
`REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=0` and
`REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED=0`. Do not change either
flag during build or migration verification.

## Required offline proof

Use a disposable loopback PostgreSQL **17** server. The command fails when the
URL is absent, non-loopback, `psql` 17 is absent, or any assertion cannot run;
there is no skip or alternate-major path.

```bash
REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL="$LOCAL_POSTGRES_17_URL" \
  pnpm codex-rotating:migration-rehearsal
REVIEW_ROUTER_TEST_DATABASE_URL="$MIGRATED_LOCAL_TEST_DATABASE_URL" \
  pnpm codex-rotating:loopback-proof
pnpm codex-rotating:installer-portability
pnpm codex-rotating:rollout-proof
```

The rehearsal applies the real history through `000059`, seeds canonical and
mismatched identities, duplicate issued and fetched manifests, active and
expired leases, pending intents, quarantine, and recovery cases, then invokes
the Prisma migration runner for the combined release. It observes 000061's
15-second lock timeout after 000060 commits, resolves that failed runner attempt,
injects a late 000061 failure, proves transaction rollback, resolves it, and
successfully reruns. It checks the exact migration-history checksums, catalog
trigger/check/index sets and flags, backfills, zero unsafe active work, and the
surviving fetched marker that pins setup recovery. Its final JSON line is the
database observation artifact; retain it without editing.

## Full-drain bridge sequence

Old binaries cannot coexist with 000061 writes. This sequence is mandatory; a
rolling mixed-version deploy is prohibited.

1. Cut a dedicated bridge release from a pre-000061-schema application base;
   do not deploy the final fence-aware binary as the bridge because it reads
   000061 columns. Backport only the setup-issuance kill switch and actionable
   503 mapping onto that base. The bridge must accept byte-for-byte equivalent
   confirmation replay only when the manifest is already `consumed`; that path
   is read/idempotency behavior, not permission for a new secret write. Prove
   it boots against a schema ending at 000060, then record its exact commit and
   image digest. The bridge is not a post-000061 rollback candidate.
2. Publish both installer v1 and v2 plus the v2 workflow/runtime artifacts before
   issuing any v2 setup command. Verify their immutable digests. Inventory
   queued and in-progress v1 and v2 GitHub workflows by workflow SHA; stop new
   dispatch admission and let or cancel every old queued workflow explicitly.
3. Deploy the bridge everywhere while the database is still pre-000061. First
   set `REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED=0`. A setup-command
   request must return HTTP 503 and
   `codex_rotating_setup_issuance_quiesced`, which tells the caller not to retry
   until operators reopen issuance. Keep confirmation available temporarily so
   already-fetched commands can finish, and wait until the drain queries below
   are zero.
4. Set `REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=0` on API, web, and worker.
   This is the all-mutation kill switch. Exact replay of an already-consumed
   confirmation remains acceptable; no new setup, lease, finalize, writeback,
   recovery, or non-consumed confirmation mutation is admitted. Re-run the
   drain queries and require zeros again. A fetched row never ages out of this
   gate: investigate and recover it; do not mark it expired.
5. Verify the Render services have no `preDeployCommand` (the old deployment
   shape had independent web, API, and worker callers; the checked-in Blueprint
   and deploy helper now clear them). Nominate exactly one `release-migration`
   job and prove no other caller can start. Apply the ordered
   checked-in 000060+000061 batch once. A lock or statement timeout stops the
   batch; inspect it and begin a separately recorded retry, never concurrent
   retries.
6. With both switches still off, converge API, web, and worker to the same exact
   final fence-aware commit and image digest. The minimum rollback floor after
   000061 is this final fence-aware commit. Database rollback is prohibited.
   **`e642d1ed` is not a safe application rollback after 000061.**
7. While global admission is still off, configure an allowlist containing one
   disposable canary repository. Verify the allowlist count is exactly one,
   then deliberately open admission and issuance for that allowlisted scope.
   Prove v1 queued-workflow rejection/compatibility and v2 issuance/fetch/write/
   confirmation/replay using the published artifacts, then remove the canary.
   Only after the artifact-backed proof passes may operators widen the allowlist.

The drain query must be executed on the writer database and captured as an
artifact. Every count, including queued old workflows from the GitHub workflow
inventory, must be zero:

```sql
SELECT
  (SELECT count(*) FROM "CodexOAuthLease"
    WHERE "status" IN ('preleased', 'finalized')) AS active_leases,
  (SELECT count(*) FROM "CodexOAuthSetupManifest"
    WHERE "status" = 'fetched') AS fetched_setups,
  (SELECT count(*) FROM "CodexOAuthWritebackIntent"
    WHERE "status" = 'pending') AS pending_intents;
```

Also capture identity mismatches against `RepositoryConnection`, provider
recovery ownership, `_prisma_migrations`, `pg_trigger`, `pg_constraint`,
`pg_index`, and `pg_indexes`. Do not infer database state from application logs.

## Observation-backed rollout proof

`scripts/verify-codex-rotating-rollout.mjs` accepts only evidence version 2 with
four SHA-256-bound JSON artifacts: database observations, Render API deployment
observations, compatibility-probe output, and the append-only operator command
event log. It derives the result from those observations. Self-reported
`succeeded`, `passed`, commit, or migration booleans at the top level are
rejected.

The database artifact must contain both migration IDs, checked-in source
digests, one current successful runner-history record for each source checksum,
PostgreSQL 17 catalog output, zero unsafe work, and the fetched recovery owner.
The Render API artifact must report API/web/worker exact commits and immutable
image digests with mutation admission off, a null `preDeployCommand`, and no
service-level migration caller. The compatibility artifact is the actual probe
output and has its own byte digest plus the checked-in executable's source
digest. It binds both the exact bridge commit/image and final candidate
commit/image. Each case carries raw observations and a digest that the verifier
recomputes; a `passed` boolean or arbitrary digest is rejected:

- exact consumed-confirmation replay across a reader restart;
- a queued v1 workflow after v2 installer/workflow publication;
- a fence-aware v2 workflow against the candidate image.

The event artifact records the bridge's pre-000061 schema compatibility,
publication-before-issuance, the separate issuance-503 probe, both zero-drain
observations around the full kill switch (including queued old workflows), the
single Render migration caller, ordered migrations, exact service convergence,
canary allowlist/pass, widening, and the rollback floor. The migration and
canary events carry the exact database and compatibility artifact digests
respectively. The publication observation must show zero v2 issuances at the
time the immutable v1 installer, v2 installer, and v2 workflow digests were
captured. Run:

```bash
node scripts/verify-codex-rotating-rollout.mjs rollout-evidence.json
```

Copy raw artifacts before hashing. Never hand-normalize output or fill missing
fields. A missing observation is a failed gate, not an operator attestation.
