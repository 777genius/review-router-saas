# Migrations, Backups, and Recovery

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
