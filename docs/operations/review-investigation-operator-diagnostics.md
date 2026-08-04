# Review Investigation operator diagnostics

Investigation status, promotion-report generation, and signed evaluation import
are authorized per operation. Promotion and import credentials are distinct;
an import credential cannot generate a report. API responses use
`Cache-Control: no-store` and expose only
typed identifiers, digests, counts, enum values, timestamps, report metrics,
and the immutable report hash.

## Investigation status

```text
reviewrouter investigation status --investigation-id INVESTIGATION_ID
```

The status includes state, aggregate version, obligation counts, next action,
capacity eligibility, the last typed failure, conclusion, and protocol,
gateway, and producer-release compatibility. Repository content, prompts,
queries, replay material, credentials, and canonical payloads are not returned.

## Promotion report

```text
reviewrouter investigation promotion-report \
  --producer-release RELEASE_ID \
  --promotion-profile-id PROFILE_ID \
  --promotion-profile-version PROFILE_VERSION
```

Generation time, trust inputs, and thresholds are server-owned. The command
selects an authoritative configured profile, persists an immutable canonical
report, then returns only its hash and aggregate decision body. Generating a
report does not enable investigation effects or authorize promotion.

## Terminal telemetry boundary

The conclude lifecycle always wires a typed, Prisma-backed terminal telemetry
producer when investigation runtime is enabled. It reads the already committed
aggregate and certificate, emits a deterministic sample ID, and appends
idempotently. Sample validation rejects additional fields before persistence,
and collection or write failures emit only fixed diagnostic codes without
changing an already committed conclusion.

Automatic samples are marked `terminal_operational`, not
`fully_evaluated`. They include only defensible facts: revision and scope
hashes, conclusion and finding count, provider/model attribution, turn counts,
trusted total usage and duration, a complete token split when provenance is
complete, unique gateway receipt count, and exact terminal payload bytes. The
following unavailable facts remain `null` or explicitly `unknown`:

- seeded-defect ground truth, detected-defect matching, and false-clean status;
- legacy-review comparison and disagreement disposition;
- exact replay classification;
- time to first finding and cumulative capacity wait/failure history;
- retained storage bytes and security-event measurements.

Production can derive `fully_evaluated` samples only through the signed external
evaluation import described in
[review-investigation-evaluation-import.md](./review-investigation-evaluation-import.md).
Operator authentication alone cannot upgrade a sample. The importer requires a
trusted Ed25519 signature, validates every terminal-sample and certificate
binding, and commits the immutable attestation plus derived sample atomically.
Promotion reports count operational samples for visibility but exclude them
from seeded/shadow minimums and every correctness, security, token, and latency
gate. An injected terminal-sample port remains available for deterministic
tests; production does not depend on that override.
