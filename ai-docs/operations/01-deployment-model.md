# Deployment Model

## Lean Beta Deployment

Minimum deployable units:

```text
web - Next.js dashboard
api - Fastify API/webhooks
worker - background jobs/outbox
postgres - managed Postgres
kms/keyring - required only when hosted workspace account pool is enabled
```

Can initially deploy web/api together if platform makes it easier, but code should keep them separable.

## Stateless Services

`web`, `api`, and `worker` should be stateless.

No correctness state in memory:

- no in-memory sessions
- no in-memory locks
- no in-memory webhook dedupe
- no in-memory job state
- no local/FileBackend hosted credential or lease state in multi-replica SaaS

## Environment Configuration

Use validated env schema.

Likely env groups:

```text
DATABASE_URL
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_PRIVATE_KEY_FILE
GITHUB_WEBHOOK_SECRET
SESSION_SECRET
APP_BASE_URL
LOG_LEVEL
```

Use `GITHUB_APP_PRIVATE_KEY` for hosted secret managers. Use
`GITHUB_APP_PRIVATE_KEY_FILE` for local development or file-mounted secrets.
The inline env value may contain escaped newlines (`\n`); runtime config
normalizes it before creating GitHub App installation tokens.

## Hosted Codex Pool Operations

Hosted pool deployment uses five layered enable flags. All default to `0`
and production must preserve that default until the gated rollout below:

```text
REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL=0
REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY=0
REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION=0
REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY=0
REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER=0
```

`POOL` is the master/dashboard gate. The API treats each narrower flag as false
while `POOL=0`. Relay routes require `POOL`, `CUSTODY`, `ADMISSION`, and `RELAY`
to all be `1`; `FAILOVER` enables only the one permitted pre-response backup and
must be enabled last.

Required custody/relay configuration follows. Never place example or production
values in documentation, logs, tickets, shell history, or committed env files:

```text
REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION
REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY
REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER
REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE=external_kms
REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN
REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE
AWS_REGION
REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY
```

Secret placement follows least privilege. API relay replicas receive the relay
KMS role and relay/capability set. The enrollment process receives Encrypt only;
relay receives Decrypt only. The separately deployed recovery command receives
the recovery KMS role and recovery authority public key, never a signing key.
Do not copy `CAPABILITY_HMAC_KEY` into web/worker environments that do not
compose the relay.

Operational meaning:

- `DATABASE_INCARNATION` is an externally recorded opaque identity for the live
  database lineage. Keep it stable across ordinary deploys; create a new value
  for a restore/cutover and quarantine old envelopes until audited rewrap.
- `DATABASE_RESOURCE_IDENTITY` is the provider-issued immutable database
  resource identifier. It is independent of the database contents and must be
  obtained from the provider control plane, not restored from a backup.
- `FINGERPRINT_PEPPER` is secret base64 material of at least 32 decoded bytes.
  It has no online overlap mechanism: changing it changes account fingerprints,
  so rotate only with an explicit fingerprint migration/reconciliation plan.
- `KEYRING_MODE` must be `external_kms` in production. `KMS_KEY_ARN` must be an
  immutable AWS KMS key ARN; aliases, shorthand IDs, redirects, and a different
  ARN returned by Encrypt or Decrypt fail closed. `KMS_ROLE` is exactly `relay`
  in the normal serving process and exactly `recovery` in the restore process.
  KMS policy must independently authorize those roles and the versioned
  encryption context, including purpose, workspace/pool/account/generation,
  external database resource, incarnation, schema, and AAD hash.
- `CAPABILITY_HMAC_KEY` is canonical base64 secret material of at least 32 decoded
  bytes. The current issuer supports one active key and no verification overlap;
  rotation therefore invalidates outstanding grants.

The env keyring is allowed only for disposable development and certification.
Production composition rejects it even when injected by a caller. Keep all five
flags at `0` until the immutable KMS ARN, separate relay/recovery roles, external
database resource identity, key-use audit, rotation, and revocation policies are
in place.

KMS rotation order is authorize a new immutable key ARN -> retain old-key
Decrypt for recovery -> deploy the new ARN -> rewrap every live envelope with a
witnessed recovery operation -> verify no live envelope references the old key
-> revoke it only after the backup/recovery retention decision. For capability
HMAC rotation, set `ADMISSION=0` and `RELAY=0`, wait for or revoke outstanding
grants, rotate the key on every API replica, then re-enable. Never accept both
capability keys by an undocumented fallback.

Optional grant limits use bounded integer parsing and the following defaults:

