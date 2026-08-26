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

| Boundary                | Connection                                                         | Allowed authority                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control                 | `REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL`             | Control routines; no direct tables                                                                                                                                          |
| Provider authority      | `REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL`            | Provider decision routine only                                                                                                                                              |
| Bootstrap administrator | `REVIEW_ROUTER_RELEASE_AUTHORITY_BOOTSTRAP_ADMIN_DATABASE_URL`     | Fixed `reviewrouter_bootstrap_administrator` capability: `NOSUPERUSER NOCREATEDB CREATEROLE`, exact PostgreSQL-created ADMIN edges, and `pg_signal_backend`; bootstrap only |
| Witness                 | Dedicated read-only authority, source, and target connections      | Cleanup plus signed release-binding observations                                                                                                                            |
| Permit installer        | `REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL` on target | `install_activation_permit` only                                                                                                                                            |
| Receipt guard           | Target-local, no login/membership edges                            | Own permit, activation, and receipt functions                                                                                                                               |
| Release migration       | `REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL`                     | Migrate and invoke activation; cannot install permits                                                                                                                       |
| Runtime roles           | API/web/worker/effect-authority URLs                               | Normal least-privilege runtime work                                                                                                                                         |

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

| Group             | Variables                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow identity | `REVIEW_ROUTER_RELEASE_CONTROL_ORG`, `REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY`, release-witness signing key ID and public key                                                                                                                                                          |
| Service origins   | `REVIEW_ROUTER_RELEASE_CONTROL_URL`, `REVIEW_ROUTER_RELEASE_WITNESS_URL`                                                                                                                                                                                                                |
| Runners           | `REVIEW_ROUTER_RUNNER_GROUP_ID`, `REVIEW_ROUTER_RUNNER_GROUP_NAME`, `REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID`                                                                                                                                                                              |
| Provider          | `REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS`, `RENDER_OWNER_ID`                                                                                                                                                                                                                            |
| Generations       | source/target `RENDER_DATABASE_ID`, `INTERNAL_HOSTNAME`, `DATABASE_NAME`, `DATABASE_SYSTEM_IDENTIFIER`, `RECOVERY_WITNESS_SHA256`                                                                                                                                                       |
| Release           | `REVIEW_ROUTER_RELEASE_APPROVAL_MODE` (`solo_owner` or `independent`), `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, `REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON`, source/source-fenced/target-equivalence principal policy JSON, and the two compact activation catalog policy digests |
| Canary            | `REVIEW_ROUTER_LIVE_CANARY_URL`                                                                                                                                                                                                                                                         |

`REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS` has one canonical encoding in every
phase: a compact JSON array of unique Render service IDs, for example
`["srv-api123","srv-worker456"]`. It must contain 1-100 sorted lowercase
`srv-` IDs with no whitespace, duplicate entries, CSV encoding, or surrounding object.
Freeze, cutover, and compensation all fail closed on any other value.

The source, source-fenced, and target-equivalence variables are canonical
`EffectivePrincipalPolicy` version 1 documents. The target-preactivation and
target activation variables are `reviewrouter-activation-catalog-policy`
version 1 documents. Those two exact catalog contracts contain the database,
all relevant role attributes, membership/reachability edges, schema/object
ownership and grants (including grantor and grant option), default ACL facts,
large-object ownership/ACLs, complete RLS policy predicates, and the normalized
effective permissions of every principal. Ephemeral `pg_temp_*` namespaces are
excluded so connection history cannot change the reviewed contract.
Quoted PostgreSQL names are represented literally in JSON. Generate and review
them from a disposable, production-shaped catalog; never copy live discovery
output into the allowlist without review.

Capture candidates only through the rehearsal's capture-only mode. The former
standalone database-URL capture command was removed because a caller-provided
label cannot prove that a configured database is disposable. The rehearsal performs the
same pinned PG16-to-PG17 copy, role bootstrap, canonical release migration,
legacy reconciliation, and preactivation preparation as the rollout rehearsal:

```bash
export REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL=1
export REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY=1
export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY=rr-disposable-<unique-id>
export REVIEW_ROUTER_REHEARSAL_PG16_IMAGE='postgres:16.13-bookworm@sha256:<approved-64-hex-digest>'
export REVIEW_ROUTER_REHEARSAL_PG17_IMAGE='postgres:17.<minor>-bookworm@sha256:<approved-64-hex-digest>'
pnpm release-rollout:rehearsal > /tmp/reviewrouter-activation-catalog-policy-candidate.json
```

Only the exact capture-only value `1` selects this branch. Immediately after
`run_release_migration`, it proves that the target is a container created by
this rehearsal, that it is distinct from the source, and that its observed
system identifier and recovery witness match the fenced target state. It then
writes a structured disposable attestation through the role-bootstrap
connection. The attestation binds the capture identity, live system identifier,
database OID, recovery-witness digest, and a nonce derived from the observed
target state. The canonical candidate query re-observes and verifies every
binding through the release-migration connection. The runtime grants exist only
inside that query's rollback transaction. The branch then exits: it cannot stage or resume target
services, install an activation permit, activate a generation, run the canary,
or produce rollout proof. Its stdout is the typed candidate JSON; diagnostics
remain on stderr. All three disposable containers, their network, and temporary
credential files are cleaned up on success or failure.

Without that exact capture-only opt-in, this is the normal rehearsal and it
remains fail-closed on
`canonicalActivationCatalogPolicyTrustRootReadiness`; the readiness assertion
runs before any Docker operation.

The rehearsal creates the database attestation; an operator-supplied database
comment or disposable-looking label is not accepted as lifecycle proof. The
capture login is `reviewrouter_release_migration`. Both the explicit capture-only
opt-in and the exact structured server-side attestation are mandatory before any
catalog projection. The guard first performs the full raw safety evaluation, then
returns the provider-neutral relevance closure. Every raw direct/default ACL,
ownership, and role-attribute grant principal must be `PUBLIC` or an exact
canonical activation principal; this check occurs before normalization, so a
disconnected role with application authority rejects capture instead of being
omitted. A factually disconnected inert provider role with no application
authority is omitted without consulting its name. The one external inert
grantor of the exact five bootstrap membership edges is represented as
`{"kind":"external-bootstrap-authority"}`; its catalog name is never pinned.
Any second grantor, different edge/options, or other authority rejects capture.
Extension entries pin the provider-neutral extension name and normalized owner.
An application principal is represented by name; an otherwise-inert provider
owner is represented as `external-provider-authority`, never by its provider
role name. Versions are intentionally excluded because provider patch cadence
changes them without changing ALTER/UPDATE/DROP authority. Large objects,
foreign data wrappers/servers, publications, subscriptions, event triggers,
parameter ACLs, custom languages/tablespaces, user collations/conversions,
operators, extended statistics, text-search objects, and other unmodeled ACL
kinds make projection fail closed. The built-in languages and tablespaces are
accepted only in their immutable default shape. No catalog-local OID is admitted
to the artifact.

The promoted trust root is generated from the independently reviewed v29
candidate. Immutable capture, image, phase-digest, audited-HEAD, and final-review
evidence is recorded in the adjacent
`activation-catalog-policy-provenance.json`. The immutable review report is
stored under `docs/release-evidence/` and its byte SHA-256 is bound by provenance
v3. These files are the machine-readable source for the precise ready state;
stale capture blockers are not retained after promotion.

The command has no permit-installation or activation capability. It reads the
preactivation candidate only after a capture-only transaction drops the exact
`public.rehearsal_items`, `app_private`, and `rehearsal_writer` fixtures and
asserts their absence. Normal rollout retains those fixtures and canary checks.
Candidate parsing independently rejects rehearsal-shaped identities/resources
and duplicate normalized grant identities. It then reads the
preactivation candidate, applies the exact production runtime grants, reads the
activated candidate, and ends with `ROLLBACK`; it never substitutes one phase
for the other. Review the complete diff, verify that no provider identity is
present, then promote only the reviewed bytes with the exact operator opt-in:

```bash
REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION=promote-reviewed-activation-catalog-v29 \
  pnpm release-rollout:promote-activation-catalog-policy \
  --candidate /secure/evidence/rr-activation-catalog-candidate-v29.json --write
