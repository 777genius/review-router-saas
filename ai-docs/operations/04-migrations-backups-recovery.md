# Migrations, Backups, and Recovery

## Review v2 Expand And Backfill

Run `pnpm review-v2:migrate -- --status` before apply, then
`pnpm review-v2:migrate -- --apply --actor=<operator>`. The job verifies the exact
schema digest, takes a per-step advisory transaction lock, records checkpoint
state, backfills permanent SCM identities, quarantines collisions and validates
`NOT VALID` foreign keys. It is safe to resume an interrupted `running` step and
refuses invalid/missing concurrent indexes. Rollback disables writers and retains
all additive business/audit rows; it never drops v2 state.

`pnpm review-v2:migration-rehearsal` must pass on a disposable database before
writer rollout.

### Migration 000033 preflight

`000033_review_request_dispatch_lanes` is additive, but intentionally fails before
creating its partial unique indexes when any of these conditions exists:

- more than one active `provider_execution` lease for a provider vote identity;
- an active provider lease whose expiry is already in the past;
- duplicate non-null repository/run/attempt request identities;
- more than one `pending_dispatch` request for a PR scope.

Do not delete conflicting rows to make deployment pass. Pause new v2 work, let the
fenced worker expire/reconcile leases and intents, inspect the safe identifiers,
then rerun the migration. The migration adds only `dispatchAttempt`, its bounded
check, and partial unique indexes. Rollback disables intent ingress/dispatch and
retains the column, intents, leases, and audit history; no down-migration is used.

The release gate must apply all migrations to a newly created local database whose
name contains `test` or `ci`, then run the real Prisma review-execution contract and
the production-shaped review-v2 E2E. This verifies both cross-PR provider
serialization and stale-claim takeover against PostgreSQL rather than only memory
adapters.

## Database Migrations

Use Prisma migrations.

Rules:

- migrations are reviewed like code
- new environments are created with `pnpm db:migrate:deploy`, not `db push`
- local migration smoke must pass with `pnpm db:migrate:smoke` before public beta changes
- avoid destructive migrations without a rollback/backup plan
- large backfills run as jobs, not deploy-time blocking migrations
- application should be compatible with previous schema during rolling deploys where practical

## Current Migration Baseline

The first checked-in migration is:

```text
packages/platform/db/prisma/migrations/000001_init/migration.sql
```

It is a baseline generated from the current Prisma schema after early local development used `prisma db push`. Existing local dev/test databases can mark this baseline as applied; new databases must apply it normally.

Safe local commands:

```bash
pnpm db:migrate:deploy
pnpm db:migrate:status
pnpm db:migrate:smoke
pnpm db:restore:smoke
```

Do not use `pnpm db:push` for production-like environments. Keep it only as an explicit local escape hatch during spikes, and replace any resulting schema change with a reviewed migration before merging.

## Creating Future Migrations

For non-destructive schema changes:

```bash
pnpm db:migrate
pnpm db:migrate:smoke
```

Then review the generated SQL. If Prisma generates destructive SQL, stop and write a forward-compatible migration plan:

```text
1. add nullable/new structure
2. deploy compatible app code
3. backfill through a job
4. add constraints or remove old structure in a later migration
```

For existing local databases that already match a manually pushed baseline, use `prisma migrate resolve --applied <migration>` only after confirming the schema matches. Never use `migrate reset` on a database containing useful local or production data.

## Backup Policy

Beta minimum:

- managed Postgres automated backups enabled
- daily backups
- point-in-time recovery if provider supports it
- test restore before public beta

Local restore drill:

```bash
pnpm db:restore:smoke
```

The smoke creates a temporary custom-format `pg_dump` from `DATABASE_URL` or
`REVIEW_ROUTER_BACKUP_SOURCE_URL`, restores it into a disposable database,
verifies critical tables/indexes and metadata row counts, then drops the
disposable database and deletes the temporary dump. It must not print table
data, secrets, provider tokens, repository code, prompts, or diffs.

## Recovery Objectives

Initial targets:

```text
RPO: 24 hours for beta metadata
RTO: best effort during beta, target under 4 hours later
```

Because ReviewRouter v1 does not store source code or secrets, backup sensitivity is lower, but workspace/config/audit data still matters.

## Rollback Strategy

Deployments should support:

- rolling back app code
- disabling new features through config flags
- pausing workers
- replaying pending outbox events after fix

## Data Corruption Scenarios

Prepare for:

- duplicate repository records
- bad config version rollout
- stuck workflow provisioning state
- accidental workspace membership change
- failed migration

Each scenario needs either a runbook or repair script before public beta.

## Migration Definition Of Done

Every migration change must prove:

- applies to an empty database with `pnpm db:migrate:smoke`
- existing dev/test databases report up-to-date with `pnpm db:migrate:status`
- critical uniqueness/idempotency invariants are represented in the Prisma schema and SQL
- no migration logs include secrets, provider tokens, repository code, prompts, or diffs
