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
merge -> release tag -> smoke release -> move v1 stable channel
```

## Stable, Release, Main Channels

```text
stable - recommended SaaS UI default, resolves to explicit vetted release tag in workflow
release - pinned explicit tag selected by user
main - live updates, opt-in only
```

Current production policy uses `v1` as a moving stable major channel. New setup
PRs write `777genius/review-router@v1` and `runtime_ref: v1`; existing
repositories on `@v1` receive compatible v1 fixes without a workflow PR.

The `v1` channel must be moved only after a concrete `v1.0.x` release has passed
smoke. Move it in both repositories together:

```bash
pnpm release:sync-major -- --version v1.0.37 --confirm
```

This updates:

- `777genius/review-router@v1` for reusable workflow definitions
- `777genius/review-router-saas@v1` for the trusted runtime checkout

Pinned release mode remains the safer conservative option for customers who do
not want automatic compatible updates.

Local/private beta is the temporary exception: generated workflows default to
`777genius/review-router@main` so smoke repositories receive runtime fixes
immediately. Before public launch, change `REVIEW_ROUTER_ACTION_VERSION` to the
vetted stable channel or release tag and smoke that release.

## Rollback

Must support:

- rollback SaaS app deploy
- pause workers
- disable runtime config fetch through feature flag
- mark bad action version as blocked
- create workflow update PR to move customers off bad version if needed
- if the bad version is on the moving stable channel, move `v1` back to the last
  known-good `v1.0.x` in both repositories and then publish a fixed release

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