| Variable                                                   | Default | Accepted range |
| ---------------------------------------------------------- | ------: | -------------: |
| `REVIEW_ROUTER_HOSTED_CODEX_GRANT_TTL_SECONDS`             |     900 |        60-3600 |
| `REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_REQUESTS`            |      32 |           1-64 |
| `REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_CONCURRENT_REQUESTS` |       2 |            1-8 |
| `REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_REQUEST_BYTES`       | 2000000 |   1024-2000000 |
| `REVIEW_ROUTER_HOSTED_CODEX_COMMENT_REFRESH_MAX_USES`      |       8 |           1-32 |

Omitting these variables uses the defaults. Invalid values fail composition;
limits must not be raised outside these ranges by bypassing validation.

### Hosted Rollout Order

1. Pass compliance/security review and all acceptance tests using only a
   disposable private repository. Apply additive migrations, then deploy the
   same verified SaaS commit to API and web with all five flags at `0`.
2. Publish the companion public Action from its reviewed commit, including the
   rebuilt committed bundle. Record its immutable 40-character commit SHA; do
   not use `main`, a tag, or a shortened SHA for hosted workflows.
3. Configure API and web with the same exact
   `REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF=777genius/review-router@<40-character-SHA>`.
   Use `REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS` only for a bounded
   old/new full-SHA overlap. Keep the old SHA until every bound workflow is
   migrated and attested, then remove it.
4. Configure custody secrets consistently across API relay replicas, give web
   only its least-privilege subset, and verify the external KMS adapter, database
   incarnation, restore quarantine, body-free telemetry, and public API URL while
   all flags remain `0`.
5. Set `POOL=1` and `CUSTODY=1` for controlled account onboarding. Keep
   `ADMISSION=0`, `RELAY=0`, and `FAILOVER=0`; no Action traffic may run yet.
6. Provision and attest the disposable/private allowlisted workflow against the
   companion Action SHA. The hosted caller uses `pull_request` (never
   `pull_request_target`), client-triggered T0 schema 2, and the immutable
   `reviewrouter-t0-reusable.yml@<40-character-SHA>`; grant admission requires
   that same path and SHA in `job_workflow_ref`/`job_workflow_sha`. Set
   `ADMISSION=1`, verify denial while relay remains off, then set `RELAY=1` for
   the smallest allowlist and run the E2E matrix.
7. After sticky-account, quota/auth classification, and no-body-retention
   evidence passes, set `FAILOVER=1`. Expand only through explicit private
   repository bindings; legacy repository-owned mode remains unchanged.

API owns grant/relay composition; web owns dashboard onboarding, binding, and
workflow provisioning. Both must be deployed from the compatible SaaS commit and
must trust the same public Action SHA before any hosted binding is activated.

### Kill-switch Rollback

For an upstream, privacy, credential, or compatibility incident, first set
`RELAY=0` and `ADMISSION=0` on every API replica, revoke outstanding grants, and
confirm relay traffic stops. Set `FAILOVER=0` to prevent backup selection. Then
set `POOL=0` and `CUSTODY=0` to hide onboarding and freeze all hosted custody
operations. Do not delete encrypted envelopes, revoke old KMS keys, export credentials
to GitHub, or silently switch repositories to legacy mode during the incident.

Roll back API/web only to a commit compatible with the additive schema and the
registered public Action SHA. If the public Action must be rolled back, pin a
reviewed compatible 40-character SHA, retain only the necessary bounded overlap,
regenerate/re-attest bound workflows, and keep admission disabled until complete.
Legacy Actions continue operating throughout this hosted-mode shutdown.

## Runtime Commands

Production API and worker boot from compiled JavaScript:

```bash
pnpm build
pnpm api:start
pnpm worker:start
```

The start scripts use:

```text
node --conditions=production
```

Do not remove this condition unless package exports are redesigned. In
development, workspace packages export `src/*.ts` for Next/Turbopack and tsx.
In production, the `production` export condition points Node at `dist/*.js`.

After build/export/startup changes, run:

```bash
pnpm runtime:smoke
```

This starts the compiled API, checks `/health`, then starts the compiled worker
once with `REVIEW_ROUTER_WORKER_ONCE=1`.

## Scaling Path

Start:

```text
1 web/api instance
1 worker instance
managed Postgres
```

Scale:

```text
N api instances behind load balancer
N worker instances
Postgres locks/queue ensure correctness
```

Hosted pool scaling adds stateless streaming relay replicas backed by shared
Postgres `SessionStorePort`/`LeaseStorePort` adapters and KMS. Account-wide
coordination fences only refresh/writeback plus generation CAS. Do not add an
account full-run mutex or `executionSlotsPerAccount`; bound grants and relay
backpressure enforce per-invocation budgets without serializing inference.

Before a database restore can serve hosted credentials, relay issuance stays
disabled while restored rows are quarantined and rewrapped into the externally
verified active database incarnation.

## Do Not Add Early

- Kubernetes unless needed
- Kafka unless Postgres queue is insufficient
- Redis unless locks/queue pressure requires it
- cloud review workers; the hosted account pool relay is not a worker and keeps
  checkout/tools/agent execution in GitHub Actions
