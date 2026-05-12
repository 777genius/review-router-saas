# ADR-026: Balanced Memory Transaction and Outbox Strategy

## Status

Accepted.

## Decision

Memory mutations that change canonical state must write canonical records,
audit metadata and outbox events in one transaction through
`MemoryTransactionPort`. Provider calls, embedding work and search indexing are
outbox-driven and retryable after commit.

## Rationale

Memory state, audit and search lifecycle must not drift. Direct provider calls
inside use cases would make retries unsafe and couple privacy-sensitive logic to
external services.

## Rules

- Create, confirm, edit, disable, delete, expiry and prune use transaction
  boundaries.
- Outbox payloads contain ids, versions, hashes and safe metadata only.
- Reindex and delete handlers are idempotent.
- Stale or inactive items are marked non-indexed instead of resurrected.
- Dead-lettered memory outbox events require operational visibility.
- Use cases do not call embedding providers directly.

## Consequences

Positive:

- memory lifecycle remains auditable and retry-safe
- provider outages do not corrupt canonical state
- indexing can be rebuilt or replaced later

Negative:

- search updates are eventually consistent
- workers and runbooks must cover stuck outbox events
