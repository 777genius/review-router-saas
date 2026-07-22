# Event Versioning and Poison Jobs

## Problem

Webhook normalization, outbox events, and background jobs will evolve. Without versioning and poison-job handling, deploys can strand old events or retry bad jobs forever.

## Event Versioning

Every persisted internal event should include:

```text
type
version
schemaVersion if separate
payloadJson
createdAt
```

Event handlers must either:

- support the event version
- migrate it
- mark it unsupported with safe error

Do not silently parse unknown event versions as latest.

## Outbox Event Rules

- outbox events are append-only
- processing is idempotent
- handler records attempts and last error
- handler has max attempts
- handler can schedule retry with backoff
- stale `processing` events must recover automatically after a conservative timeout

## Poison Jobs

A poison job is a job that repeatedly fails due to invalid state, unsupported event version, bad payload, or persistent external failure.

Policy:

```text
retry transient failures with backoff
stop retrying after max attempts
mark as dead_letter or failed_permanent
surface safe summary in support dashboard
require manual retry after fix
```

Manual retry must be explicit, authorized, and audited. It should reset a
`dead_letter` event to `pending`, reset attempts, and let the normal worker path
process it again. Do not mutate the payload during retry.

Stale `processing` recovery is different from manual retry:

- it only applies to events claimed by a worker but not completed before timeout
- it requeues as `retry_wait` with a safe `processing_stale` summary
- it should use a high enough timeout to avoid duplicate long-running work
- it must remain idempotent because more than one worker can attempt recovery

## Dead Letter Fields

```text
jobId
type
idempotencyKey
workspaceId nullable
repoId nullable
lastErrorCode
safeLastErrorSummary
attempts
failedAt
manualRetryAllowed
```

## Deploy Compatibility

During rolling deploys:

- old workers may see new events
- new workers may see old events
- event handlers must tolerate this through explicit versions
- deploy should not remove support for recent event versions until queues are drained

## Tests

## Review v2 Events And Fencing

Review integration events use a closed type/version registry. Each source-state
transition and outbox insert is one operation-specific transaction. Outbox claims
carry never-reused `bigint` fencing terms; heartbeat and acknowledgement compare
claim ID, owner and term. Dead-letter replay may wake the idempotent completion
process but cannot create a publication attempt, receipt or business terminal
state. Recovery scans independently find finalized artifacts missing a process.

- unknown event version goes to safe dead letter
- transient GitHub rate limit retries with backoff
- permanent permission error stops retrying and is user-visible
- manual retry works after state is fixed
- stale processing event is recovered and then processed
