# Review investigation private material

Review investigation v2 treats search query text as private material. Durable
aggregates, obligations, command receipts, read models, logs, and metrics contain
only the query hash and the deterministic operation-input hash. The query itself
is available only in memory or in the existing
`ReviewInvestigationPrivateMaterial` table as AES-256-GCM ciphertext.

## Configuration

Set both key variables before enabling investigation recording. The TTL variable
is optional. Retention maintenance is mandatory whenever recording is enabled:

- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID` selects the
  key used for new ciphertext.
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON` is a JSON object
  whose keys are key IDs and whose values are unpadded base64url-encoded 32-byte
  keys. Keep previous keys while unexpired rows can still reference them.
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS` defaults to 24
  hours and must be between 1 minute and 7 days.
- `REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED=1` enables the bounded,
  lease-protected worker that physically deletes expired ciphertext and terminal
  dossiers.

Load keys from the deployment secret manager. Never put populated values in an
env example, repository file, diagnostic bundle, command output, or support log.

## Runtime integration

The production API composition loads the configuration with
`loadConfiguredInvestigationPrivateMaterial`, then passes the resulting cipher,
TTL, and the same `PrismaInvestigationStore` instance into
`composeReviewInvestigationUseCases.privateMaterial`. Investigation recording
does not require or parse these secrets while its rollout capability is disabled.
When recording is enabled, absent, partial, or invalid configuration fails API
composition closed before any investigation route can run. Recording also fails
composition closed unless retention maintenance is explicitly enabled. The API
and worker must receive the same deployment configuration; readiness checks and
operations monitoring must verify that the worker is healthy.

`OpenReviewInvestigation` validates the supplied query/hash binding, removes the
query from the canonical requirement, encrypts one payload per search obligation,
and submits the aggregate, obligations, command receipt, and encrypted rows to one
store commit. Prisma writes all of them in one transaction. A missing row, expired
row, unavailable historical key, AAD mismatch, or authentication-tag failure
fails turn-brief hydration closed before a provider receives a turn.

## Rotation and retention

1. Add the new key to `KEYS_JSON` and set its ID as active.
2. Deploy API instances with both old and new keys.
3. Wait at least the configured private-material TTL plus deployment overlap.
4. Confirm no unexpired row references the old key ID.
5. Remove the old key and continue bounded private-material pruning.

The current Prisma schema and migration `000040_review_investigations` already
provide the required encrypted columns, per-obligation uniqueness, expiry index,
and foreign keys. No schema migration is required for this lifecycle fix.
