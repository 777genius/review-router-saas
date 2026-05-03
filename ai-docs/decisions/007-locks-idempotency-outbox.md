# ADR-007: Postgres Locks, Idempotency, and Outbox

## Status

Accepted.

## Decision

Use Postgres-backed distributed coordination from day one:

- lease-table locks for cross-instance mutual exclusion
- webhook delivery idempotency table
- queue unique/singleton jobs
- outbox pattern for reliable app events

## Rationale

ReviewRouter must be able to run multiple API and worker instances behind a load balancer. In-memory mutexes are not correctness mechanisms in that environment.

## Required Locks

```text
installation:{installationId}:sync
repo:{repoId}:workflow-provision
repo:{repoId}:health-check
workspace:{workspaceId}:config-rollout
```

## Idempotency Tables

```text
GitHubWebhookDelivery(deliveryId unique, eventName, status, receivedAt, processedAt)
OutboxEvent(id, type, aggregateId, payload, status, occurredAt, processedAt)
JobExecution(idempotencyKey unique, type, status, attempts)
```

## Transaction Rule

Do not keep database transactions open during long external GitHub API calls.

Preferred pattern:

```text
1. transaction: record intent and enqueue job
2. commit
3. external GitHub call
4. transaction: persist result and audit event
```

## Consequences

Positive:

- safe retries
- safe horizontal scaling
- fewer duplicate setup PRs
- fewer duplicate audit/config events

Negative:

- more code up front
- requires careful job design
- requires operational visibility for stuck leases/jobs
