# Iteration 07 - Webhooks, Jobs, Locks, and Outbox

## Goal

Make backend safe for duplicate GitHub webhooks and multiple worker instances.

## Scope

- GitHubWebhookDelivery table
- webhook normalization into safe internal events
- DistributedLock port
- PostgresAdvisoryLock adapter
- pg-boss queue integration
- OutboxEvent table with event type/version
- outbox worker
- idempotent job handlers
- poison job/dead-letter handling

## Required Scenarios

- duplicate webhook returns success but does not duplicate side effects
- two setup requests do not create duplicate PRs
- installation sync can retry safely
- failed jobs persist useful error summaries

## Tests

- webhook replay test
- webhook normalization test excludes PR/comment bodies
- concurrent provisioning test
- lock contention test
- outbox processing retry test
- unknown event version dead-letters safely

## Done When

- API/worker can scale to multiple instances safely for core flows
