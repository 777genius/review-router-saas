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

Control, provider authority, and witness must use distinct tokens/database roles. Control and witness must be healthy and
resolve from `REVIEW_ROUTER_RELEASE_CONTROL_URL` and
`REVIEW_ROUTER_RELEASE_WITNESS_URL` to different services.

## Configuration matrix

Repository variables:

| Group             | Variables                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workflow identity | `REVIEW_ROUTER_RELEASE_CONTROL_ORG`, `REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY`                                                   |
| Service origins   | `REVIEW_ROUTER_RELEASE_CONTROL_URL`, `REVIEW_ROUTER_RELEASE_WITNESS_URL`                                                          |
| Runners           | `REVIEW_ROUTER_RUNNER_GROUP_ID`, `REVIEW_ROUTER_RUNNER_GROUP_NAME`, `REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID`                        |
| Provider          | `REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS`, `RENDER_OWNER_ID`                                                                      |
| Generations       | source/target `RENDER_DATABASE_ID`, `INTERNAL_HOSTNAME`, `DATABASE_NAME`, `DATABASE_SYSTEM_IDENTIFIER`, `RECOVERY_WITNESS_SHA256` |
| Release           | `REVIEW_ROUTER_RELEASE_IMAGE_DIGEST`, `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, `REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON`  |
| Canary            | `REVIEW_ROUTER_LIVE_CANARY_URL`                                                                                                   |

Protected environment secrets:

| Environment                     | Secrets                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production-release-preflight`  | release-control token                                                                                                                                           |
| `production-runner-control`     | release-control token; suspension and/or runner-control key per job                                                                                             |
| `production-role-bootstrap`     | release-control token, provenance key, source compensation/copy URL, reconnect URLs, role-bootstrap/release-migration URLs, target runtime URLs, backup witness |
| `production-runner-ledger-read` | release-control token                                                                                                                                           |
| `production`                    | release-control token, target-switch key, release-migration and target runtime URLs                                                                             |
| `production-service-switch`     | release-control token, suspension key, live-canary token                                                                                                        |

Server-only service values:

| Service | Values                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Control | authority control DB URL, provider-authority DB URL, distinct control/provider token SHA-256 values, permit-installer DB URL |
| Witness | authority witness DB URL, witness token SHA-256                                                                              |

Actions receives the plaintext control token; services store its SHA-256. Logs
and artifacts may contain IDs/digests, never URLs, tokens, passwords, backup
material, or raw recovery witnesses.

## Provision once

1. Create a dedicated PostgreSQL 17 authority DB, distinct
   `reviewrouter_release_control`, `reviewrouter_provider_authority`, and `reviewrouter_release_witness` logins,
   and apply
   `packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql`
   as owner. Retain this DB across cutovers.
2. Deploy control and witness from the same immutable release and verify their
   `/health` service identities.
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