```

Omit `--write` to verify that the checked-in generated module is byte-exact.
The command accepts no runtime policy path, verifies the reviewed whole-file
size and SHA-256 before parsing, validates normalization, checks both reviewed
phase digests and the canonical artifact digest, and writes only the fixed
source-owned artifact path. Update both compact deployment digest
authorizations as part of the same release change. Never run candidate capture
on a live database and never add capture, promotion, or drafting to the
activation path.

Activation principal evidence uses a single-session staged transaction. The
versioned `canonicalActivationCatalogPolicyArtifact` in the release-rollout
domain is the sole trust root for both reviewed target contracts and their
deterministic hashes. Release-control and release-witness require independently
configured `REVIEW_ROUTER_TARGET_{PREACTIVATION,ACTIVATED}_CATALOG_POLICY_SHA256`
values and verify both against the checked-in artifact; missing, malformed, or
mismatched values fail startup. No runtime path or full-policy environment value
can replace the checked-in artifact. The generated module is cloned, strictly
validated, and deeply frozen by the domain contract before use; module loading
also recomputes both phase digests and refuses any provenance drift.
Release-control installs only the artifact policies and hashes through its
dedicated permit-installer connection. The cutover runner does not send
policy JSON. In the committing transaction, the target guard
locks that one-shot permit, independently projects the live PG17 catalogs, and
requires byte-exact normalized equality with the permit-bound preactivation
contract. It stages the reviewed contracts, live inventories, derived policies,
and all digests with the permit and target identity. After canonical grants, it
projects again and requires exact equality with the permit-bound activated
contract. The immutable receipt binds both reviewed-policy digests and all four
principal evidence digests into its first-write hash beside the migration and
catalog facts. A
rollback removes the stage; a committed receipt can be returned directly on
replay or reconstructed by the receipt reader without observing the catalogs
again. Missing, malformed, swapped, or stale evidence therefore fails closed.
The activation SQL generator also pins the SHA-256 trust root of the exact
effective-principal catalog projection, so a weaker observation query cannot
be substituted at either preview or commit time.

The release-control readiness attestation and release-witness schema 3 bind
both artifact policy hashes. Final trusted-rollout evidence schema 8 requires
the permit receipt and signed witness to equal those pinned values. A policy
artifact update therefore requires one coherent control/witness/finalizer
release and matching Render digest inputs; mixed versions fail closed.

Protected environment secrets:

| Environment                     | Secrets                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production-release-preflight`  | release-control token                                                                                                                                                                   |
| `production-runner-control`     | release-control, provider-authority, and release-witness tokens; suspension and/or runner-control key per job                                                                           |
| `production-role-bootstrap`     | release-control and provider-authority tokens, provenance key, source compensation/copy URL, reconnect URLs, role-bootstrap/release-migration URLs, target runtime URLs, backup witness |
| `production-runner-ledger-read` | release-control token                                                                                                                                                                   |
| `production`                    | release-control and provider-authority tokens, target-switch key, release-migration and target runtime URLs                                                                             |
| `production-service-switch`     | release-control, provider-authority, and release-witness tokens; suspension key and live-canary token                                                                                   |

