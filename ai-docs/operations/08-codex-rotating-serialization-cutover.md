# Fenced rotating OAuth cutover (000060 through 000073)

> `REVIEWROUTER_CODEX_AUTH_JSON` is an unsafe, deprecated stable namespace.
> Its legacy confirmation endpoint is permanently removed and has no runtime
> override. Versioned mode never falls back to or mixes with that path. Deleting a
> versioned GitHub secret does not permit reuse: allocated namespaces and their
> permanent tombstones are retained because GitHub has no compare-and-swap or
> bounded completion guarantee for secret PUTs.

This is the fail-closed release gate for the ordered combined release
`000060_codex_oauth_setup_serialization` then
`000061_codex_oauth_provider_mutation_fence`,
`000062_codex_oauth_remote_outcome_unknown`, then
`000063_codex_oauth_setup_payload_claim`, then
`000064_codex_oauth_versioned_secret_namespaces`, then
`000065_codex_oauth_authority_acl_hardening`, then
`000066_codex_oauth_rotating_cascade_authority`, then
`000069_release_rollout_ledger`. The general release and git-flow
rules remain in
[`07-environments-and-release-management.md`](./07-environments-and-release-management.md).
Never apply only one migration as a completed production rollout.

Before the migration caller applies anything, run
`pnpm codex-rotating:migration-preflight` against the target writer. It fails if
any `_prisma_migrations` row already uses the edited
`000061_codex_oauth_provider_mutation_fence` name, regardless of checksum or
rollback status. Do not resolve, overwrite, or bless such history; stop the
rollout and produce a new forward migration plan.

It also requires the first-release, transaction-wrapped 000063 source checksum
`33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481`.
The earlier non-atomic checksum
`a0693a88ea2c9a60d673e5be48e44047b865fabcecd46b8b66640381b4ed7667`
is not deployed history and must never be marked applied, resolved, or blessed.
If that row exists in a local sandbox, discard and recreate the sandbox database
from a clean baseline before rerunning preflight. If it appears anywhere claimed
to be shared or production, stop the rollout and investigate the provenance;
do not use manual migration-history edits as recovery.

## 000063 first-release migration decision record (2026-08-10)

Repository and deployment evidence establishes that the non-atomic 000063 was
an unpublished local side-branch artifact:

- `origin/main` has no `000063_codex_oauth_setup_payload_claim` path.
- Integration commit `097aa56` has no such migration path.
- Local commit `4750275` is not contained in any remote ref.

Accordingly, the transaction-wrapped migration with checksum
`33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481`
is the first-release 000063 artifact. Its explicit `BEGIN`/`COMMIT` boundary is
part of the release contract: a late statement failure must leave no payload
claim columns, constraints, or index behind, and replay from the unchanged
baseline must succeed. The non-atomic checksum above is rejected rather than
treated as production-safe compatibility history. After this atomic artifact is
merged and released, its checksum is immutable and every later schema repair or
evolution must use a new forward migration.

000063 remains limited to the setup-manifest payload-claim fields, checks, and
recovery-expiry index. Versioned secret namespaces, dispatch attempts, mutation
guard evolution, and all related repair remain in forward 000064; they must not
be moved backward into 000063.

## Immutable migration byte contract

These are the SHA-256 digests of the exact checked-in `migration.sql` bytes.
The migration-history policy is authoritative; this operator-facing projection
is checked against both that policy and the files on every test run.

