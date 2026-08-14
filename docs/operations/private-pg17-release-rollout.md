# Private PostgreSQL 17 Release Rollout

Production runbook for
`.github/workflows/private-network-pg17-rollout.yml`. Architecture boundaries
are fixed by
[`ADR-private-pg17-release-authority.md`](../adr/ADR-private-pg17-release-authority.md).

## Safety rules

1. Never test runner provisioning/assignment, terminal/runtime behavior,
   migration, cutover, or smoke flow in a real user repository or project. Use
   a new disposable test repository/project and disposable databases.
2. Never write, rotate, or repair secrets directly with `gh secret set`,
   provider APIs/dashboards, SQL, or ad hoc scripts. Use the approved secret
   manager and protected-environment provisioning path.
3. Never copy, restore, clone, promote, or roll back the Release Authority DB
   with an application DB, or expose its URLs to a private runner.
4. Dispatch only exact protected `main` commits. `rollout_id` is globally
   unique and never reused, including after failure. Always dispatch with
   `--ref main`; environment branch restrictions evaluate this workflow ref,
   not the separately supplied `expected_sha`.
5. After ambiguity, never manually resume writers or rerun activation. Reconcile
   durable authority and the target receipt first.

## Identities

| Boundary           | Connection                                                         | Allowed authority                                     |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Control            | `REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL`             | Control routines; no direct tables                    |
| Provider authority | `REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL`            | Provider decision routine only                        |
| Witness            | Dedicated read-only authority, source, and target connections      | Cleanup plus signed release-binding observations      |
| Permit installer   | `REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL` on target | `install_activation_permit` only                      |
| Receipt guard      | Target-local, no login/membership edges                            | Own permit, activation, and receipt functions         |
| Release migration  | `REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL`                     | Migrate and invoke activation; cannot install permits |
| Runtime roles      | API/web/worker/effect-authority URLs                               | Normal least-privilege runtime work                   |

Control, provider authority, and witness must use exactly three distinct HTTP
bearer credentials and distinct database roles. Their plaintext secret names
are `REVIEW_ROUTER_RELEASE_CONTROL_TOKEN`,
`REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN`, and
`REVIEW_ROUTER_RELEASE_WITNESS_TOKEN`. Control and witness must be healthy and
resolve from `REVIEW_ROUTER_RELEASE_CONTROL_URL` and
`REVIEW_ROUTER_RELEASE_WITNESS_URL` to different services. Do not provision
`REVIEW_ROUTER_RUNNER_LEDGER_*` or `REVIEW_ROUTER_RUNNER_WITNESS_*` repository
values; those are adapter-local environment names populated from the canonical
release service values by the workflows.

## Configuration matrix

Repository variables:

