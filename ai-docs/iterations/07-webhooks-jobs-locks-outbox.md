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

## Implemented Baseline

- `apps/worker` runs the outbox processor continuously by default.
- `REVIEW_ROUTER_WORKER_ONCE=1` keeps a deterministic one-batch mode for smoke tests.
- Worker polling uses separate busy/idle/error delays.
- Unexpected worker errors are logged through a redacted safe summary.
- If no outbox handlers are registered, the worker exits without claiming events. This prevents misconfigured deployments from turning pending side effects into dead letters.
- Worker recovers stale `processing` events after `REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS` instead of leaving them stuck forever after a crash.
- Dashboard exposes recent outbox failures and supports audited manual retry for `dead_letter` events.
- Local DB E2E covers dead-letter retry and stale processing recovery:

```bash
node scripts/run-with-env.mjs pnpm spike:outbox-maintenance:e2e
```

Current smoke:

```bash
GITHUB_APP_ID= GITHUB_APP_PRIVATE_KEY_FILE= REVIEW_ROUTER_WORKER_ONCE=1 node scripts/run-with-env.mjs pnpm --dir apps/worker exec tsx src/worker.ts
```

Expected: worker exits without claiming events.
