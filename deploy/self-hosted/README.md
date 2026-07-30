# ReviewRouter Self-Hosted Control Plane

This runs the ReviewRouter control plane on your own host for repositories on
github.com. Customer code review still runs inside the customer's GitHub
Actions workflow. The self-hosted server stores metadata, configuration,
webhook state, sessions, outbox jobs, and health data in Postgres.

For the sequential path from a clean host to the first real review, start with
the
[end-to-end self-hosting guide](../../docs/operations/review-router-self-hosted-end-to-end.md).
This document is the detailed configuration and operations reference.

This guide does not cover GitHub Enterprise Server, air-gapped deployments, or
cloud review execution.

## Services

The Compose stack starts:

```text
postgres - ReviewRouter metadata database
migrate  - one-shot Prisma plus Review v2 migration/backfill job
web      - Next.js dashboard and Auth.js routes
api      - Fastify API, GitHub webhooks, action OIDC/config endpoints
worker   - outbox, repository sync, and maintenance jobs
```

The same Docker image is used for `web`, `api`, `worker`, and `migrate`.
The image keeps the Prisma CLI and PostgreSQL client available so self-hosted
upgrades can run schema migrations and the Review v2 backfill without a
separate tool container.

## Prerequisites

- Docker with Compose v2.
- Public DNS for the web and API hosts.
- Public HTTPS termination in front of the exposed web/API ports.
- A GitHub App owned by the operator of this self-hosted instance.
- Outbound access from the host to `github.com`, `api.github.com`, and GitHub
  OIDC/JWKS endpoints.

Recommended versions in this stack:

- Node.js 24 LTS for the app image.
- PostgreSQL 18 for the bundled local database.

The bundled PostgreSQL 18 service mounts the named volume at
`/var/lib/postgresql`, not `/var/lib/postgresql/data`. Keep that path when
customizing Compose; PostgreSQL 18 stores major-version-specific data
directories under the parent path.

## 1. Prepare Env

```bash
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
```

Generate a URL-safe PostgreSQL password, then generate every other secret
independently:

```bash
openssl rand -hex 32
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 32
```

Use those values for:

```text
AUTH_SECRET
REVIEW_ROUTER_ACTION_SESSION_SECRET
REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY
GITHUB_WEBHOOK_SECRET
POSTGRES_PASSWORD
```

Keep `DATABASE_URL` in sync with `POSTGRES_PASSWORD`.

## 2. Create GitHub App

Create a GitHub App for the self-hosted instance and configure:

```text
Callback URL:  https://<web-host>/api/auth/callback/github
Setup URL:     https://<web-host>/setup
Webhook URL:   https://<api-host>/webhooks/github
```

Set these env vars from the App settings:

```text
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_SLUG
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` should match the App client ID
and secret. For `GITHUB_APP_PRIVATE_KEY`, paste the PEM into the env file with
escaped newlines (`\n`).

Choose the narrowest GitHub App permission profile that matches how the
self-hosted instance will operate:

```text
review-only    Direct customer-managed PR workflows. No server-side dispatch,
               setup PRs, workflow edits, or secret provisioning.
managed-review Durable ReviewRouter workflow_dispatch and exact-run
               cancellation. Workflows and provider secrets are managed outside
               ReviewRouter.
provisioning   Dashboard setup PRs, workflow file updates, and GitHub Actions
               secret provisioning.
org-ruleset    provisioning plus organization ruleset administration.
```

Use `review-only` for the client-triggered Direct V2 mode documented here. Use
`managed-review` only for a separate server-dispatched mode, and use
`provisioning` only when the dashboard must create setup PRs or repository
secrets.

Create a manifest with the matching profile:

```bash
pnpm github-app:create -- \
  --permission-profile review-only \
  --web-url https://reviewrouter.example.com \
  --api-url https://api.reviewrouter.example.com \
  --name "ReviewRouter Self-Hosted"
```

Set the same profile in `.env`:

```text
REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE=review-only
```

`review-only` requires:

