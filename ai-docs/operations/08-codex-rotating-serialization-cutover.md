# Rotating Codex Serialization Cutover

This runbook is the release gate for migration
`000060_codex_oauth_setup_serialization`. It supplements the repository release
and git-flow source of truth in
[`07-environments-and-release-management.md`](./07-environments-and-release-management.md).
The cutover is a controlled batch, not an automatic deploy on every change.

## Offline proofs before the batch

Run the exact checked-in migration rehearsal against disposable loopback
PostgreSQL. It creates and destroys its own database, applies migrations only
through `000059`, and then applies the checked-in `000060` file without copying
or rewriting SQL:

```bash
REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL="$LOCAL_POSTGRES_URL" \
  pnpm codex-rotating:migration-rehearsal
REVIEW_ROUTER_TEST_DATABASE_URL="$MIGRATED_LOCAL_TEST_DATABASE_URL" \
  pnpm codex-rotating:loopback-proof
pnpm codex-rotating:installer-portability
pnpm codex-rotating:rollout-proof
```

The loopback proof database must already have all checked-in migrations applied;
the CI quality job creates that disposable database and applies them before the
named proof gate.

The migration rehearsal proves dirty-row ranking and expiry, the partial unique
predicate and SQLSTATE `23505`, consumed history, transaction rollback after an
injected index collision, a clean rerun, and the 15-second held-lock bound. The
installer test uses the operating system's native `flock` on Linux and native
`shlock` on macOS. CI pins installer lock lookup to the native system-command
path and rejects a macOS system path that resolves `flock`, so an added Linux
utility cannot silently replace the `shlock` proof.

No proof command calls GitHub, Render, a provider, or a real repository. The
dropped-response contract uses a loopback HTTP socket, the real confirmation
route/use case, a disposable database, and fake `gh` and `codex` binaries.

## Ordered cutover

Record all timestamps, the exact 40-character application commit, and the
candidate image digest in one evidence JSON document.

1. Deploy the bridge reader and prove every application instance can read the
   pre-migration and post-migration setup forms. Do not activate a new writer in
   this phase. Record the exact bridge commit, its observation time, and the
   passing compatibility probe before the issuance-quiesced timestamp.
2. Quiesce only new setup-manifest issuance. Keep the main rotating OAuth
   capability enabled and keep setup fetch/confirmation live so already-issued
   commands can finish. Main OAuth enablement is prohibited as the drain switch.
3. Record the issuance-quiesced boundary and wait at least 16 complete minutes.
   Do not begin the migration at `15:59.999`.
4. Run `000060_codex_oauth_setup_serialization` once from one controlled
   migration process. A lock timeout is a stopped cutover, not permission for
   concurrent or repeated migration attempts. Inspect the failure and begin a
   new controlled batch only after resolving it. Record the checkout-relative
   migration path and its SHA-256; the verifier hashes the checked-in file and
   rejects substituted SQL.
5. Converge the web, API, and worker application instances on the same exact
   commit. Record each observed commit after the migration completes; a branch,
   tag, or image label is not exact-commit evidence.
6. Run one disposable-repository canary through issuance, fetch, secret write,
   confirmation, and retry behavior. Follow repository hygiene requirements and
   remove the canary after the batch. Start it only after API, web, and worker
   convergence, and bind it to the same exact commit and image digest.
7. Widen issuance only after the disposable canary passes. Preserve the phase
   evidence and run the bounded offline verifier:

```bash
node scripts/verify-codex-rotating-rollout.mjs rollout-evidence.json
```

The verifier performs no polling or network access. It terminates after checking
the bridge, the 16-minute timestamp boundary, one exact migration, exact-commit
convergence, disposable canary ordering, widening, rollback policy, and
compatibility-probe digests.

## Canonical compatibility-probe evidence

The trusted probe emits only its stable result object: policy/version, the two
named case IDs and pass conclusions, reader restart count, candidate image
digest, and candidate source commit. Canonicalize it by recursively sorting
object keys, encoding compact UTF-8 JSON, and appending exactly one newline.
`canonicalJson` in `scripts/verify-codex-rotating-rollout.mjs` is the executable
definition. Record its expected SHA-256 before evaluating the candidate and put
the observed stable object in `compatibilityProbe.result`.

The only accepted policy/version is `codex-rotating-rollback` version `1`. The
case array is ordered and contains exactly
`legacy-manifest-reader-restart` followed by
`v2-manifest-reader-restart`, each with conclusion `pass`. Timestamps, database
URLs, logs, and additional candidate-controlled fields make the result invalid.

Record `compatibilityProbe.sourceFileSha256` separately. It authenticates the
trusted probe implementation named by the checkout-relative
`compatibilityProbe.sourceFile`; it is not the canonical result digest. The
verifier hashes that checked-in source itself, rejects a source mismatch,
rejects an expected result mismatch, and rejects evidence that reuses the
source-file digest as the result digest. Both digests are mandatory.

## Rollback boundary

After `000060` succeeds, rollback is application-only and must remain at or
above the bridge reader. Do not roll back the database. Do not directly roll an
application back to a pre-confirmation/pre-serialization version while any
active v2 setup manifests exist. First quiesce issuance, keep confirmation live,
drain active v2 manifests, and prove the chosen application reader is compatible.
Feature flags and main OAuth disablement do not make a database rollback safe.