Every environment in this table must exist, require at least one reviewer, and
allow protected branches only. A solo-owner repository may allow the dispatching
owner to approve the deployment; organizations with a genuinely independent
operator should enable GitHub's prevent-self-review setting and select
`REVIEW_ROUTER_RELEASE_APPROVAL_MODE=independent`. The `solo_owner` mode records
the configured self-review setting without claiming independent approval. A
missing, unknown, or non-boolean policy fact fails closed. `main` must be a
protected branch. These are external GitHub settings: the workflow's read-only
bootstrap verifies the reviewer and branch gates before checkout, but it never
configures them.

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
   `reviewrouter_release_control`, `reviewrouter_provider_authority`,
   `reviewrouter_release_witness`, and `reviewrouter_migration_issuer` logins.
   Put the provider-administrator and initial database-owner URLs in separate
   mode-0600 credential files. Invoke the convergent fresh installation command;
   it prepares the minimum database capability, provisions the fixed owner,
   fixed owner and broker, and a one-shot bootstrap-quiescence helper, runs
   the migration, and always executes cleanup:

   ```bash
   export REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL_FILE=/approved/secret/path/release-authority-bootstrap-admin-url
   export REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE=/approved/secret/path/release-authority-migration-url
   pnpm release-authority:fresh-install
   ```

   The fresh gate requires the `release_authority` schema to be absent and
   applies the complete checked-in chain in one transaction. Migration 000015
   transfers the authority catalog to the fixed `NOLOGIN`
   `reviewrouter_authority_owner`, retains only the provider-authorized isolated
   `NOLOGIN` `reviewrouter_migration_broker` authority edge, and atomically
   removes the two bootstrap `SET` memberships and disables the login before
   commit. After that bootstrap session exits, the provider administrator
   verifies the pinned root, absence of sessions and ownership dependencies,
   removes the exact helper with `RESTRICT`, and executes `DROP ROLE B` without
   `CASCADE`. A lost-response retry classifies the committed cleanup-pending
   state and performs that terminal deletion. Failure cleanup terminates all
   bootstrap sessions, drops the helper, makes the bootstrap `NOLOGIN`, removes
   its owner/broker edges, and retains only the inert `ADMIN`, `INHERIT FALSE`,
   `SET FALSE` recovery edge needed for a later retry. Remove both one-time
   secrets after success. Never use
   this command for a later upgrade or substitute application Prisma tooling.
   Retain this DB across cutovers.

   The bootstrap-admin URL must authenticate exactly as
   `reviewrouter_bootstrap_administrator LOGIN NOSUPERUSER NOCREATEDB
CREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`, with no role
   configuration or validity deadline. It must have the standard
   `pg_signal_backend` membership and must itself have created the initial
   bootstrap login, producing PostgreSQL 17's exact bootstrap-to-provider edge:
   the opaque provider root is the grantor, with `ADMIN TRUE`, `INHERIT FALSE`,
   and `SET FALSE`. The initial database-owner login is likewise
   `NOSUPERUSER NOCREATEDB CREATEROLE`; ownership of the already-created
   database does not require cluster-wide `CREATEDB`. Before every provider
   mutation, a direct P connection sets `createrole_self_grant=''`, creates a
   cryptographically random disposable `NOLOGIN` role, reads its sole exact
   membership edge, and drops it in the same transaction. The resulting
   `system_identifier`, root OID/name, and P OID/name are pinned. B/O/M must
   share that root; no provider name, superuser bit, or OID is hardcoded. Root
   rename/drop-recreate, restore to another system identifier, a foreign or
   duplicate grantor, or option drift requires explicit re-enrollment. The
   bootstrap always has `CONNECTION LIMIT 1`; recovery restores that exact
   bound before admitting another migration attempt. Existing sessions survive
   a limit reduction, so migration separately rejects any foreign bootstrap
   `session_user`. Preparation grants the administrator
   database `CREATE` only while it creates the provider-owned helper and the
   owner login immediately revokes that grant. Migration rejects another
   bootstrap `session_user`, proves B owns only the target database and
   session-local temporary objects, transfers them with `REASSIGN OWNED`,
   removes only P-granted O/M-to-B `SET` edges, and
   quiesces B. Provider cleanup deletes B after its session exits. Terminal readiness proves neither identity retains database
   `CREATE`. Provisioning normalizes and attests only the fixed owner/broker
   ADMIN edges. Any extra membership, ownership in this
   or another database, role-attribute drift, helper overload, helper-body
   drift, or helper ACL drift fails closed. Before changing the bootstrap login,
   provisioning and recovery attest that it is already `NOSUPERUSER NOCREATEDB
   NOREPLICATION NOBYPASSRLS`; the non-superuser provider never attempts to
   change those privileged attributes and normalizes only the mutable login,
   password, `CREATEROLE`, connection-limit, validity, and role configuration
   properties. Cleanup uses `GRANTED BY P RESTRICT` for known P edges and
   never rewrites provider edges, impersonates the root, iterates arbitrary
   catalog grantors, or uses `CASCADE`. This is a provider bootstrap
   capability contract; it is never the restricted provider-decision URL.

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
   exact pre-migration application-manifest digest, activation namespace fingerprint, and
   activation routine body hashes from the immutable release. These values are
   catalog evidence, not credentials or connection strings. Obtain the two
   routine hashes from the checked-out release without querying the target:

   ```bash
   node --import tsx -e "import('./scripts/run-codex-rotating-release-migration.mjs').then(m => console.log(m.activationRoutineBodyTrustRoots()))"
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
`incremental-upgrade`. The protected environment stores only
`REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL`. That login
can execute `issue` and `reconcile`; it cannot read lease rows, mutate the
authority catalog, or inherit owner privileges. The broker creates a unique
10-minute, connection-limit-one login bound to exact commit SHA, workflow run,
attempt, operation, database, password hash, nonce, and immutable receipt.

The trusted order is:

1. Merge and pass the dedicated Release Authority PG17 contract on the exact
   protected `main` SHA.
2. Keep control, witness, and every readiness-dependent service on the prior
   compatible image; provider auto-deploy remains disabled.
3. Dispatch `release-authority-migration.yml` on that exact SHA with
   `operation=incremental-upgrade`. The protected
   `production-release-authority-migration` environment supplies the restricted
   issuer credential. It must have at least one required reviewer and restrict
   deployments to protected branches. Solo owners may approve their own
   deployment; prevent-self-review remains recommended when an independent
   operator actually exists. The workflow checks the explicit approval mode,
   reviewer policy, and branch gates before any credential-bearing job is
   eligible.

   ```bash
   EXPECTED_SHA=$(git rev-parse origin/main)
   gh workflow run release-authority-migration.yml \
     --ref main \
     -f expected_sha="$EXPECTED_SHA" \
     -f operation=incremental-upgrade
   gh run list --workflow release-authority-migration.yml --branch main --limit 5
   ```

   The workflow first proves that `EXPECTED_SHA`, the dispatch SHA, and current
   protected `main` are identical. From that exact checkout it then verifies a
   single successful trusted CI run and the dedicated PG17 authority-contract
   and full-rehearsal jobs plus their digest-addressed exact-SHA artifacts. Only
   after both jobs succeed can the protected environment be entered and the
   restricted issuer credential materialized. Database-owner authority exists
   only in the one-shot lease consumed inside the migration transaction.

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

The leased connection consumes its capability in the same explicit transaction
that performs DDL, verifies the final catalog, and finalizes the lease.
PostgreSQL immediately changes the login to `NOLOGIN`, then grants only `SET`
membership in the fixed authority owner for that already-authenticated session.
The migration finalizer revokes membership and records `finalized` before that
transaction commits; a deferred guard rejects autocommit consume or any commit
without finalize. Issue and the unconditional workflow cleanup reconcile every
unfinished `issued` or `consumed` lease, not only expired leases. Never set the
generated lease URL as a GitHub secret and never restore the retired bootstrap
owner secret. Reconciliation does not roll back when a terminal login still has
an authenticated backend: it commits `NOLOGIN`, password removal/expiry, owner
revocation, terminal lease state, and credential-schema/function ACL revocation.
The exact inert role is dropped by reconciliation after that backend exits, and
new lease issuance remains available in the meantime.

For the single existing-database transition that first installs 000015, dispatch
`bootstrap-upgrade` with
`REVIEW_ROUTER_RELEASE_AUTHORITY_BOOTSTRAP_DATABASE_URL`. This operation is
valid only while the old owner still owns `release_authority`; success nulls
that password. Delete the bootstrap secret immediately. All subsequent runs
must use `incremental-upgrade` and the issuer path. 5. Only after that success may same-SHA control and witness images be deployed
and pass health/readiness. Deploy other code that depends on the new
authority readiness contract afterward.

The `fresh-install` operation is only for a newly provisioned empty authority
database. The `incremental-upgrade` operation requires the authority schema to
already exist. Neither operation guesses intent or falls back to the other. A
byte-identical incremental rerun is idempotent; never use fresh installation as
upgrade recovery.

### Provider mutation crash recovery

Migration 000012 fences each Render mutation by resource, rollout, operation,
owner, epoch, permit, expected fingerprint, and optional provider version. The
authority state, not an HTTP timeout or an operator's recollection, determines
recovery:

- `claimed` means no permit was consumed. Recover the same binding; an expired
  claim may be replaced normally.
- `consumed` means the one-use receipt exists but execution validation did not
  commit. Do not immediately repeat the provider call. Recover the same binding;
  only after the lease expires may authority rotate the epoch and return a new
  permit, invalidating the old receipt atomically.
- `executing` means execution validation committed and the provider outcome may
  be ambiguous. Recovery is reconciliation-only. Observe the exact fenced
  resource and submit `exact_postcondition`, `precondition_drift`,
  `execution_not_authorized`, or `ambiguous_forward_repair`; never issue or
  replay the provider mutation.
- `forward_repair` is terminal and retains the resource fence. Pause dependent
  rollout work, preserve the receipt and provider observation, and execute an
  approved monotonic forward repair. Never clear the lease, rewind the state, or
  reuse the old permit by direct SQL.

Use the normal protected workflow/controller recovery path so calls go through
`release_provider_mutation_recover` and
`release_provider_mutation_reconcile`. Do not invoke authority routines from an
operator shell or edit `provider_mutation`/`provider_resource_lease` rows. If
the authority migration itself failed, preserve its output and rerun the same
exact-SHA `incremental-upgrade` workflow only after the underlying lock,
catalog, or infrastructure fault is resolved.

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
`000010_recovery_effect_permits`,
`000011_default_and_final_acl_exactness`, and
`000012_provider_mutation_resource_fence`. Migrations 000001 and 000002
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
recovery-effect permit protocol after the migration ledger exists. Migration
000011 removes PostgreSQL's implicit `PUBLIC` usage from the declared authority
enum before the exact ACL assertion. Migration 000012 hardens recovery effects
with a separate executing transition and execution receipt, then adds the
resource-scoped provider-mutation permit and reconciliation fence. Only the
consume winner receives the receipt needed for one atomic execution validation;
a late runner or ambiguous provider result changes consumed/executing work to
durable forward repair, and completion or checkpoint creation then fails closed.
Existing pre-ledger authorities apply 000009 through 000012; authorities already
recorded through 000010 apply 000011 and 000012, and those through 000011 apply
only 000012. Health requires every ordered identity through 000012, the matching
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
6. `copy-and-role-bootstrap-private` durably records source quiescence, then captures backup, copies,
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

### Phase-aware application manifest fence

The release artifact fixes one `ReleaseMigrationTransitionV1` to the exact
release commit, immutable image digest, ordered migration SQL checksums,
migration bundle digest, exact pre-manifest, every exact crash-resume root,
the exact post-manifest, and the V70-V86 catalog postcondition. The
control plane derives this transition from its trusted release identity; a
runner cannot submit or override an expected manifest.

Normal migration uses three durable operations: `begin` claims the target
generation and returns one idempotent permit while the target is exactly at the
pre-manifest. After a crash, `begin` reads the durable `migrating` phase without
requiring the target to still be pre-migration, and the migration adapter
verifies the permit, bundle, exact transition-owned resume root,
post-manifest, and V70-V86 objects while holding the migration lock; `complete`
freshly attests the exact post-manifest and atomically stores the canonical
`run_release_migration` receipt. A retry returns the same permit or canonical
receipt. A SQL failure quarantines the target forward-only. Never edit the
phase, reuse a quarantined generation, substitute a worker digest, or configure
the control plane to accept either manifest. Capture-only rehearsal remains a
non-authoritative direct-port evidence path and does not call release authority.

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