```text
Actions: read
Checks: write
Contents: read
Pull requests: write
Issues: write
Commit statuses: write
Metadata: read
```

`managed-review` adds:

```text
Actions: write
```

`provisioning` adds:

```text
Contents: write
Workflows: write
Secrets: write
Organization secrets: read
Organization plan: read
```

`org-ruleset` adds:

```text
Organization administration: write
```

Webhook events are also profile-based. `review-only` requires:

```text
Check run
Issue comment
Pull request
Repository
Status
Workflow run
```

`managed-review`, `provisioning`, and `org-ruleset` also require:

```text
Workflow job
Push
```

GitHub App installation lifecycle events are delivered by GitHub Apps by
default; do not add `installation` or `installation_repositories` to the
manifest manually.

Enable redirect after installation updates so users return to the dashboard.

## 3. Configure Direct T0

Self-hosted direct T0 is client-triggered. Readiness requires both explicit
opt-ins and rejects any server-side intent or dispatch enablement:

```text
REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE=client_triggered_t0
REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED=0
REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED=0
REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY=0
REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED=1
```

In `client_triggered_t0`, the customer workflow starts the review. ReviewRouter
must not ingest a server-owned intent or dispatch a second workflow. The
`review-only` GitHub App profile is valid for this mode; use a broader profile
only when its separate management features are required.

The canonical client-triggered workflow is schema 2. It runs only for same-repo
`pull_request` events, uses the exact pull-request head SHA and number, grants
only `contents: read`, `pull-requests: read`, and `id-token: write`, and pins the
reusable workflow to the full Action commit. Direct initialization rejects any
other executable workflow inventory.

Pin `REVIEW_ROUTER_ACTION_REF` to the exact 40-character Action commit. Populate
the authorization and capability key rings, producer release attestations,
provider vote lanes, context keys, and operator credential hash declared in
`.env.example`. Generate independent 32-byte base64 secrets for each signing or
context key:

```bash
openssl rand -base64 32
```

The signing key-ring JSON shape is:

```json
[{ "keyId": "self-hosted-v1", "secretBase64": "...", "verifyUntil": null }]
```

The context replay key-ring JSON shape is:

```json
[{ "keyId": "context-v1", "secretBase64": "..." }]
```

Build producer attestations and provider vote lanes from the validated release
bundle. Do not invent release digests. The attestation `actionCommitSha` must
match `REVIEW_ROUTER_ACTION_REF`.

Store only the SHA-256 of the Review v2 operator credential in the shared env:

```bash
printf %s "$REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL" \
  | openssl dgst -sha256 -r | awk '{print $1}'
```

Keep the plaintext credential outside the Compose env and provide it only to an
operator command. The migration/backfill leaves the global Review v2 emergency
stop active. Follow the
[Review Action v2 cutover runbook](../../docs/operations/review-action-v2-cutover.md)
to stage and activate repositories after service health is proven.

## 4. Check Config

From the repository root:

```bash
pnpm self-hosted:check
```

Or point the checker at a different env file:

```bash
REVIEW_ROUTER_SELF_HOSTED_ENV_FILE=/path/to/reviewrouter.env pnpm self-hosted:check
```

The checker rejects local/non-HTTPS public URLs, missing GitHub App values,
placeholder secrets, provider credentials in server env, missing direct-T0
opt-ins, client-triggered/server-dispatched mode conflicts, unpinned action
refs, invalid key/config material, release-attestation mismatch, and
incompatible permission profiles.

Validate the Compose service contract separately when changing Docker or
service wiring:

```bash
pnpm self-hosted:compose:check
```

Run the complete disposable local E2E gate before a self-hosted release:

```bash
pnpm self-hosted:e2e
```

The E2E command generates an isolated complete T0 env, builds and boots a fresh
Compose project on free localhost ports, verifies both migration layers and
exact health responses, runs the Review v2 and action OIDC harnesses inside the
container, checks logs for credential material, and removes its database and
volumes.

## 5. Start

From `deploy/self-hosted`:

```bash
docker compose up -d --build
```