| Group             | Variables                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow identity | `REVIEW_ROUTER_RELEASE_CONTROL_ORG`, `REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY`, release-witness signing key ID and public key                                                        |
| Service origins   | `REVIEW_ROUTER_RELEASE_CONTROL_URL`, `REVIEW_ROUTER_RELEASE_WITNESS_URL`                                                                                                              |
| Runners           | `REVIEW_ROUTER_RUNNER_GROUP_ID`, `REVIEW_ROUTER_RUNNER_GROUP_NAME`, `REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID`                                                                            |
| Provider          | `REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS`, `RENDER_OWNER_ID`                                                                                                                          |
| Generations       | source/target `RENDER_DATABASE_ID`, `INTERNAL_HOSTNAME`, `DATABASE_NAME`, `DATABASE_SYSTEM_IDENTIFIER`, `RECOVERY_WITNESS_SHA256`                                                     |
| Release           | `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, `REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON`, source/source-fenced/target-equivalence/target-preactivation/target principal policy JSON |
| Canary            | `REVIEW_ROUTER_LIVE_CANARY_URL`                                                                                                                                                       |

`REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS` has one canonical encoding in every
phase: a compact JSON array of unique Render service IDs, for example
`["srv-api123","srv-worker456"]`. It must contain 1-100 sorted lowercase
`srv-` IDs with no whitespace, duplicate entries, CSV encoding, or surrounding object.
Freeze, cutover, and compensation all fail closed on any other value.

The five principal-policy variables are canonical `EffectivePrincipalPolicy`
version 1 documents, not discovered allowlists. They name every approved login
and non-login role plus the exact database, schema, relation, column, sequence,
routine, ownership, and administrative capabilities allowed in that phase.
Quoted PostgreSQL names are represented literally in JSON. Generate and review
them from a disposable, production-shaped catalog; never copy live discovery
output into the allowlist without review.

Activation principal evidence uses a single-session staged transaction. The
CLI validates the reviewed pre-activation policy against the observed target
inventory and validates the activated policy against a rollback-only preview
of the canonical grants. That validator and SQL generator execute from the
exact release commit named by the independently installed permit; the guard
also requires the target's consumed migration evidence for that commit before
it can finalize the attestation. In the committing transaction, the target guard
locks the one-shot permit, compares a fresh pre-grant inventory with the exact
validated inventory, and stages both canonical inventories, both canonical
policies, and their four independently recomputed digests with the permit and
target identity. After the grants, the guard compares a fresh activated
inventory with that stage and accepts activation only when the stage's
transaction ID is the current transaction. The immutable receipt binds those
digests into its first-write hash beside the migration and catalog facts. A
rollback removes the stage; a committed receipt can be returned directly on
replay or reconstructed by the receipt reader without observing the catalogs
again. Missing, malformed, swapped, or stale evidence therefore fails closed.
The activation SQL generator also pins the SHA-256 trust root of the exact
effective-principal catalog projection, so a weaker observation query cannot
be substituted at either preview or commit time.

Protected environment secrets:

| Environment                     | Secrets                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production-release-preflight`  | release-control token                                                                                                                                                                   |
| `production-runner-control`     | release-control, provider-authority, and release-witness tokens; suspension and/or runner-control key per job                                                                           |
| `production-role-bootstrap`     | release-control and provider-authority tokens, provenance key, source compensation/copy URL, reconnect URLs, role-bootstrap/release-migration URLs, target runtime URLs, backup witness |
| `production-runner-ledger-read` | release-control token                                                                                                                                                                   |
| `production`                    | release-control and provider-authority tokens, target-switch key, release-migration and target runtime URLs                                                                             |
| `production-service-switch`     | release-control, provider-authority, and release-witness tokens; suspension key and live-canary token                                                                                   |

Every environment in this table must exist, require at least one reviewer,
prevent self-review, and allow protected branches only. `main` must be a
protected branch. These are external GitHub settings: the workflow's read-only
bootstrap verifies all of them before checkout, but it never configures them.

Server-only service values:

| Service | Values                                                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control | authority control DB URL, provider-authority DB URL, distinct `REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256` and `REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256`, permit-installer and receipt-reader DB URLs                                                           |
| Witness | authority/source/target read-only DB URLs; canonical source/authority/target identities and generations; authority catalog/migration and activation routine trust roots; GitHub/Render read tokens; `REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256`; Ed25519 signing key |

The witness private key is server-only. The matching public key, key ID, and
freshness interval are protected repository variables consumed by the final
evidence job. Rotate the key pair as one reviewed change; evidence signed by a
missing or different key, or assembled after its expiry, fails closed.

Actions receives the three scoped plaintext tokens; services store only their
SHA-256 values. Logs and artifacts may contain IDs/digests, never URLs, tokens,
passwords, backup material, or raw recovery witnesses.