| Migration                                        | Exact SHA-256                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `000060_codex_oauth_setup_serialization`         | `f24ab69f681349332e47e121adc72bd3edb14e24bcbffcd26fce4f03ba0d7395` |
| `000061_codex_oauth_provider_mutation_fence`     | `bba689c8b80580ec649cc3262fb2ee9c97be758f3c4ab7094c48c84d002aeb30` |
| `000062_codex_oauth_remote_outcome_unknown`      | `0e8bb62933a270d745530f2c4984520e1753f42d8531c24ffdfa4acfe46a73f4` |
| `000063_codex_oauth_setup_payload_claim`         | `33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481` |
| `000064_codex_oauth_versioned_secret_namespaces` | `4da4352108efd684a8bc6ddefa19353181a8a74758c32ed890527c2aec2ae666` |
| `000065_codex_oauth_authority_acl_hardening`     | `ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c` |
| `000066_codex_oauth_rotating_cascade_authority`  | `3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8` |
| `000073_codex_oauth_active_namespace_refresh`    | `3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6` |
| `000069_release_rollout_ledger`                  | `82356ad61a366e22a15f4e53dabf8c97e14bad97c5970ef28710fe9367c06a05` |

## 000069 no-op marker policy

`000066_codex_oauth_rotating_cascade_authority` is immutable at checksum
`3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8`.
`000069_release_rollout_ledger` is the unpublished immutable no-op marker for
this release. Its exact checked-in SHA-256 is
`82356ad61a366e22a15f4e53dabf8c97e14bad97c5970ef28710fe9367c06a05`.
Before its first publication, migration preflight hashes those exact bytes and
rejects every existing `_prisma_migrations` row named
`000069_release_rollout_ledger`, including failed, rolled-back, duplicate, or
apparently successful rows. It also fails closed on the obsolete
`000067_release_rollout_ledger` alias. Do not resolve or bless an early or
aliased row; stop and investigate its provenance.

The one immutable application release-migration caller may then register those
pinned no-op bytes as the final member of the drained combined release.
Post-release verification
requires exactly one current successful 000069 row with that checksum and one
applied step. After the first production publication is accepted, the next
release must deliberately reclassify this digest from `forwardUnpublished` to
the immutable-history set and replace the reject-any prepublication rule with
the same allow-one-exact rule used by released migrations. Until that explicit
handoff is checked in and tested, preflight intentionally blocks every later
release rather than guessing that publication occurred. Any later schema
change uses a new forward migration; never edit migrations 000064 through
000069 after publication.

The marker creates no ledger, authority tables, functions, or roles in either
the source or target application database. Release rollout state and the
`reviewrouter_release_control` and `reviewrouter_release_witness` capabilities
belong exclusively to the dedicated external PostgreSQL 17 Release Authority
under `packages/platform/release-authority-db`; they are not copied during the
PG16 to PG17 application database cutover.

Migration 000065 owns the application database authority for provider-effect evidence.
Hosted runtime roles have no access to
`CodexOAuthDatabaseAuthorityKey` or `CodexOAuthDatabaseAuthorityReceipt`,
cannot delete rotating evidence, and cannot sign an authority challenge. The
separate `reviewrouter_codex_effect_authority` login has no table privileges and
can execute only the signing function; its URL is supplied to web and API as
`REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL`. Each signature and receipt
is bound to the runtime login role, backend, transaction, exact attempt/intent
owner, effect, and response code, then consumed by the evidence trigger. Direct
table DML—including a sequence of otherwise legal intermediate transitions—or
direct invocation of a runtime authorization function cannot mint terminal
provider success. The PostgreSQL 17 rehearsal runs that sequential attack with
a forged signature under API, web, and worker roles and also exercises the real
Prisma production writer paths.

Provider identity repair is likewise bound to a signer-backed, transaction-local
authority receipt. An unresolved quarantine row plus attacker-selected recovery
owner fields is insufficient. Runtime roles have read-only quarantine access;
only the web recovery path can invoke the narrowly scoped repair function. The
repair function consumes the exact receipt before any provider or repository
write, and the provider identity guard verifies that consumed authority. Authority
receipts permit only their initial consume transition: after consumption, the
same signature cannot reauthorize the effect in the same transaction. Release
ACL convergence explicitly removes stale table and column ACLs, preserves
`RepositoryConnection` as SELECT-only for runtime roles, and never restores
DELETE on rotating evidence.

