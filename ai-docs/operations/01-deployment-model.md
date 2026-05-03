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
GITHUB_WEBHOOK_SECRET
SESSION_SECRET
APP_BASE_URL
LOG_LEVEL
```

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
