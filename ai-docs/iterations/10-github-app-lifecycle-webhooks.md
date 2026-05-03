# Iteration 10 - GitHub App Lifecycle Webhooks

## Goal

Keep ReviewRouter workspace/repository state correct when GitHub App access changes outside the dashboard.

## Scope

- handle `installation.created`, `installation.deleted`, suspend/unsuspend, and permission-accepted actions
- handle `installation_repositories.added` and `installation_repositories.removed`
- store normalized webhook metadata only, never raw webhook payloads
- enqueue repository sync through outbox for active/access-change events
- mark installation removed and disconnect repositories immediately on uninstall
- keep webhook processing idempotent by GitHub delivery id

## Architecture

Webhook route verifies signature and parses payload.

Application use case:

- owns lifecycle decision logic
- writes installation state through `GitHubInstallationRepositoryPort`
- records delivery state through `WebhookDeliveryRepositoryPort`
- requests async repository sync through `InstallationSyncRequestPort`

Adapters:

- Prisma adapter persists installation/delivery state
- outbox adapter converts sync requests into `installation.sync_requested@v1`
- worker adapter processes the outbox event by calling repository sync through ports

## Tests

- unit: duplicate delivery does not repeat side effects
- unit: installation access changes enqueue sync
- unit: repository access changes enqueue sync with normalized safe metadata
- unit: deleted installation does not call GitHub sync
- unit: outbox handler validates payload and dead-letters malformed events
- E2E: signed webhook lifecycle against local Postgres test DB

## Done When

- uninstall does not leave repos selected
- repository add/remove changes eventually trigger full installation sync
- duplicate GitHub deliveries do not duplicate outbox work
- worker can process `installation.sync_requested@v1`

## Implemented Baseline

- GitHub webhook route verifies `x-hub-signature-256`, rejects invalid deliveries, and stores only normalized metadata plus a payload hash.
- `installation.created` / active access changes upsert the installation, grant the installing sender owner access for the derived workspace, and enqueue `installation.sync_requested@v1`.
- `installation_repositories.added|removed` keeps the installation active and enqueues a full installation repository sync.
- `installation.deleted` marks the installation removed and immediately unselects connected repositories without calling GitHub.
- Duplicate GitHub delivery IDs are idempotent before side effects.
- Outbox worker has a registered `installation.sync_requested@v1` handler that validates payloads and delegates repository sync through ports.
- Local DB E2E covers signed webhook delivery, duplicate suppression, outbox sync processing, repository creation/selection, uninstall unselection, and processed outbox state:

```bash
node scripts/run-with-env.mjs pnpm spike:webhook-lifecycle:e2e
```