GitHub does not issue a database-verifiable receipt for a secret PUT. The exact
residual assumption is that only the reviewed web/API provider-effect adapters
receive the isolated signer credential and request a signature after their
definite provider result; compromise of both a runtime database credential and
the isolated signer credential can still fabricate evidence. Readiness and the
catalog verifier fail closed unless the signer is a distinct non-owner login on
the same database generation, has no table/DDL privileges or role memberships,
and has only its exact function grant.

## Database recovery witness

Every API and web writer must receive the same
`REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS`: a cryptographically random,
base64url value of at least 32 bytes. Rotate it to a never-used value before a
restored snapshot or promoted writer is allowed to receive traffic. Durable
setup claims and runtime writeback intents store only its SHA-256 fingerprint;
confirmation and activation fail closed if the current fingerprint differs or
the witness is unavailable.

The value is an explicit runtime secret, not a build input. Configure it once
in the shared Render environment group or self-hosted common env file, then
restart every web/API writer from that same value. Deployment and readiness
must reject a missing, malformed, or placeholder value before traffic or any
host mutation. Logs, dry-run output, support diagnostics, and thrown errors may
name the variable but must never contain its value.

`pg_control_system().system_identifier` remains useful cluster identity but is
not a restore or promotion witness. The residual assumption is explicit: the
infrastructure control plane must serialize writer promotion/restore and never
reuse or copy an environment witness into a new writer generation. If two
writable database generations are exposed with the same witness, this protocol
cannot distinguish them. Keep traffic disabled until the witness is rotated
and all writer processes restart with the new value.

For a restore or writer promotion, use this exact sequence:

1. Quiesce API, web, worker, installers, and runtime jobs while the old writer
   still uses witness W1.
2. Restore/promote the database with traffic disabled, generate never-used W2,
   configure every writer with W2, and restart them. Automatic runtime work is
   expected to remain blocked on persisted W1 fingerprints and must perform no
   provider write.
3. In the protected private-network rollout, the role-bootstrap runner
   initializes the database comment binding immediately after `pg_restore` and
   before role bootstrap or migration. The one-shot requires the exact PG17
   `system_identifier`, the expected restored W1 binding (including the legacy
   witness-only form, or an unbound fresh target), and W2's SHA-256. It is
   idempotent only for that exact target binding and rejects malformed, foreign,
   or differently bound database comments.
4. Submit the operator recovery with a stable `recoveryRequestId` and the exact
   acknowledgement `all_prior_installers_and_writers_are_stopped` (or the
   distinct account-switch acknowledgement when that mode is intended).
5. Under the provider lock, recovery permanently retires W1 active,
   dispatch-authorized, confirmed-candidate, and remote-unknown namespaces,
   preserves their W1 fingerprints, and advances the mutation fence. A missing
   acknowledgement or partial retirement fails closed and allocates nothing.
6. Fetch the new recovery manifest and complete setup. Its claim and fresh,
   never-reused namespace carry only the W2 fingerprint. Keep runtime traffic
   disabled until that W2 namespace is definitely written, workflow-attested,
   and active; only then does W2 runtime become usable.

Never rewrite W1 evidence to W2, reuse a W1 namespace/ciphertext, or repair the
rotation with direct database edits.

The remaining trust is narrow and explicit: the protected GitHub Actions
environment must keep the bootstrap and release database credentials secret;
the exact checked-out workflow SHA is the only database-mutation caller. Render
is read-only evidence here: its authenticated API must truthfully bind the
runtime service/deploy IDs to immutable commit and image digests. The database
provider must protect the release credential and report `pg_control_system()`
honestly, and the operator must admit a new witness hash in the
database-owner-only generation comment only while all prior writers are
stopped. The proof does not claim to defeat a compromised GitHub environment,
Render control plane, database superuser, or operator holding the release
credential. It does prevent web/API/worker credentials and arbitrary
environment/application-name labels from forging the accepted rollout identity.