The release workflow emits `hosted-runtime-image-<version>` and signs the
identity file with GitHub artifact attestation. Record its successful workflow
run ID and artifact ID from the release summary. Supply those immutable IDs as
`release_run_id` and `release_artifact_id` with the exact `expected_sha` when
dispatching the PG17 workflow. Do not configure or pass a release-image digest
variable: preflight derives the only accepted image digest from the attested
identity and verifies repository, release workflow/ref/run, exact commit, OCI
digest, and immutable URL before rollout claim or the first mutation. The same
verified identity is embedded in final trusted evidence.

Before any checkout or repository-controlled command, the inline bootstrap
also requires the workflow ref to be `refs/heads/main`, requires `github.sha`,
current protected `main`, and `expected_sha` to be identical, and verifies that
the successful attempt-1 release run and unexpired artifact IDs belong to that
same SHA. Every later checkout uses only the bootstrap output with persisted
credentials disabled. If bootstrap or protected preflight fails or is skipped,
no downstream job—including always-reconcile—can start or receive production
secrets. Reconciliation remains unconditional only after those two trust gates
succeed, so it still runs after a later mutation-phase failure.

The GitHub workflow, ref, GHCR repository, and artifact-attestation rules are
infrastructure policy owned by the preflight verifier. The domain record stores
the provider-neutral v2 claim: source repository/revision, OCI image repository
and digest, build run, artifact identity, identity hash, and the hash of the
verification policy. Trusted rollout evidence schema 7 adds the independently
signed, freshness-bounded release-witness binding. Schema 6 and earlier
artifacts remain historical records and must not be submitted to the schema 7
verifier or upgraded without rerunning the current rollout and witness observation.

## Fresh authority installation (provision once)

1. Create a fresh dedicated PostgreSQL 17 authority DB and the distinct
   `reviewrouter_release_control`, `reviewrouter_provider_authority`, and
   `reviewrouter_release_witness` logins. Put the direct database-owner
   connection URL in a mode-0600 credential file. The session must log in as
   that owner rather than using `SET ROLE`. Invoke only the explicit fresh
   installation command:

   ```bash
   export REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE=/approved/secret/path/release-authority-migration-url
   pnpm release-authority:fresh-install
   ```

   The fresh gate requires the `release_authority` schema to be absent and
   applies the complete checked-in chain in one transaction. It rejects an
   existing authority catalog, a non-owner or role-switched session, source
   checksum mismatch, and a concurrent migration caller. Never use this
   command for an upgrade and never substitute application Prisma migration
   tooling. Retain this DB across cutovers.

2. Deploy control and witness from the same immutable release and verify their
   `/health` service identities. Healthy control must observe the 000002
   `release_runner_prepare_effect`, `release_runner_acquire_dispatch_permit`,
   `release_runner_reconcile_effect`, and `release_runner_abandon_prepared`
   routines; healthy witness must observe the 000002 effect snapshot routine.
   Healthy control must also expose the 000003 source-freeze prepare, record,
   complete, and compensation-checkpoint routines before rollout use.
   Configure release-control with independently captured authority and target
   database identities: each tuple contains `system_identifier`, the database
   OID, and `current_database()`. Also configure the exact authority owner role,
   activation migration-manifest digest, activation namespace fingerprint, and
   activation routine body hashes from the immutable release. These values are
   catalog evidence, not credentials or connection strings. Obtain the two
   routine hashes from the checked-out release without querying the target:

   ```bash
   node -e "import('./scripts/run-codex-rotating-release-migration.mjs').then(m => console.log(m.activationRoutineBodyTrustRoots()))"
   ```

   Set `REVIEW_ROUTER_RELEASE_AUTHORITY_SYSTEM_IDENTIFIER`,
   `REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_OID`,
   `REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_NAME`,
   `REVIEW_ROUTER_ACTIVATION_TARGET_SYSTEM_IDENTIFIER`,
   `REVIEW_ROUTER_ACTIVATION_TARGET_DATABASE_OID`,
   `REVIEW_ROUTER_ACTIVATION_TARGET_DATABASE_NAME`,
   `REVIEW_ROUTER_ACTIVATION_MIGRATION_MANIFEST_SHA256`,
   `REVIEW_ROUTER_ACTIVATION_NAMESPACE_FINGERPRINT`,
   `REVIEW_ROUTER_RELEASE_COMMIT_SHA`,
   `REVIEW_ROUTER_RELEASE_IMAGE_DIGEST`,
   `REVIEW_ROUTER_RELEASE_AUTHORITY_OWNER_ROLE`,
   `REVIEW_ROUTER_ACTIVATION_GUARD_ROLE`,
   `REVIEW_ROUTER_ACTIVATION_INSTALLER_BODY_SHA256`, and
   `REVIEW_ROUTER_ACTIVATION_READER_BODY_SHA256` as one rollout-attested
   tuple. Capture each multi-field tuple in one read-only, repeatable-read
   transaction. Never derive identity by comparing configured database URLs;
   two databases on one cluster share a system identifier, and a restored stale
   clone can make URLs agree. The installer hash is intentionally an aggregate
   trust root over permit installation, canonical JSON, principal-evidence
   staging, and final activation bodies; it is not merely the installer
   function's body hash.

