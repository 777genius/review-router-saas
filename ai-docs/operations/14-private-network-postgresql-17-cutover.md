# Private-network PostgreSQL 17 cutover

This runbook covers only the database-generation cutover. Git flow, release
tags, exact-commit verification, and general deploy sequencing remain governed
by [07-environments-and-release-management.md](./07-environments-and-release-management.md).
Do not use this runbook to bypass those gates.

The production path is
`.github/workflows/private-network-pg17-rollout.yml`. The three older rotating
bootstrap, migration, and evidence workflows are aliases to that protected
workflow; they no longer contain GitHub-hosted database jobs.

## Non-negotiable topology

- Source and target are separate private Render database resources. Source is
  PostgreSQL 16.13 and target is PostgreSQL 17. Their Render resource IDs,
  PostgreSQL system identifiers, and recovery-witness hashes must all differ as
  specified by the workflow inputs and protected variables.
- A GitHub-hosted job may inspect/freeze Render and provision or verify cleanup
  of a one-off runner. It receives no database URL and runs no PostgreSQL tool.
- Every database operation runs on a newly generated repository-level JIT
  runner inside Render's private network. The label binds repository, run ID,
  run attempt, exact commit, and purpose. A runner accepts one job only.
- `reviewrouter-runner-base` contains the narrowly scoped GitHub App bootstrap
  credential but no database credential. The bootstrap exchanges it for JIT
  configuration, deletes all App/token environment entries, and only then
  starts `Runner.Listener`. Its image, base deploy, and runner tarball digest
  are immutable inputs.
- The `production-role-bootstrap` environment is the only job that exposes the
  role-bootstrap URL. The subsequent `production` cutover job cannot reference
  that credential.

## Protected configuration

`production-runner-control` contains the Render API credential and these
non-secret variables:

```text
RENDER_OWNER_ID
REVIEW_ROUTER_RENDER_FROZEN_SERVICE_IDS
REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID
REVIEW_ROUTER_RUNNER_BASE_DEPLOY_ID
REVIEW_ROUTER_RUNNER_BASE_IMAGE_DIGEST
REVIEW_ROUTER_RELEASE_ACTORS
```

The dedicated runner-base service contains only the GitHub bootstrap secrets
and non-secret policy values:

```text
REVIEW_ROUTER_RUNNER_GITHUB_APP_ID
REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID
REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY
REVIEW_ROUTER_RUNNER_EXPECTED_REPOSITORY
REVIEW_ROUTER_RUNNER_EXPECTED_ACTOR
REVIEW_ROUTER_RUNNER_NO_JOB_TIMEOUT_MS
```

It must not inherit an environment group containing `DATABASE_URL`, a
`REVIEW_ROUTER_*_DATABASE_URL`, `PGPASSWORD`, Render API credentials, or runtime
application secrets.

The `production` environment supplies explicit source/target identities,
backup/PITR identity, exact staged-service deploy/image expectations, the
source copy URL, target copy URL, and canonical target runtime/migration URLs.
The source and target URLs must use private hostnames. No public database
allowlist is permitted.

## Sequence and evidence

Dispatch from `refs/heads/main` with a never-before-used rollout ID and the
exact checked commit. A protected-environment reviewer verifies the actor and
commit before approval.

1. `freeze-provider-services` runs before any database is selected. It proves
   every writer has `autoDeployTrigger: off`, nested
   `envSpecificDetails.preDeployCommand: ""`, and no active deploy.
2. A unique copy/bootstrap runner verifies source PG16 and target PG17 identities,
   captures the protected backup/PITR identity, creates a custom-format
   `pg_dump --no-owner --no-privileges`, and records its SHA-256.
3. Writer services stay suspended. Runtime `CONNECT` is revoked on source,
   existing non-cutover sessions are terminated, and the observed count must be
   zero. Until activation, PG16 remains the sole authoritative generation.
4. The digest-checked dump is restored as the bootstrap role into an empty PG17 database without
   ownership or ACL metadata. Table sets, row counts, per-table canonical row
   hashes, sequences, constraints, indexes, and `_prisma_migrations` history
   must match before migration.
5. The same private job executes the existing canonical role bootstrap after
   equivalence. It transfers restored public objects to the release role and
   proves the exact five-edge grantor topology. Its JIT runner is terminal and
   cleanup-proven before the cutover runner is provisioned.
6. The unique cutover runner executes the existing canonical migration,
   generation observation, receipt logic,
   role topology check, and exact runtime-grant generator run with
   `REVIEW_ROUTER_RELEASE_ACL_GATE_MODE=closed`. Grant convergence and the
   subsequent `CONNECT`/DML/sequence revocation share one transaction, so target
   writes were never externally open.
7. Target services must match the exact target database resource, release
   commit, deploy ID, and image digest and remain suspended with an empty
   pre-deploy command.
8. Activation runs the canonical grants and inserts the immutable
   `ReleaseGenerationActivationReceipt` in one transaction. That commit is the
   first-write boundary. A conflicting receipt replay is fatal.
9. The private job uploads the generation/equivalence/activation body. Render
   cleanup jobs upload terminal workspace/credential-cleanup receipts. Assemble
   them offline with `pnpm release-rollout:evidence:assemble`, then verify with
   `pnpm release-rollout:evidence:verify <file>`. Do not accept either half by
   itself as trusted rollout evidence.

The aggregate binds both runner names/JIT labels, runner-base service/deploy/image,
source and target Render IDs, both PostgreSQL identities, backup and PITR IDs,
quiescence, dump digest, every equivalence result, pre-activation ACL state,
the exact activation transaction, and cleanup. Unknown fields, field splices,
generation mismatch, digest mismatch, or missing cleanup fail verification.

## Rollback boundary

Before the activation transaction commits, rollback means discard PG17,
restore source canonical `CONNECT`/runtime privileges in one reviewed
transaction, and resume the frozen PG16 writers. Never declare PG17
authoritative before that restoration is verified.

After the first accepted PG17 write, PG16 is permanently ineligible for
promotion. Recovery is PG17 forward repair, PG17 PITR, or an application
rollback proven compatible with the PG17 schema. Pointing services back at
PG16 would discard accepted writes and is forbidden by the rollout state
machine and evidence verifier.

## Disposable rehearsal

Resolve immutable multi-architecture image digests and run only against the
local disposable Docker network:

```bash
REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL=1 \
REVIEW_ROUTER_REHEARSAL_PG16_IMAGE='postgres:16.13-bookworm@sha256:<digest>' \
REVIEW_ROUTER_REHEARSAL_PG17_IMAGE='postgres:17-bookworm@sha256:<digest>' \
pnpm release-rollout:rehearsal
```

The command creates uniquely named local containers, proves version/copy/data
equivalence/ACL activation, and removes the exact containers and network before
returning evidence. It has no provider, GitHub, or production database path.

## Provider API uncertainty

Render one-off job, nested service, staged-service, and cleanup response shapes
are strict adapter contracts. Extra/missing fields, mutable image facts, reused
JIT state, or absent cleanup proof fail closed. If Render's documented response
changes, update the adapter contract and adversarial tests first; do not loosen
validation during a production attempt or retry repeatedly.