Production starts with both
`REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=0` and
`REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED=0`, with
`REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED=0`. Setup issuance accepts
only the exact value `1`; missing, misspelled, and truthy alternatives remain
closed. Do not change any flag during build or migration verification.

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
successfully reruns. A separate late-failure matrix retains both 000063 and
000064, proves each leaves zero partial catalog state after rollback, removes
only the injected collision, and proves clean replay through the migration
runner. It checks the exact migration-history checksums, catalog
trigger/check/index/foreign-key sets and flags, deterministic historical
unknown-outcome provenance, the recovery ledger, exact-payload claim, zero
unsafe active work, and the bounded fetched recovery marker. Its final JSON line is the
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
2. Publish the required installer and workflow/runtime artifacts, including the
   current V4 versioned-namespace workflow, before issuing a setup command.
   Verify their immutable digests. Inventory queued and in-progress GitHub
   workflows by workflow SHA across every supported/deployed schema v1 through
   v4. Each observation must explicitly cover all four schemas even when a
   schema has zero runs; an unknown future schema or omitted schema blocks the
   drain. Stop new dispatch admission and let or cancel every old queued
   workflow explicitly.
3. Deploy the bridge everywhere while the database is still pre-000061. First
   set `REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED=0`. A setup-command
   request must return HTTP 503 and
   `codex_rotating_setup_issuance_quiesced`, which tells the caller not to retry
   until operators reopen issuance. Keep confirmation available temporarily so
   already-fetched commands can finish, and wait until the drain queries below
   are zero.
4. Set `REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED=0` on API, web,
   and worker. This independent fence blocks new preleases without disabling
   confirmation. The final policy assertion occurs while the provider row is
   locked in the lease-creation transaction, closing the check-to-lease race.
   The writer-database `writerInFlight` count is the observable barrier. Then
   keep `REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=0` for convergence. Exact replay of an already-consumed
   confirmation remains acceptable; no new setup, lease, finalize, writeback,
   recovery, or non-consumed confirmation mutation is admitted. Re-run the
   drain queries and require zeros again. A fetched row never ages out of this
   gate: investigate and recover it; do not mark it expired.
5. Verify the Render services have no `preDeployCommand` (the old deployment
   shape had independent web, API, and worker callers; the checked-in Blueprint
   and deploy helper now clear them). Dispatch the protected
   `codex-rotating-release-migration.yml` workflow at the exact release SHA.
   Role bootstrap and release migration share the repository-wide
   `codex-rotating-database-mutation-production` concurrency group with
   cancellation disabled, so only one database mutation can run. Apply the
   exact ordered checked-in 000060 through 000066 plus 000069 batch once. A lock or
   statement timeout stops the batch; inspect it and begin a separately
   recorded retry, never concurrent retries.
6. With both switches still off, converge API, web, and worker to the same exact
   final fence-aware commit and image digest. The minimum rollback floor after
   000061 is this final fence-aware commit. Database rollback is prohibited.
   **`e642d1ed` is not a safe application rollback after 000061.**
7. While runtime, new-work admission, and setup issuance are all still off,
   configure an allowlist containing one disposable canary repository. Verify
   the allowlist count is exactly one, then deliberately set all three flags to
   exact `1` for that allowlisted scope.
   Prove legacy queued-workflow rejection/compatibility and V4 versioned-
   namespace issuance/fetch/write/attestation/activation/replay using the
   published artifacts. Return all three flags to
   `0` before deleting the canary allowlist. Only after the artifact-backed proof
   passes may operators configure a nonempty explicitly approved widening
   cohort and reopen both flags. Clearing the allowlist while either admission
   flag is on is a terminal abort.

The drain query must be executed on the writer database and captured as an
artifact. Every count, including queued old workflows from the GitHub workflow
inventory, must be zero:

Run the checked-in capture executable after the protected immutable
release-migration workflow. Its `current_user` and `session_user` must both be
`reviewrouter_release_migration`; `application_name` and caller-provided
commit/image labels have no evidentiary value. Save the raw read-only Render API
observations for the PostgreSQL resource and the three runtime deploys. Render
must never receive a bootstrap or migration database credential. Redirect
stdout directly to the artifact file without editing it.

