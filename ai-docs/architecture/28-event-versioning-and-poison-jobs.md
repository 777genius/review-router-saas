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

- unknown event version goes to safe dead letter
- transient GitHub rate limit retries with backoff
- permanent permission error stops retrying and is user-visible
- manual retry works after state is fixed
