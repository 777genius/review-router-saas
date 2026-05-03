# Migrations, Backups, and Recovery

## Database Migrations

Use Prisma migrations.

Rules:

- migrations are reviewed like code
- avoid destructive migrations without a rollback/backup plan
- large backfills run as jobs, not deploy-time blocking migrations
- application should be compatible with previous schema during rolling deploys where practical

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
