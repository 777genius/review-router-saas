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
   unique and never reused, including after failure.
5. After ambiguity, never manually resume writers or rerun activation. Reconcile
   durable authority and the target receipt first.

## Identities

| Boundary           | Connection                                                         | Allowed authority                                     |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Control            | `REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL`             | Control routines; no direct tables                    |
| Provider authority | `REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL`            | Provider decision routine only                        |
| Witness            | `REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_DATABASE_URL`             | Cleanup witness routines only                         |
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

| Group             | Variables                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workflow identity | `REVIEW_ROUTER_RELEASE_CONTROL_ORG`, `REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY`                                                   |
| Service origins   | `REVIEW_ROUTER_RELEASE_CONTROL_URL`, `REVIEW_ROUTER_RELEASE_WITNESS_URL`                                                          |
| Runners           | `REVIEW_ROUTER_RUNNER_GROUP_ID`, `REVIEW_ROUTER_RUNNER_GROUP_NAME`, `REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID`                        |
| Provider          | `REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS`, `RENDER_OWNER_ID`                                                                      |
| Generations       | source/target `RENDER_DATABASE_ID`, `INTERNAL_HOSTNAME`, `DATABASE_NAME`, `DATABASE_SYSTEM_IDENTIFIER`, `RECOVERY_WITNESS_SHA256` |
| Release           | `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, `REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON`                                        |
| Canary            | `REVIEW_ROUTER_LIVE_CANARY_URL`                                                                                                   |

`REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS` has one canonical encoding in every
phase: a compact JSON array of unique Render service IDs, for example
`["srv-api123","srv-worker456"]`. It must contain 1-100 sorted lowercase
`srv-` IDs with no whitespace, duplicate entries, CSV encoding, or surrounding object.
Freeze, cutover, and compensation all fail closed on any other value.

Protected environment secrets:

| Environment                     | Secrets                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production-release-preflight`  | release-control token                                                                                                                                                                   |
| `production-runner-control`     | release-control, provider-authority, and release-witness tokens; suspension and/or runner-control key per job                                                                           |
| `production-role-bootstrap`     | release-control and provider-authority tokens, provenance key, source compensation/copy URL, reconnect URLs, role-bootstrap/release-migration URLs, target runtime URLs, backup witness |
| `production-runner-ledger-read` | release-control token                                                                                                                                                                   |
| `production`                    | release-control and provider-authority tokens, target-switch key, release-migration and target runtime URLs                                                                             |
| `production-service-switch`     | release-control and provider-authority tokens, suspension key, live-canary token                                                                                                        |

Server-only service values:

| Service | Values                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control | authority control DB URL, provider-authority DB URL, distinct `REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256` and `REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256`, permit-installer and receipt-reader DB URLs |
| Witness | authority witness DB URL, `REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256`, Render read token                                                                                                                   |

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

The GitHub workflow, ref, GHCR repository, and artifact-attestation rules are
infrastructure policy owned by the preflight verifier. The domain record stores
the provider-neutral v2 claim: source repository/revision, OCI image repository
and digest, build run, artifact identity, identity hash, and the hash of the
verification policy. Trusted rollout evidence schema 5 is the explicit wire
migration from schema 4/v1 provenance; schema 4 artifacts remain historical
records and must not be submitted to the schema 5 verifier or upgraded without
rerunning the current preflight verification.

## Provision once

1. Create a fresh dedicated PostgreSQL 17 authority DB and the distinct
   `reviewrouter_release_control`, `reviewrouter_provider_authority`, and
   `reviewrouter_release_witness` logins. Put the owner connection URL in a
   mode-0600 credential file, then invoke the one-shot installer exactly once:

   ```bash
   export REVIEW_ROUTER_RELEASE_AUTHORITY_OWNER_DATABASE_URL_FILE=/approved/secret/path/release-authority-owner-url
   pnpm release-authority:install
   ```

   The installer applies `000001_release_authority`,
   `000002_external_effect_protocol`,
   `000002_transactional_service_transition`,
   `000003_partial_source_freeze`, `000004_selective_source_recovery`, and
   `000005_late_runner_effects` in that order, each exactly once in one
   transaction. It is fresh-install-only: never
   run it against an existing authority catalog or substitute application
   Prisma migration tooling. Retain this DB across cutovers.

2. Deploy control and witness from the same immutable release and verify their
   `/health` service identities. Healthy control must observe the 000002
   `release_runner_prepare_effect`, `release_runner_acquire_dispatch_permit`,
   `release_runner_reconcile_effect`, and `release_runner_abandon_prepared`
   routines; healthy witness must observe the 000002 effect snapshot routine.
   Healthy control must also expose the 000003 source-freeze prepare, record,
   complete, and compensation-checkpoint routines before rollout use.
3. Pre-provision target roles and the `reviewrouter_activation` guard. Role
   bootstrap must prove the guard has no membership edges, installer has only
   its function, and release migration cannot install permits.
4. Provision variables, environment secrets, reviewers, wait timers, and branch
   protection. Keep `production` and `production-service-switch` approvals
   separate.
5. Disable provider auto-deploy for control, witness, API, web, and worker.

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
`000009_authority_history_and_forward_repairs`, and
`000010_recovery_effect_permits`. Migrations 000001 and 000002
are the immutable bytes published on `origin/main`; their later lock-order,
retryability, terminal-projection, and receipt-link repairs live only in 000009.

Migration 000009 creates the owner-only `release_authority.schema_migration`
ledger and a least-privilege manifest routine. Fresh installs record the
canonical checksum of every file. A pre-ledger catalog is never identified by
a few columns or surviving routine fragments. In the install transaction the
installer builds canonical and exact-published-legacy shadow catalogs from the
immutable source bytes and compares a deterministic representation of every
relation, column/default, constraint, index, sequence, routine body/property,
trigger, schema/type/enum, owner, and ACL. Exactly one shadow must match before
000009 may backfill history. For a matching authority database carrying the
previously published modified 000001/000002 bytes, migration 000009 retains
those two exact legacy checksums as `legacy_equivalent` and converges their
behavior to the same forward state. Migration 000010 adds the single-use recovery-effect permit protocol
after the migration ledger exists. Existing pre-ledger authorities apply 000009
then 000010, while authorities already recorded through 000009 apply only 000010. Health requires every ordered identity through 000010, the matching
canonical/approved-legacy checksum and variant, the 000006 provider creation
column plus validated NOT NULL/order constraint and witness time bounds, the
000007 compensation fences, the 000008 helper revocation, common ownership,
exact role grants, and no PUBLIC authority privileges. A missing, reordered,
unknown, or partially applied entry is release-blocking.

An absent-ledger catalog that matches neither shadow, or matches ambiguously,
stops before history or forward repairs are written. Preserve the failed
transaction output and take a schema-only dump plus catalog/ACL/owner evidence.
Do not insert `schema_migration` rows, edit a checksum, or invoke 000009 by
itself. Recovery requires an audited object-by-object comparison against the
immutable 000001-000008 sources, an approved forward repair that explains every
difference, and then a rerun of `pnpm release-authority:install`. If exact
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
   ROLLOUT_ID="private-pg17-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$EXPECTED_SHA" | cut -c1-8)"
   gh workflow run private-network-pg17-rollout.yml \
     --ref main -f rollout_id="$ROLLOUT_ID" -f expected_sha="$EXPECTED_SHA"
   gh run list --workflow private-network-pg17-rollout.yml --branch main --limit 5
   ```

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
