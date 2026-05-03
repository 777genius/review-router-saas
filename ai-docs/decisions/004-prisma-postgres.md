# ADR-004: Prisma + PostgreSQL

## Status

Accepted.

## Decision

Use PostgreSQL as primary database and Prisma as ORM for v0/v1.

## Rationale

Prisma is familiar, productive, and good enough for the initial SaaS workload: users, workspaces, installations, repositories, configs, audit, webhook deliveries, jobs metadata, and entitlements.

Drizzle was considered. It is attractive for SQL-first work, but Prisma gives faster MVP velocity and lower team friction now.

## Rule

Prisma types must not leak into domain/application layers.

Prisma belongs in infrastructure adapters only:

```text
features/<feature>/infrastructure/prisma/*
```

## Future Path

If analytics or complex read models become painful, add Kysely or raw SQL for read-side queries. Do not introduce two database abstractions in v0.

## Consequences

Positive:

- faster delivery
- Prisma Studio and migrations
- known developer experience
- sufficient for v1 data model

Negative:

- ORM abstraction can hide SQL cost
- generated types can leak if boundaries are weak
- complex reporting may need SQL-oriented read models later