From the repository root:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

The `migrate` service runs Prisma migration deploy and then
`review-v2-migrate.mjs --apply`. The Review v2 migration is resumable and
idempotent; `web`, `api`, and `worker` start only after both layers succeed.
After the migration ledger records completion, normal restarts preserve the
current emergency-control state instead of requiring the global stop to be
re-enabled.
Prisma's `?schema=public` URL parameter is removed only for `psql`; other libpq
parameters such as `sslmode` are preserved.

Check status:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  ps
curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:3000/api/health
```

Your public reverse proxy should route:

```text
https://<web-host> -> 127.0.0.1:3000
https://<api-host> -> 127.0.0.1:4000
```

## 6. Operator CLI

Self-hosted admin commands must run inside the API container so they use the
same database, keys, GitHub App identity, and runtime contract as the service.
Keep the plaintext operator credential outside the shared env file, export it
only in the current operator shell, and define:

```bash
export REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL

rr_admin() {
  docker compose \
    --env-file deploy/self-hosted/.env \
    -f deploy/self-hosted/compose.yml \
    exec -T \
    -e REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL \
    api pnpm review-v2:admin "$@"
}
```

Run `rr_admin env-preflight` before a mutation.

## 7. Upgrade

```bash
git fetch --tags origin
git checkout <reviewed-commit-or-release>
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm self-hosted:check
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

The migration job is idempotent and runs both Prisma and Review v2 migrations
before app services.

Migration v7 places every repository identity that already exists at upgrade
time behind a durable `v1_open` authority fence. This is intentionally
conservative: an existing repository is never inferred to be fresh-V2 merely
because its old activity is absent from current tables. Upgrade those
repositories through the normal drain/activate path. A repository onboarded
after v7 may use direct initialization only if the schema-2 inventory,
registered release, worker, safety policy, and no-legacy proof all pass:

```bash
rr_admin cohort stage \
  --repo OWNER/REPO \
  --confirm OWNER/REPO

rr_admin emergency global open \
  --confirm global

rr_admin mutation initialize-direct-v2 \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Legacy admission and direct initialization use the same repository-scoped
database lock. The first authority decision wins; a concurrent losing path
fails closed instead of opening both mutation lanes.

Migration intentionally leaves the global Review v2 emergency stop active.
Stage at least one repository before running `emergency global open`. The
global policies remain allowlisted, so opening the global control does not
enroll unstaged repositories. Restore the kill switch with:

```bash
rr_admin emergency global stop --confirm global
```

## Backups

Create a backup:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > reviewrouter.dump
```

Restore into a stopped or fresh stack after creating the database:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < reviewrouter.dump
```

## Scaling

The API and worker are stateless. Start with one instance each. Scale workers
only after the database has enough capacity:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --scale worker=2
```

Keep all services on the same git SHA/image tag.

## Security Notes

- Do not put `CODEX_AUTH_JSON`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, or model/provider credentials in this env file.
- Provider credentials belong in customer GitHub repo/org Actions secrets.
- Never replace `REVIEWROUTER_CODEX_AUTH_JSON` with a direct
  `gh secret set`. Rotating auth includes a generation handshake; bypassing it
  can make queued runs present an older generation. Use
  `scripts/reseed-codex-rotating-auth.sh` or the dashboard-generated reseed
  command.
- Point self-hosted CLI reseeds at this deployment explicitly. Without this
  override the script intentionally defaults to the hosted ReviewRouter:

  ```bash
  REVIEW_ROUTER_CODEX_RESEED_API_URL="$REVIEW_ROUTER_PUBLIC_WEB_URL/api/codex-rotating/cli/setup-command" \
    scripts/reseed-codex-rotating-auth.sh \
    --repo OWNER/REPOSITORY
  ```

- Keep Postgres bound to localhost unless you put it on a private network.
- Use HTTPS for public web/API URLs. Generated customer workflows depend on
  `REVIEW_ROUTER_PUBLIC_API_URL`.
- Do not add `pull_request_target` to generated customer workflows.