3. Pre-provision target roles and the `reviewrouter_activation` guard. Role
   bootstrap must prove the guard has no membership edges, installer has only
   its function, and release migration cannot install permits.
4. Provision variables, environment secrets, reviewers, wait timers, and branch
   protection. Keep `production` and `production-service-switch` approvals
   separate.
5. Disable provider auto-deploy for control, witness, API, web, and worker.

## Incremental authority upgrade (before dependent code)

Every release that adds an authority migration uses the protected
`release-authority-migration.yml` workflow with operation
`incremental-upgrade`. The workflow is the only production caller authorized
to receive `REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL`, and its
connection must be the same direct database-owner login that owns the authority
schema. Do not place that credential in runtime services, private runners,
general CI, or an operator shell.

The trusted order is:

1. Merge and pass the dedicated Release Authority PG17 contract on the exact
   protected `main` SHA.
2. Keep control, witness, and every readiness-dependent service on the prior
   compatible image; provider auto-deploy remains disabled.
3. Dispatch `release-authority-migration.yml` on that exact SHA with
   `operation=incremental-upgrade`. The protected
   `production-release-authority-migration` environment supplies the one-use
   owner credential and requires approval.
4. Require that workflow to succeed. Its gate takes the PostgreSQL advisory
   lock, applies bounded lock and statement timeouts, verifies checked-in and
   recorded checksums/catalog provenance, and commits the valid forward chain
   atomically. A concurrent caller, timeout, partial statement failure, history
   drift, or catalog drift is a deploy blocker.
   The database-owner role must have no `pg_default_acl` rows for tables,
   sequences, routines, or types, either globally or scoped to the
   `release_authority` schema. The installer checks this before any authority
   DDL on both fresh and upgrade paths. Do not work around this gate by granting
   to `PUBLIC` or another role: remove the noncanonical owner default, preserve
   catalog evidence, and rerun the same operation.
5. Only after that success may same-SHA control and witness images be deployed
   and pass health/readiness. Deploy other code that depends on the new
   authority readiness contract afterward.

The `fresh-install` operation is only for a newly provisioned empty authority
database. The `incremental-upgrade` operation requires the authority schema to
already exist. Neither operation guesses intent or falls back to the other. A
byte-identical incremental rerun is idempotent; never use fresh installation as
upgrade recovery.

## Rehearsal and gates

