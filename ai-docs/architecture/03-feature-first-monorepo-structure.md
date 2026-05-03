# Feature-First Monorepo Structure

## Target Structure

```text
review-router/
  apps/
    web/
    api/
    worker/

  packages/
    platform/
      db/
      config/
      logger/
      crypto/
      queue/
      locks/
      github-http/
      telemetry/

    features/
      identity-access/
      github-installations/
      repository-management/
      review-configuration/
      workflow-provisioning/
      provider-setup/
      webhook-ingestion/
      action-control-plane/
      audit-log/
      billing-entitlements/

    shared/
      result/
      errors/
      ids/
      time/
      validation/
```

## Standard Feature Layout

```text
features/<feature>/
  domain/
    entities/
    value-objects/
    aggregates/
    domain-events/
    services/
    errors.ts

  application/
    commands/
    queries/
    handlers/
    ports/
    policies/

  infrastructure/
    prisma/
    github/
    queue/
    locks/

  interface/
    http/
    trpc/
    jobs/

  tests/
    unit/
    integration/
```

## Import Rules

Allowed:

```text
domain -> shared only
application -> domain + application ports + shared
infrastructure -> application ports + platform adapters + external SDKs
interface -> application handlers + Fastify/tRPC/job framework
apps -> feature interface modules + platform composition root
```

Forbidden:

```text
domain -> Prisma, Octokit, Fastify, tRPC, Next.js
application -> Prisma, Octokit, Fastify, tRPC, Next.js
features -> importing another feature's infrastructure
```

## Cross-Feature Communication

Preferred:

- application events
- outbox events
- explicit application service calls through public feature APIs

Avoid:

- direct DB table access from another feature
- importing another feature's Prisma repositories
- shared god services

## Composition Root

`apps/api` and `apps/worker` wire dependencies:

```text
Prisma client
Octokit factories
lock adapter
queue adapter
feature repositories
use cases
Fastify/tRPC routes
job handlers
```

The composition root is allowed to know concrete implementations. Domain/application are not.
