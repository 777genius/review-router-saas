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

Public production SaaS-generated workflows should write explicit release tags by
default. The UI may call this `stable`, but the workflow should not depend on a
mutable stable tag unless the user explicitly chooses that behavior.

Local/private beta is the temporary exception: generated workflows default to
`777genius/review-router@main` so smoke repositories receive runtime fixes
immediately. Before public launch, change `REVIEW_ROUTER_ACTION_VERSION` to the
vetted release tag and smoke that release.

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
REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE
REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS
REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS
```

Flags must fail closed for security-sensitive features.

`REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS` is a comma-separated exact-match
blocklist for known-bad installed Action versions, for example
`v1.0.0,main-bad-sha`. It should be used as an emergency stopgap and followed
by a workflow update PR.

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