Run from the exact candidate checkout:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
export REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL=1
export REVIEW_ROUTER_REHEARSAL_PG16_IMAGE='postgres:16.13-bookworm@sha256:<approved-64-hex-digest>'
export REVIEW_ROUTER_REHEARSAL_PG17_IMAGE='postgres:17.<minor>-bookworm@sha256:<approved-64-hex-digest>'
pnpm release-rollout:rehearsal --check-only
pnpm exec vitest run \
  scripts/install-release-authority-db.test.ts \
  scripts/private-network-pg17-workflow.test.ts \
  scripts/rehearse-private-pg17-rollout.test.ts \
  scripts/private-pg17-activation.test.ts \
  scripts/activate-private-pg17-generation.test.ts \
  scripts/run-codex-rotating-release-migration.test.ts \
  apps/api/src/release-control-composition.test.ts \
  packages/features/release-rollout/src/domain/release-rollout.test.ts \
  packages/features/release-rollout/src/application/use-cases.test.ts
bash packages/platform/release-authority-db/test-contract.sh
pnpm typecheck
git diff --check
pnpm release-rollout:rehearsal
```

Replace both image placeholders with the immutable digest pins approved in CI;
the check intentionally fails when opt-in or either pin is absent.
The rehearsal uses the same complete ordered one-transaction authority migration
bundle as installation, including selective recovery and late-effect handling.
The authority installer proves the append-only chain in this exact order:
`000001_release_authority`, `000002_external_effect_protocol`,
`000002_transactional_service_transition`, `000003_partial_source_freeze`,
`000004_selective_source_recovery`, `000005_late_runner_effects`,
`000006_runner_provider_creation_boundary`,
`000007_compensation_effect_fence`, `000008_trigger_helper_acl`,
`000009_authority_history_and_forward_repairs`,
`000010_recovery_effect_permits`, and
`000011_default_and_final_acl_exactness`. Migrations 000001 and 000002
are the immutable bytes published on `origin/main`; their later lock-order,
retryability, terminal-projection, and receipt-link repairs live only in 000009.

Migration 000009 creates the owner-only `release_authority.schema_migration`
ledger and a least-privilege manifest routine. Fresh installs record the
canonical checksum of every file. A pre-ledger catalog is never identified by
a few columns or surviving routine fragments. In the install transaction the
installer builds canonical and exact-published-legacy shadow catalogs from the
immutable source bytes and compares a deterministic representation of every
relation, column/default, constraint, index, sequence, routine body/property,
trigger, schema/type/enum, owner, ACL, and relevant `pg_default_acl` state.
Exactly one shadow must match before
000009 may backfill history. For a matching authority database carrying the
previously published modified 000001/000002 bytes, migration 000009 retains
those two exact legacy checksums as `legacy_equivalent` and converges their
behavior to the same forward state. Migration 000010 adds the single-use
recovery-effect permit protocol and its provider-neutral execution fence after
the migration ledger exists. Only the consume winner receives the ephemeral
receipt needed for one atomic execution validation; a late runner job changes
consumed/executing effects to durable forward repair, and completion or
checkpoint creation then fails closed. Migration 000011 removes PostgreSQL's
implicit `PUBLIC` usage from the declared authority enum before the exact ACL
assertion. Existing pre-ledger authorities apply 000009 through 000011, while
authorities already recorded through 000010 apply only 000011. Health requires
every ordered identity through 000011, the matching
canonical/approved-legacy checksum and variant, the 000006 provider creation
column plus validated NOT NULL/order constraint and witness time bounds, the
000007 compensation fences, the 000008 helper revocation, common ownership,
exact role grants, and no PUBLIC authority privileges. A missing, reordered,
unknown, or partially applied entry is release-blocking.

Shadow catalog equality is not an ACL trust root. Before writing the final
schema attestation, and independently on every runtime readiness observation,
the gate evaluates the domain-owned object/role/privilege matrix against every
authority table, sequence, and routine, schema privilege, object owner, column
ACL, and type ACL. Extra grantees or ACL-bearing objects, inherited stale access,
`PUBLIC`, grant options, missing grants, owner drift, and non-empty relevant
owner defaults make readiness fail even if a catalog digest happens to match.
Readiness takes every identity, manifest, routine, and catalog fact from one
pinned PostgreSQL session and bounded repeatable-read transaction. Pool wait
(2s), lock (2s), statement (15s), transaction (17s), and application observation
(20s) limits are independent. A successful full observation has a process-local
60-second hard lease measured from its earliest start, refreshes ahead at 40
seconds with bounded singleflight retry, and is usable only for its exact
service/revision/artifact/catalog/database/role/body/manifest subject. Equality
at expiry is expired; failures never extend evidence and definitive mismatches
revoke it. Process startup begins the observation in the background with bounded
retry, and shutdown cancels its timer and in-flight observation. `/health`
reports this cached state without starting catalog work.
Every protected routine also checks the cheap PG17 role and database identity
fence on the routine's own transaction connection. Witness publication forces a
new full observation after its provider read. The schema-v2 signed witness also
binds the running deployment revision and immutable artifact digest, which the
trusted-evidence verifier matches to release commit and image provenance.
Missing legacy fields, a mixed-generation manifest, extra namespace objects,
changed routine bodies, or a stale fingerprint fail closed.

The five database/application bounds may be overridden only with the matching
`REVIEW_ROUTER_READINESS_{POOL_WAIT,LOCK_TIMEOUT,STATEMENT_TIMEOUT,TRANSACTION_TIMEOUT,OBSERVATION_DEADLINE}_MS`
variables. Startup rejects malformed values and unsafe ordering. The 60-second
lease and 40-second refresh point are not environment-configurable.

An absent-ledger catalog that matches neither shadow, or matches ambiguously,
stops before history or forward repairs are written. Preserve the failed
transaction output and take a schema-only dump plus catalog/ACL/owner evidence.
Do not insert `schema_migration` rows, edit a checksum, or invoke 000009 by
itself. Recovery requires an audited object-by-object comparison against the
immutable 000001-000008 sources, an approved forward repair that explains every
difference, and then a rerun of the trusted incremental upgrade workflow. If exact
provenance cannot be established, provision a fresh authority database and
reconcile through the normal rollout recovery procedure; never bless the
ambiguous catalog.

CI must pass on the protected candidate SHA. Live E2E requires a newly created
disposable repository/project, source/target PG17 DBs, runner services, and
non-production authority DB. Delete them after evidence retention. Production
repositories, user projects, and reused customer runners are forbidden fixtures.

## Production procedure

1. Record the exact protected main SHA; confirm the
   `private-network-pg17-production` concurrency group is idle.
2. Confirm authority DB exclusion from application copy/backup; control/witness
   health; current source backup; complete source writer list; independently
   observed target identity/recovery witness; pre-provisioned guard; auto-deploy
   off.
3. Generate a unique rollout ID and dispatch only through Actions:

   ```bash
   EXPECTED_SHA=$(git rev-parse origin/main)
   RELEASE_RUN_ID=1234567890
   RELEASE_ARTIFACT_ID=2345678901
   ROLLOUT_ID="private-pg17-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$EXPECTED_SHA" | cut -c1-8)"
   gh workflow run private-network-pg17-rollout.yml \
     --ref main \
     -f rollout_id="$ROLLOUT_ID" \
     -f expected_sha="$EXPECTED_SHA" \
     -f release_run_id="$RELEASE_RUN_ID" \
     -f release_artifact_id="$RELEASE_ARTIFACT_ID"
   gh run list --workflow private-network-pg17-rollout.yml --branch main --limit 5
   ```

   Select `RELEASE_RUN_ID` from the successful, first-attempt `Release`
   workflow run whose `head_sha` is exactly `EXPECTED_SHA`; use the immutable
   run ID printed in that run's release summary. Select `RELEASE_ARTIFACT_ID`
   from the same summary's `Hosted runtime identity artifact ID`, never by
   artifact name alone. Before dispatch, verify both immutable identities:

   ```bash
   REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
   test "$(gh api "repos/$REPOSITORY/actions/runs/$RELEASE_RUN_ID/attempts/1" \
     --jq '[.path,.event,.run_attempt,.head_sha,.conclusion] | @tsv')" = \
     ".github/workflows/release.yml	workflow_dispatch	1	$EXPECTED_SHA	success"
   test "$(gh api "repos/$REPOSITORY/actions/artifacts/$RELEASE_ARTIFACT_ID" \
     --jq '[.workflow_run.id,.workflow_run.head_sha,.expired] | @tsv')" = \
     "$RELEASE_RUN_ID	$EXPECTED_SHA	false"
   ```

   The protected preflight repeats these checks, requires the artifact name to
   be `hosted-runtime-image-v*`, verifies its exact identity payload and GitHub
   attestation, and durably claims the rollout before any source mutation.

4. `protected-release-preflight` checks exact identity and durably claims the
   rollout before mutation.
5. `freeze-source-writers` suspends and re-observes all source writers.
6. `copy-and-role-bootstrap-private` captures backup, proves quiescence, copies,
   proves equivalence, converges target roles, and verifies the pre-provisioned
   guard on a one-use private runner.
7. `await-role-runner-cleanup` requires provider and independent witness
   cleanup evidence.
8. `pg17-cutover-private` migrates, verifies target facts, stages exact target
   services under provider authority, obtains durable fence/authorization,
   asks the control server to install the permit, and invokes transactional
   activation. Installer/guard credentials never reach the runner.
   A transport retry of the byte-identical activation request is idempotent and
   returns the already-written identical receipt. A changed tuple is a conflict;
   operators must never manufacture or manually replay either request.
9. `await-cutover-runner-cleanup` proves destruction and work-path removal.
10. `finalize-target-and-trusted-evidence` resumes only authorized target
    deploys, runs the live write/read canary, verifies final authority, and
    uploads `trusted-private-pg17-<rollout>-<run>-1`.
11. `always-reconcile-runners-and-compensation` runs regardless of result.
    Do not close the change until every persisted intent/job is reconciled.

Inspect and verify without printing environments or secrets:

```bash
gh run view RUN_ID --json status,conclusion,headSha,event,jobs
gh run view RUN_ID --log-failed
gh run download RUN_ID --name "trusted-private-pg17-${ROLLOUT_ID}-RUN_ID-1"
REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY="$REPOSITORY" \
  REVIEW_ROUTER_EXPECTED_SHA="$EXPECTED_SHA" \
  pnpm release-rollout:evidence:verify \
  "trusted-private-pg17-${ROLLOUT_ID}-RUN_ID-1/trusted-rollout-evidence.json"
