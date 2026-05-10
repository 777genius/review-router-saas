# ReviewRouter Deploy Handoff

This repo is currently optimized for local/private beta and a lean hosted beta.
The hosted model is still control-plane only: customer code review runs inside
customer GitHub Actions, not on ReviewRouter servers.

## Services

Run these as separate process types when possible:

```text
web    - Next.js dashboard and Auth.js routes
api    - Fastify API, GitHub webhooks, action control-plane endpoints
worker - outbox/repository sync/background maintenance
postgres - managed Postgres
```

Web and API can share one deployment target for a small beta, but keep their
commands separate so they can scale independently later.

## Render Blueprint

Render is the preferred first hosted beta target. The root `render.yaml`
defines web/API/worker/Postgres plus a shared env group. See
[`deploy/render.md`](./render.md) for the exact Blueprint flow and post-sync
GitHub App settings.

## Build

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
```

`pnpm build` compiles packages/apps and rewrites compiled ESM imports in `dist`
so Node can start the API and worker without `tsx`.

## Migrate

Run before starting new app instances:

```bash
pnpm db:migrate:deploy
```

For rollout safety, check migration status first:

```bash
pnpm db:migrate:status
```

## Start Commands

Web:

```bash
PORT=3000 pnpm web:start
```

API:

```bash
HOST=0.0.0.0 PORT=${PORT:-4000} pnpm api:start
```

Worker:

```bash
pnpm worker:start
```

API and worker start through `node --conditions=production`. That condition is
required because package exports use `src/*.ts` for dev tooling and `dist/*.js`
for production Node runtime.

## Required Secrets

Use `deploy/env.production.example` as the source of truth. Critical rules:

- put `GITHUB_APP_PRIVATE_KEY` in the host secret manager for hosted deploys
- use `GITHUB_APP_PRIVATE_KEY_FILE` only for local or file-mounted secret setups
- never store Codex OAuth or provider API keys in SaaS env
- provider credentials stay in customer GitHub Actions secrets
- `REVIEW_ROUTER_ACTION_SESSION_SECRET` must be at least 32 chars

## GitHub App URLs

For hosted beta, configure the GitHub App with the deployed URLs:

```text
Callback URL:  https://<web-host>/api/auth/callback/github
Setup URL:     https://<web-host>/setup
Webhook URL:   https://<api-host>/webhooks/github
```

Required repository permissions:

```text
Contents: write
Workflows: write
Pull requests: write
Issues: write
Secrets: read
Actions: read
Checks: write
Commit statuses: write
Metadata: read
```

Required webhook event subscriptions:

```text
Pull request
Workflow run
Repository
Workflow job
Check run
Issue comment
Status
Installation
Installation repositories
```

Set `REVIEW_ROUTER_PUBLIC_API_URL` to the same public HTTPS API host. Generated
customer workflows use this URL for OIDC/config/health-report calls. Production
workflow provisioning rejects localhost and non-HTTPS URLs.

Enable setup redirect after installation updates so users return to the
dashboard when repositories are added or removed.

## Smoke After Deploy

Before deploying with a prepared staging/prod env file:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm hosted:check
```

Before inviting hosted testers, verify that the GitHub App credentials, required
permissions, and hosted lifecycle webhook events are actually configured:

```bash
REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted pnpm github-app:check
```

Full public-beta doctor command:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm public-beta:check
```

This command uses the same hosted env file for both app runtime validation and
GitHub App hosted readiness. Do not run the GitHub App hosted check against
`.env.local` when validating staging or production.

The hosted readiness gate rejects localhost/non-HTTPS public URLs, placeholder
GitHub App secrets, missing private key, disabled provisioning, and provider
credentials accidentally placed in SaaS env.

Local production-runtime smoke:

```bash
pnpm build
pnpm runtime:smoke
```

Full local beta gate:

```bash
pnpm beta:check
```

DB/protocol gate:

```bash
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
```

Hosted public-beta is not ready until this path passes from GitHub-hosted
Actions against the public API URL:

```text
GitHub-hosted runner -> public HTTPS API -> OIDC exchange -> config fetch -> health report
```

## Operational Notes

- Deploy web/API/worker from the same git SHA.
- Run only one migration job per deploy.
- Worker can scale horizontally because outbox and locks are DB-backed.
- Do not enable cloud review execution in v1.
- Do not add `pull_request_target` to generated customer workflows.