The two protected GitHub workflows require two explicit database connections.
`REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL` authenticates as
`reviewrouter_role_bootstrap` and is used only to create and converge the five
canonical roles and retain database ownership while transferring schema and
migration-object ownership to the release role. The bootstrap identity remains
the database owner and is deliberately limited to LOGIN, NOSUPERUSER,
NOCREATEDB, CREATEROLE. The bootstrap workflow then drops that connection. The
release workflow performs preflight, migrations, grant convergence, and
evidence queries through `REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL`,
authenticated directly as the LOGIN, NOCREATEROLE
`reviewrouter_release_migration` role. Both URLs must name the same explicit
host, port, and database; they are never interchangeable and there is no
ambient owner or superuser fallback. Never put the bootstrap URL in the normal
runtime-deploy process environment or a general-purpose env file. Invoke the
runtime deploy only with `pnpm deploy:render:hosted-beta`: its POSIX shell
boundary unsets the bootstrap key before Node starts. The Node entrypoint reads
only `REVIEW_ROUTER_RENDER_RUNTIME_DEPLOY_ENV_FILE` (defaulting to the dedicated
`.env.render-runtime-deploy`) and fails closed if that file contains the
bootstrap key. Bootstrap credentials remain exclusive to the protected
role-bootstrap workflow.

PostgreSQL 17 automatically records one ADMIN membership from each role created
by a CREATEROLE login back to that creator. The recorded grantor is the single
external role authority from which the bootstrap received creation authority,
not the bootstrap itself. This edge cannot be revoked by the bootstrap. The
bootstrap and rollout verifiers therefore require exactly five such edges, one
per canonical role, all from the same non-runtime authority with ADMIN=true,
INHERIT=false, and SET=false. A second grantor, missing role, extra membership,
or changed option blocks the transaction and rollout.

```bash
REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION=1 \
REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL="$PRODUCTION_WRITER_URL" \
REVIEW_ROUTER_RENDER_OBSERVATION_PATH="$RAW_RENDER_OBSERVATION_JSON" \
pnpm codex-rotating:production-writer-observation > production-writer.json
```

```sql
SELECT
  (SELECT count(*) FROM "CodexOAuthLease"
    WHERE "status" IN ('preleased', 'finalized')) AS active_leases,
  (SELECT count(*) FROM "CodexOAuthSetupManifest"
    WHERE "status" = 'fetched') AS fetched_setups,
  (SELECT count(*) FROM "CodexOAuthWritebackIntent"
    WHERE "status" = 'pending') AS pending_intents,
  (SELECT count(*) FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = 1381126735
      AND objid = 1129271119
      AND mode = 'ShareLock'
      AND granted) AS writer_in_flight;
```

Also capture identity mismatches against `RepositoryConnection`, provider
recovery ownership, `_prisma_migrations`, `pg_trigger`, `pg_constraint`,
`pg_index`, and `pg_indexes`. Do not infer database state from application logs.

## Observation-backed rollout proof

`scripts/verify-codex-rotating-rollout.mjs` accepts only receipt-bound rollout
evidence version 3 with six SHA-256-bound JSON artifacts: production-writer database observations,
Render API deployments, compatibility-probe output, two GitHub Actions run
inventories, canary-runtime evidence, and the append-only transition log. It
derives the result from those observations. Self-reported
`succeeded`, `passed`, commit, or migration booleans at the top level are
rejected.