```

## Compensation, rollback, and outcome unknown

| Boundary                                                                                 | Required action                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Before durable authorization                                                             | Let reconciliation compensate and prove source DB/provider recovery. Never reuse the rollout ID.                                      |
| Definitively pre-activation authorization state                                          | Use only authority-backed compensation; require complete DB/provider observations before source resume.                               |
| Matching receipt and final target authority                                              | Roll forward on target. Source is permanently ineligible; rollback is a new forward rollout, never source resume.                     |
| Timeout, cancellation, lost response/artifact, or authority/provider/target disagreement | Outcome unknown: freeze both sides, preserve evidence, block deploys/new rollouts, reconcile authority plus immutable target receipt. |

For outcome unknown, do not rerun jobs, invoke activation SQL, reinstall a
permit, edit authority rows, restore source, or resume services. Resolution must
prove either no receipt plus durable compensated pre-activation state, allowing
authority-backed source resume, or a matching receipt plus durable activated
state, allowing target-only resume. If neither is proved, remain fail closed.
The backup is recovery material, not permission to overwrite a generation or
the authority DB.

## Completion record

Retain run ID/attempt, SHA, rollout ID, authority state, generation identifiers,
backup/migration digests, permit epoch/nonce evidence, immutable receipt, both
cleanup witnesses, target deploy IDs, canary, reconciliation result, and the
verified trusted-evidence artifact. Store references and hashes only, never
secret values or connection URLs.
