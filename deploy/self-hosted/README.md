# ReviewRouter Self-Hosted Control Plane

This runs the ReviewRouter control plane on your own host for repositories on
github.com. Customer code review still runs inside the customer's GitHub
Actions workflow. The self-hosted server stores metadata, configuration,
webhook state, sessions, outbox jobs, and health data in Postgres.

This guide does not cover GitHub Enterprise Server, air-gapped deployments, or
cloud review execution.

## Services

The Compose stack starts:

```text
postgres - ReviewRouter metadata database
migrate  - one-shot Prisma migration job
web      - Next.js dashboard and Auth.js routes
api      - Fastify API, GitHub webhooks, action OIDC/config endpoints
worker   - outbox, repository sync, and maintenance jobs
```

The same Docker image is used for `web`, `api`, `worker`, and `migrate`.
The image keeps the Prisma CLI available so self-hosted upgrades can run
migrations without a separate tool container.

## Prerequisites

- Docker with Compose v2.
- Public DNS for the web and API hosts.
- Public HTTPS termination in front of the exposed web/API ports.
- A GitHub App owned by the operator of this self-hosted instance.
- Outbound access from the host to `github.com`, `api.github.com`, and GitHub
  OIDC/JWKS endpoints.

Recommended versions in this stack:

- Node.js 24 LTS for the app image.
- PostgreSQL 18 for the bundled local database.

## 1. Prepare Env

```bash
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
```

Generate secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 32
```

Use those values for:

```text
AUTH_SECRET
REVIEW_ROUTER_ACTION_SESSION_SECRET
REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY
GITHUB_WEBHOOK_SECRET
POSTGRES_PASSWORD
```

Keep `DATABASE_URL` in sync with `POSTGRES_PASSWORD`.

## 2. Create GitHub App

Create a GitHub App for the self-hosted instance and configure:

```text
Callback URL:  https://<web-host>/api/auth/callback/github
Setup URL:     https://<web-host>/setup
Webhook URL:   https://<api-host>/webhooks/github
```

Set these env vars from the App settings:

```text
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_SLUG
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` should match the App client ID
and secret. For `GITHUB_APP_PRIVATE_KEY`, paste the PEM into the env file with
escaped newlines (`\n`).

Required repository permissions:

```text
Contents: write
Workflows: write
Pull requests: write
Issues: write
Secrets: write
Organization secrets: read
Actions: read
Checks: write
Commit statuses: write
Metadata: read
```

Required webhook events:

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
GitHub App authorization
```

Enable redirect after installation updates so users return to the dashboard.

## 3. Check Config

From the repository root:

```bash
pnpm self-hosted:check
```

Or point the checker at a different env file:

```bash
REVIEW_ROUTER_SELF_HOSTED_ENV_FILE=/path/to/reviewrouter.env pnpm self-hosted:check
```

The checker rejects local/non-HTTPS public URLs, missing GitHub App values,
placeholder secrets, provider credentials in server env, and invalid action
refs.

## 4. Start

From `deploy/self-hosted`:

```bash
docker compose up -d --build
```

From the repository root:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

The `migrate` service runs `pnpm db:migrate:deploy` before `web`, `api`, and
`worker` start.

Check status:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  ps
curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:3000/status
```

Your public reverse proxy should route:

```text
https://<web-host> -> 127.0.0.1:3000
https://<api-host> -> 127.0.0.1:4000
```

## 5. Upgrade

```bash
git pull
pnpm self-hosted:check
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

The migration job is idempotent and runs before app services.

## Backups

Create a backup:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > reviewrouter.dump
```

Restore into a stopped or fresh stack after creating the database:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < reviewrouter.dump
```

## Scaling

The API and worker are stateless. Start with one instance each. Scale workers
only after the database has enough capacity:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --scale worker=2
```

Keep all services on the same git SHA/image tag.

## Security Notes

- Do not put `CODEX_AUTH_JSON`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, or model/provider credentials in this env file.
- Provider credentials belong in customer GitHub repo/org Actions secrets.
- Keep Postgres bound to localhost unless you put it on a private network.
- Use HTTPS for public web/API URLs. Generated customer workflows depend on
  `REVIEW_ROUTER_PUBLIC_API_URL`.
- Do not add `pull_request_target` to generated customer workflows.
