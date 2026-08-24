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
while `POOL=0`. New grant issuance requires `POOL`, `CUSTODY`, and `ADMISSION`.
Already-issued grants require `POOL`, `CUSTODY`, and `RELAY`, so admission can
close while relay stays up long enough to drain. `FAILOVER` enables only the one
permitted pre-response backup and must be enabled last.

Required custody/relay configuration follows. Never place example or production
values in documentation, logs, tickets, shell history, or committed env files:

```text
REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION
REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY
REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER
REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE=external_kms
REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN
REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE
REVIEW_ROUTER_HOSTED_CODEX_RELAY_AWS_ROLE_ARN
REVIEW_ROUTER_HOSTED_CODEX_ENROLLMENT_AWS_ROLE_ARN
REVIEW_ROUTER_HOSTED_CODEX_RECOVERY_AWS_ROLE_ARN
AWS_REGION
REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY
```

Secret placement follows least privilege. API relay replicas receive the relay
KMS role and relay/capability set. The enrollment process receives Encrypt only;
relay receives Decrypt only. The separately deployed recovery command receives
the recovery KMS role and recovery authority public key, never a signing key.
Do not copy `CAPABILITY_HMAC_KEY` into web/worker environments that do not
compose the relay.

Production Render services use Render-managed AWS OIDC, never long-lived AWS
access keys. Configure the workspace OIDC provider in AWS and bind each IAM role
trust policy to the exact Render workspace, environment, and service subject.
The deploy helper projects only `AWS_ROLE_ARN`; Render injects
`AWS_WEB_IDENTITY_TOKEN_FILE` during deployment, and the runtime reads that
short-lived token with the AWS SDK web-identity provider. Never set the token
file path manually.

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
  Web enrollment uses exactly `enrollment`, API relay uses exactly `relay`, and
  the offline restore command uses exactly `recovery`. Their distinct immutable
  IAM role ARNs are required in the deploy source; the deploy helper projects
  only the selected role to each service and projects none to worker. KMS policy
  must independently authorize those roles and the versioned
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
   Record the immutable release tag and `dist/index.js` SHA-256 beside the
   commit. The tag must resolve to the commit and CI must hash the bytes from
   that same checkout before the tuple is accepted by SaaS.
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

The production control is dry-run by default and writes mode `0600`, body-free
JSON evidence. It requires the exact API and web Render service IDs plus the
least-privilege operator database URL. Inspect without mutation first:

```bash
REVIEW_ROUTER_HOSTED_POOL_RENDER_SERVICE_IDS=srv-api,srv-web \
REVIEW_ROUTER_HOSTED_POOL_OPERATOR_DATABASE_URL=postgresql://... \
RENDER_API_KEY=... \
pnpm hosted-pool:control status
```

For a privacy or credential incident, use `kill-switch`: it atomically requests
`ADMISSION=0`, `FAILOVER=0`, and `RELAY=0` on both services and verifies provider
readback. For controlled rollback, use `drain` or `rollback`. Rollback closes
admission, observes database `inFlight`, issued-grant, and unresolved-request
counts until all three are zero, then disables failover, relay, custody, and
finally the pool. Each
mutating command requires `--execute` and
`REVIEW_ROUTER_HOSTED_POOL_CONTROL_CONFIRM="EXECUTE HOSTED POOL COMMAND"`, with
`COMMAND` equal to the uppercase command name. Do not use drain when immediate
containment is required.

Do not delete encrypted envelopes, revoke old KMS keys, export credentials to
GitHub, or silently switch repositories to legacy mode during an incident.

Roll back API/web only to a commit compatible with the additive schema and the
registered public Action SHA. If the public Action must be rolled back, pin a
reviewed compatible 40-character SHA, retain only the necessary bounded overlap,
regenerate/re-attest bound workflows, and keep admission disabled until complete.
Legacy Actions continue operating throughout this hosted-mode shutdown.

### One-shot Production Canary

`pnpm hosted-pool:canary` is hard-coded to the disposable
`777genius/rr-codex-rotating-e2e` repository. It refuses a different repository
identity indirectly as well as directly: the numeric repository ID must equal
the sole numeric allowlist entry; the exact App installation must contain that
ID; the checked-in workflow and active database binding must both consume the
recorded 40-character Action SHA. The associated public Action tuple must first
be verified from its clean checkout:

```bash
REVIEW_ROUTER_HOSTED_POOL_ACTION_CHECKOUT=/trusted/review-router \
pnpm hosted-pool:action-release:verify
```

The canary defaults to preflight-only dry-run. Execution additionally requires
`--execute`, `REVIEW_ROUTER_HOSTED_POOL_CANARY_CONFIRM="EXECUTE ONE SHOT HOSTED POOL CANARY"`,
and `REVIEW_ROUTER_HOSTED_POOL_CANARY_ROLLBACK_CONFIRM="ROLL BACK HOSTED POOL AFTER CANARY"`.
Use a short-lived App JWT only for the App-owned installation lookup and a
separate short-lived repository token for workflow reads/reruns; the harness
does not accept one ambient token for both trust domains.
Operators pin five distinct existing disposable workflow run IDs in
`REVIEW_ROUTER_HOSTED_POOL_CANARY_RUN_IDS_JSON`: `simultaneous_a`,
`simultaneous_b`, `unauthorized`, `rate_limited`, and `dropped_response`.
Each source run must be a completed, successful attempt-1 `pull_request` run of
the canonical hosted workflow. `workflow_dispatch`, prior reruns, moved workflow
tuples, and noncanonical source revisions are rejected before any flag changes.

The v2 canary also requires the exact dedicated pool ID, exactly two healthy
account IDs, the disposable repository ID repeated as the sole allowlist entry,
and three distinct `rr-canary-fault-v2` operator-signed fault plans in
`REVIEW_ROUTER_HOSTED_POOL_CANARY_FAULT_PLANS_JSON`. The API holds only the
stable Ed25519 public authority key and key ID. The operator stages each
short-lived (at most one-hour), exact repository/run-attempt/action/binding/
revision/request/attempt plan in the audit ledger immediately before its run;
the API verifies and atomically consumes it once. Repository input cannot select
or widen a fault. Rollback cancels every still-open staged plan.

Activation enables pool, custody, relay, and failover together on the exact API
and web services, verifies the two-service readback, then enables admission last.
The first two runs are dispatched concurrently and must prove the same sticky
primary account with overlapping upstream attempt timestamps. Synthetic 401 and
429 are injected before the primary inference effect exists and must each show
one successful backup effect and one fault-plan consumption. The dropped
response is injected only after durable response-start, must become
`terminal_unknown`, revoke the invocation grant and comment-refresh capability,
and must remain an unchanged one-effect graph after the quiescence reread. Every
ReviewRouter publication in the attempt window must be authored by the exact
configured GitHub App bot.

The harness performs no rerun retry. Schema-2 evidence records exact
binding/revision, grant, request, effect, fault-consumption, App-publication,
ordered activation, failure, and rollback observations and seals the JSON with
`evidenceSha256`. Rollback is attempted after every protected execution path,
continues through individual closure failures, and independently verifies both
services at all-zero flags plus zero in-flight, issued-grant, and unresolved-
request counts. Tests use deterministic fake ports and never contact GitHub,
Render, KMS, or a provider.

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
