# ADR-011: pg-boss First for Background Jobs

## Status

Accepted.

## Decision

Use pg-boss as the first background job system.

## Rationale

ReviewRouter already depends on PostgreSQL. pg-boss keeps the lean beta simpler by avoiding Redis or another queue service while still supporting durable jobs and multiple worker instances.

BullMQ remains a future option if Redis becomes necessary for higher throughput or more advanced scheduling.

## Scope

Use pg-boss for:

- installation sync
- repository sync
- workflow provisioning
- health checks
- outbox processing
- retryable GitHub API operations

## Rules

- every job must have an idempotency key or be safe to retry
- long work must run in workers, not HTTP handlers
- job errors must persist safe user-facing summaries
- job handlers must use distributed locks where side effects can conflict

## Consequences

Positive:

- fewer moving parts
- easier local dev
- strong enough for beta scale
- compatible with horizontal workers

Negative:

- Postgres bears queue load
- may need Redis/BullMQ later at higher scale
- requires monitoring queue table growth
