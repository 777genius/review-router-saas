# Review investigation shadow evidence

## Purpose

Record-only review investigations need a durable terminal result for side-by-side
analysis. They must not become normal review observations before the verified
promotion path is enabled.

`ReviewInvestigationShadowEvidence` is a separate Review Evidence ledger. Its
domain authority is always `non_authoritative`, and its source is always a
terminal investigation certificate.

## Invariants

- A shadow record never has lease, attempt, work-slot observation, reuse, quorum,
  publication, or verified-clean authority.
- Normal `ReviewEvidenceObservation` repositories and queries cannot read the
  shadow table. Consumers must depend explicitly on the shadow query port.
- The projection verifies the complete certificate digest, exact scope digest,
  revision and aggregate lineage, terminal payload digest, canonical JSON, and
  payload size before insertion.
- `certificateId`, `certificateHash`, and `investigationId` are unique. An exact
  retry is idempotent; the same identity with different content fails closed.
- The terminal payload must already be normalized, canonical, and sanitized by
  the Review Evidence payload rules. Projection does not persist prompts, tool
  transcripts, credentials, raw provider output, or private gateway material.
- A conclude response is not successful until shadow projection succeeds. The
  investigation conclusion remains durable if projection fails; the API returns
  a retryable ambiguous outcome, and the same idempotency key heals the missing
  projection on retry.

## Retention

Retention policy `investigation-shadow-evidence-retention.v1` is deterministic:
30 days from certificate issue time. This makes retries produce the same record
even if they happen on another process or later date.

Pruning is wired into the lease-protected investigation maintenance pass. It is
bounded, ordered, and uses `FOR UPDATE SKIP LOCKED`. The row has no
foreign-key authority over the investigation aggregate or normal observations,
so pruning cannot change review, reuse, quorum, publication, or safety outcomes.
Deleting a shadow row only removes the side-by-side analysis copy.

## Promotion boundary

Shadow evidence can feed telemetry and comparison tooling through its dedicated
query port. Promotion to an authoritative investigation observation remains a
separate certificate-verification and policy-gated workflow. Copying a shadow
row into a normal observation table is forbidden.