The database artifact must identify the actual database (`current_database`,
server address, and system identifier), prove `NOT pg_is_in_recovery()`,
prove the canonical release role exclusively owns database/schema DDL,
migration history, rotating tables, and functions, and prove the three distinct
runtime roles plus isolated effect-authority role cannot create database/schema
objects, own catalog objects, use DDL table privileges, or assume the release
migration role. The provider identity trigger is the one configuration-table
boundary that runs as `reviewrouter_release_migration`. The function remains
`SECURITY DEFINER`, owned by the canonical release role, with
`search_path = pg_catalog, public` and schema-qualified protected objects. The
release role owns the catalog and therefore retains its implicit full
`RepositoryConnection` `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges;
owner privileges must never be narrowed. Runtime roles retain table-level
`SELECT` only, cannot execute the trigger function directly, and have neither
membership nor `SET ROLE` reachability to the release role. The isolated effect
role has no `RepositoryConnection` access. The PG17 rehearsal is intentionally
different only in fixture mechanics: migrations run as its superuser, so its
synthetic NOLOGIN release function owner receives explicit full DML and
reference privileges on public tables plus usage, read, and update privileges
on public sequences to reproduce the production owner's effective data access.
It identifies the immutable caller from the consumed GitHub Actions migration
receipt, cross-binds that receipt's rollout ID, commit, and image digest to the
authenticated runtime deployment observation, and contains two time-separated
stable zero drain observations.
The base observation and both drain samples independently report the same
database identity, writer status, and SHA-256 fingerprint from the
database-owner-only generation-binding comment. Every admitted durable recovery
witness and database-incarnation value must equal that stored binding.
The recovery owner must be an identity production can create:
`setup-recovery:*` or the migration-owned
`versioned-namespace-cutover:*`. It must also contain all five ordered migration IDs, checked-in source
digests, one current successful runner-history record for each source checksum,
PostgreSQL 17 catalog output, zero unsafe work, recovery-ledger constraints and
foreign keys, payload-claim/recovery-window constraints, and the fetched
recovery owner.
Its descriptor must bind the exact checked-in production-writer capture
executable and source digest; rehearsal output or an operator-authored success
boolean is not accepted.
The Render API artifact must report the real `reviewrouter-api`,
`reviewrouter-web`, and `reviewrouter-worker` service names, their canonical
API/web/worker roles, immutable Render service/deploy IDs, exact commits, and
immutable image digests with mutation admission off, a null `preDeployCommand`,
and no service-level migration caller. It contains no migration job: Render is
not a database-mutation authority. Fresh hosted databases and existing
`reviewrouter-db` instances must use PostgreSQL 17; `render.yaml` pins
`postgresMajorVersion: "17"`, and the API helper independently rejects a
mismatch. The compatibility artifact is the actual probe
output and has its own byte digest plus the checked-in executable's source
digest. It binds both the exact bridge commit/image and final candidate
commit/image. Each case carries raw observations and a digest that the verifier
recomputes; a `passed` boolean or arbitrary digest is rejected:

- exact consumed-confirmation replay across a reader restart;
- a queued v1 workflow after v2 installer/workflow publication;
- a fence-aware v2 workflow against the candidate image.

The GitHub inventory must explicitly cover every supported/deployed schema v1
through v4 in both samples and list every queued/in-progress run with run ID,
workflow path, workflow schema, and head SHA. It must reject unknown schemas and
prove no new arrival; an omitted zero-count schema is not drain evidence. Canary
runtime evidence binds the exact installer-v1, installer-v2, workflow-v2,
runtime-publication, commit, and image digests retained by this bridge proof.

The event artifact records the bridge's pre-000061 schema compatibility,
publication-before-issuance, the separate issuance-503 probe, both zero-drain
observations around the full kill switch (including queued old workflows), the
single receipt-bound GitHub migration caller, ordered migrations, exact service convergence,
canary allowlist/pass/close/delete, an explicit nonempty widening cohort, and
the rollback floor. The migration and
canary events carry the exact database and compatibility artifact digests
respectively. The publication observation must show zero v2 issuances at the
time the immutable v1 installer, v2 installer, and v2 workflow digests were
captured. Run:

```bash
node scripts/verify-codex-rotating-rollout.mjs rollout-evidence.json
```

Copy raw artifacts before hashing. Never hand-normalize output or fill missing
fields. A missing observation is a failed gate, not an operator attestation.
