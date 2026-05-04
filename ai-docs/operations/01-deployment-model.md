# Deployment Model

## Lean Beta Deployment

Minimum deployable units:

```text
web - Next.js dashboard
api - Fastify API/webhooks
worker - background jobs/outbox
postgres - managed Postgres
```

Can initially deploy web/api together if platform makes it easier, but code should keep them separable.

## Stateless Services

`web`, `api`, and `worker` should be stateless.

No correctness state in memory:

- no in-memory sessions
- no in-memory locks
- no in-memory webhook dedupe
- no in-memory job state

## Environment Configuration

Use validated env schema.

Likely env groups:

```text
DATABASE_URL
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_PRIVATE_KEY_FILE
GITHUB_WEBHOOK_SECRET
SESSION_SECRET
APP_BASE_URL
LOG_LEVEL
```

Use `GITHUB_APP_PRIVATE_KEY` for hosted secret managers. Use
`GITHUB_APP_PRIVATE_KEY_FILE` for local development or file-mounted secrets.
The inline env value may contain escaped newlines (`\n`); runtime config
normalizes it before creating GitHub App installation tokens.

## Runtime Commands

Production API and worker boot from compiled JavaScript:

```bash
pnpm build
pnpm api:start
pnpm worker:start
```

The start scripts use:

```text
node --conditions=production
```

Do not remove this condition unless package exports are redesigned. In
development, workspace packages export `src/*.ts` for Next/Turbopack and tsx.
In production, the `production` export condition points Node at `dist/*.js`.

After build/export/startup changes, run:

```bash
pnpm runtime:smoke
```

This starts the compiled API, checks `/health`, then starts the compiled worker
once with `REVIEW_ROUTER_WORKER_ONCE=1`.

## Scaling Path

Start:

```text
1 web/api instance
1 worker instance
managed Postgres
```

Scale:

```text
N api instances behind load balancer
N worker instances
Postgres locks/queue ensure correctness
```

## Do Not Add Early

- Kubernetes unless needed
- Kafka unless Postgres queue is insufficient
- Redis unless locks/queue pressure requires it
- cloud review workers
