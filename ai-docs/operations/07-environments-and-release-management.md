# Environments and Release Management

## Environments

Use separate environments:

```text
local
staging
production
```

Recommended:

- separate GitHub Apps for staging and production
- separate webhook secrets
- separate databases
- separate OAuth app/client secrets if applicable
- staging uses test org/repos only

## Release Flow

SaaS:

```text
pull request -> CI -> merge -> staging deploy -> smoke test -> production deploy
```

Action:

```text
merge -> release tag -> stable channel update after smoke
```

## Stable, Release, Main Channels

```text
stable - recommended SaaS UI default, resolves to explicit vetted release tag in workflow
release - pinned explicit tag selected by user
main - live updates, opt-in only
```

SaaS-generated workflows should write explicit release tags by default. The UI may call this `stable`, but the workflow should not depend on a mutable stable tag unless the user explicitly chooses that behavior. `main` is useful for internal/test repos but riskier for customers.

## Rollback

Must support:

- rollback SaaS app deploy
- pause workers
- disable runtime config fetch through feature flag
- mark bad action version as blocked
- create workflow update PR to move customers off bad version if needed

## Smoke Tests

Before production release:

- GitHub OAuth login
- GitHub App webhook delivery
- repo sync
- setup PR creation in staging repo
- OIDC config fetch from staging workflow
- health report ingestion
- Prisma migrations apply to a fresh database with `pnpm db:migrate:smoke`
- staging database is up to date with `pnpm db:migrate:deploy`

## Feature Flags

Critical flags:

```text
ENABLE_ACTION_OIDC_CONFIG
ENABLE_WORKFLOW_PROVISIONING
ENABLE_HEALTH_REPORTS
ENABLE_APP_BOT_TOKEN_IN_WORKFLOW
```

Flags must fail closed for security-sensitive features.

## Database Release Rule

Release order for database-backed changes:

```text
1. merge reviewed Prisma migration
2. run migrate deploy in staging
3. run staging smoke tests
4. deploy compatible app/worker code
5. run production migrate deploy
6. deploy production app/worker code
```

Do not deploy application code that depends on a schema change before `migrate deploy` has succeeded in that environment.
