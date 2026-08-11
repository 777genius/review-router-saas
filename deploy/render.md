# Render Hosted Beta Deploy

ReviewRouter on Render is a control plane deployment only. Customer code review
continues to run inside customer GitHub Actions.

## What `render.yaml` Creates

The Blueprint defines:

- `reviewrouter-web` - Next.js dashboard and Auth.js routes
- `reviewrouter-api` - Fastify API, GitHub webhooks, action OIDC/config/health endpoints
- `reviewrouter-worker` - outbox, repository sync, and maintenance jobs
- `reviewrouter-db` - managed Postgres
- `reviewrouter-hosted-beta` - shared environment group

The services use Render Starter instances and the database uses `basic-256mb`.
This is intentionally small for public beta validation. Scale after telemetry
shows real usage.

## Before Creating The Blueprint

1. Push this repository to GitHub.
2. In Render, create a Blueprint from the GitHub repository containing
   `render.yaml`.
3. Choose the Render workspace that owns the beta deployment.
4. Place the resources in the `ReviewRouter` Render project. The first local
   beta project created through the Render API is:

```text
Project: ReviewRouter
Project ID: prj-d7s67t0g4nts73d4l400
Environment: production
Environment ID: evm-d7s67t0g4nts73d4l40g
```

The Render MCP/API can create individual services, but the current MCP server
does not create a new Blueprint from a repository. Use the Render Dashboard for
the first Blueprint connection, then keep `render.yaml` as the source of truth.

## API Deploy Helper

If Render already has GitHub access to the private repository, the hosted beta
resources can be created or re-synced from the CLI without printing secrets:

```bash
export RENDER_OWNER_ID=tea-d11m6c0dl3ps73cuh2gg
export RENDER_PROJECT_ID=prj-<exact-project-id>
export RENDER_ENVIRONMENT_ID=evm-d7s67t0g4nts73d4l40g
export RENDER_REPO=https://github.com/777genius/review-router-saas
export REVIEW_ROUTER_WEB_URL=https://reviewrouter.site
export REVIEW_ROUTER_API_URL=https://api.reviewrouter.site
export REVIEW_ROUTER_RENDER_COMMIT_SHA=<exact-40-character-release-sha>
export REVIEW_ROUTER_RENDER_IMAGE_DIGEST=sha256:<exact-64-character-image-digest>
export REVIEW_ROUTER_RENDER_PHASE=prepare
pnpm deploy:render:hosted-beta
```

The prepare phase creates or reuses `reviewrouter-db`, `reviewrouter-web`,
`reviewrouter-api`, and `reviewrouter-worker` only inside the exact owner,
project, and environment identity. Environment linking and its follow-up read
are fatal gates. Prepare disables commit auto-deploy and service migration
hooks, but writes no runtime secrets and triggers no runtime deploy.
It reads `.env.production` by default. Public URL scheme and loopback checks
cannot be overridden; the staging override applies only to local-looking file
and App-slug heuristics. The helper intentionally does not log secret values.

Current hosted beta resources created by this helper:

- Web: https://reviewrouter.site
- API: https://api.reviewrouter.site
- Worker: `reviewrouter-worker`
- Postgres: `reviewrouter-db`

## Required Manual Values

During or immediately after Blueprint sync, fill these environment variables in
`reviewrouter-hosted-beta`:

```text
REVIEW_ROUTER_WEB_URL=https://reviewrouter.site
REVIEW_ROUTER_API_URL=https://api.reviewrouter.site
REVIEW_ROUTER_PUBLIC_API_URL=https://api.reviewrouter.site
NEXTAUTH_URL=https://reviewrouter.site
GITHUB_APP_ID=<production/staging app id>
GITHUB_APP_CLIENT_ID=<production/staging app client id>
GITHUB_APP_CLIENT_SECRET=<production/staging app client secret>
GITHUB_APP_SLUG=<production/staging app slug>
GITHUB_APP_PRIVATE_KEY=<production/staging app private key PEM>
GITHUB_CLIENT_ID=<same as GITHUB_APP_CLIENT_ID for current Auth.js setup>
GITHUB_CLIENT_SECRET=<same as GITHUB_APP_CLIENT_SECRET for current Auth.js setup>
REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY=<strong random secret for encrypted user tokens>
REVIEW_ROUTER_ACTION_REF=777genius/review-router@main
REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF=777genius/review-router@<exact-40-character-action-sha>
REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS=
REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS=<one unpadded base64url value from at least 32 random bytes>
REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL=<private URL for reviewrouter_release_migration>
REVIEW_ROUTER_WEB_DATABASE_URL=<private URL for reviewrouter_web>
REVIEW_ROUTER_API_DATABASE_URL=<private URL for reviewrouter_api>
REVIEW_ROUTER_WORKER_DATABASE_URL=<private URL for reviewrouter_worker>
REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=0
REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED=0
REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED=0
REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES=
REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED=0
REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED=0
REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID=<active v2 capability key id>
REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON=<rotating capability key ring JSON>
```

Keep both revision-aware v2 flags at `0` for the additive schema deployment.
Enable them only after the registered Action release, producer attestation,
repository authority, and worker recovery prerequisites have passed the v2
cutover checklist. A failed cutover pauses v2; it must not reopen v1 mutation.
The worker key ID is required only when its v2 flag is enabled and must match
the active key configured for the API capability key ring. It is not secret key
material.

`AUTH_SECRET`, `REVIEW_ROUTER_ACTION_SESSION_SECRET`,
`REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY`, and
`REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS` are mandatory stable values. Create
each once in the environment's secret manager. The helper rejects missing,
short, and placeholder values, never generates or rotates them, and sends the
exact same bytes to every applicable runtime role on every rerun. Rotation
requires a separately designed explicit migration; rerunning this helper is not
a rotation mechanism. Do not paste these values into commands, logs, tickets,
or readiness output. Generate `GITHUB_WEBHOOK_SECRET` yourself and put the same value in
Render and the GitHub App webhook settings:

```bash
openssl rand -base64 32
```

The general Action channel may remain `@main`, but rotating T0 workflows must
use the separate exact SHA. For A -> B, deploy trust `{A,B}` everywhere before
making B primary. New setup candidates use B; existing active namespaces stay
pinned to A until a fenced drain and fresh namespace setup. Keep A trusted
while any namespace, queued/in-progress run, or lease can reference it.

For GitLab support, `reviewrouter-api` also needs API-side integration values:

```text
REVIEW_ROUTER_GITLAB_API_TOKEN=<GitLab token used by the API to read MR metadata>
REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN=<optional GitLab token for provisioning projects>
REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN=<operator-only bearer token for install APIs>
REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON=<selected GitLab repositories JSON>
REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE=reviewrouter
REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE=ghcr.io/777genius/review-router-gitlab-runtime:v1
```

`REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN` by itself enables only the
operator install endpoints, including the control-project CI config download.
Project provisioning additionally requires `REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN`.
Runtime session exchange additionally requires `REVIEW_ROUTER_GITLAB_API_TOKEN`
and `REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON`.

Check the live GitLab setup without exposing secret values:

```bash
curl -fsS "$REVIEW_ROUTER_API_URL/api/gitlab/install/v1/status" \
  -H "Authorization: Bearer $REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN"
```

The response reports whether provisioning and CI session exchange are available
and lists missing environment variable names.

Bulk GitLab provisioning uses the same single-project installer rules per
project and returns per-project results instead of aborting the whole batch.
When `variableTarget.kind` is `group`, the shared GitLab CI variables are
configured once for the group before the project loop:

```bash
curl -fsS "$REVIEW_ROUTER_API_URL/api/gitlab/install/v1/group-projects?groupId=my-group%2Fplatform&includeSubgroups=true&withShared=false&perPage=100&workspaceId=gitlab-my-group" \
  -H "Authorization: Bearer $REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN"
```

Use the returned `projectIds` as the input for bulk provisioning. `groupId` can
be either a numeric group ID or a URL-encoded full group path. Discovery defaults
to subgroups included, archived projects excluded, and shared-in projects
excluded so the first rollout stays inside the group hierarchy. The same
response includes `staticRepositoriesJson`; set it as
`REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON` so CI session exchange accepts
the newly provisioned GitLab projects.

```bash
curl -fsS -X POST "$REVIEW_ROUTER_API_URL/api/gitlab/install/v1/bulk-provision" \
  -H "Authorization: Bearer $REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data @gitlab-bulk-provision.json
```

Keep runtime/model credentials out of Render:

```text
CODEX_AUTH_JSON
CODEX_CONFIG_TOML
OPENAI_API_KEY
OPENROUTER_API_KEY
```

Those stay in each customer repository, group, or organization CI/CD secrets.

## GitHub App Settings

Set these URLs on the GitHub App used for hosted beta:

```text
Callback URL: https://reviewrouter.site/api/auth/callback/github
Setup URL:    https://reviewrouter.site/setup
Webhook URL:  https://api.reviewrouter.site/webhooks/github
```

Enable redirect on installation updates so repository add/remove flows return
users to the dashboard.

Required repository permissions:

```text
Contents: write
Workflows: write
Pull requests: write
Issues: write
Secrets: write
Organization secrets: read
Actions: read
Checks: write
Commit statuses: write
Metadata: read
```

Required webhook events:

```text
Pull request
Installation
Installation repositories
```

## Database roles and deploy order

The Blueprint uses the supported
[`postgresMajorVersion`](https://render.com/docs/blueprint-spec) field and pins
it to `"17"`; omitting it would currently select Render's newest supported
major, not necessarily 17. The deploy helper also sends `version: "17"` on
create and rejects both an existing database and the final ready-database
response unless they report major 17.

The Blueprint creates only the owner `reviewrouter_release_migration`. After
the helper's `prepare` phase, dispatch the checked-in
`.github/workflows/codex-rotating-release-migration.yml` workflow at the exact
release commit with a new, never-reused rollout ID. That workflow is the only
supported migration initiator. It creates exactly one Render one-off job whose
command is the checked-in `pnpm codex-rotating:release-migration` caller. The
caller creates or converges login roles
`reviewrouter_web`, `reviewrouter_api`, and `reviewrouter_worker`, then verifies
them. They receive CONNECT, public-schema USAGE, required
SELECT/INSERT/UPDATE/DELETE and sequence USAGE only. Revoke CREATE on the
database and schema plus TRUNCATE, REFERENCES, and TRIGGER on application
tables. They must own no application object, have no membership in any other
canonical role, and must not be able to `SET ROLE
reviewrouter_release_migration`. The workflow captures the successful job and
its exact service/deploy/job, command, commit, image, database, and canonical
caller log output through authenticated Render API calls. It uploads a strict
version-3 GitHub artifact whose digest, immutable workflow blob, repository,
run, attempt, job, and artifact identities are independently re-fetched before
use. Local JSON and local checksums are never deployment authority.
Supply each role's distinct private URL only to `runtime-deploy`; the helper
checks all four URLs against the selected Render database connection before any
secret-bearing mutation.

The release role owns the database, public schema, `_prisma_migrations`, every
rotating-OAuth table, and every `codex_oauth_*` function. After a restore or
promotion and before traffic, the exclusive release job admits the generation
by storing this database-owner-only comment (substitute observed values; never
store the witness itself):

```sql
COMMENT ON DATABASE review_router IS
  '{"version":1,"systemIdentifier":"<pg_control_system.system_identifier>","recoveryWitnessSha256":"<sha256-of-current-witness>"}';
```

The verifiable boundary assumes GitHub and Render faithfully serve their
authenticated API records and artifact digest, TLS is not compromised, and
administrators of the fixed `777genius/review-router-saas` production
environment protect its variables, secrets, and approval rules. Neither
provider signs arbitrary Render response bodies. The immutable GitHub job
therefore performs those authenticated reads itself, archives the exact bodies
under GitHub's provider-computed artifact digest, and the consumer independently
re-fetches the fixed repository/workflow/run/job/artifact tuple. Missing API
fields, unsupported Render job/log inventory, redirects outside the allowed
GitHub artifact hosts, and any identity or digest mismatch fail closed.

The rollout-evidence workflow also requires the production environment's fixed
`REVIEW_ROUTER_RUNTIME_OBSERVATION_ORIGIN` and scoped bearer credential. That
HTTPS observer must serve the checked contract endpoints for the exact rollout
ID; it is the residual trust boundary for live canary, compatibility, and
ordered event observations. The workflow never accepts operator file paths or
JSON inputs, and archives those authenticated response bodies in the same
provider-digested artifact.

1. Run `REVIEW_ROUTER_RENDER_PHASE=prepare pnpm deploy:render:hosted-beta`.
   Keep web, API, and worker mutation admission off and deploy no runtime
   service yet. Dispatch the canonical workflow once. Its Render job receives
   the release credential only for that invocation, runs the preflight,
   migration, grants, and role verification, and emits one sanitized JSON log
   record. Never run the caller as a cron, worker, service
   `preDeployCommand`, or manual shell command. A failed attempt requires a new
   rollout ID and run; artifacts from failed or superseded attempts are not
   accepted.

2. Capture the Render API database version and the single successful migration
   job's service/deploy/job IDs, commit, image digest, status, and timestamp.
   The rollout verifier rejects zero or multiple callers. Runtime services have
   canonical `preDeployCommand: null` and cannot use the release credential.

3. Run the production-writer capture with the release credential and the raw,
   byte-for-byte Render observation path. It copies immutable deploy identity
   from that observation; commit/image/application-name environment labels are
   not accepted as identity.

4. Record the workflow repository ID, run ID, run attempt, job ID, artifact ID,
   artifact name, and rollout ID returned by GitHub. Set the corresponding
   `REVIEW_ROUTER_ROLLOUT_EVIDENCE_*` variables plus
   `REVIEW_ROUTER_ROLLOUT_GITHUB_TOKEN` (read-only `actions` and `contents`
   access). `runtime-deploy` downloads the archive itself and rejects a wrong,
   stale, replayed, expired, locally substituted, or digest-mismatched artifact.
   It also requires the exact commit/image/database, one successful caller,
   provider response bindings, canonical output, and four verified roles. Run:

```bash
REVIEW_ROUTER_RENDER_PHASE=runtime-deploy pnpm deploy:render:hosted-beta
```

The helper revalidates every resource scope immediately before each complete
secret-bearing environment PUT, then explicitly deploys web, API, and worker
at the evidence-bound commit/image. Missing or mismatched evidence is fatal.

5. Confirm the API health endpoint:

```bash
curl -fsS https://api.reviewrouter.site/health
```

6. Confirm the API demo endpoints:

```bash
REVIEW_ROUTER_API_URL=https://api.reviewrouter.site pnpm hosted:api-demo:check
curl -fsS https://api.reviewrouter.site/docs >/dev/null
curl -fsS https://api.reviewrouter.site/demo.md | head
curl -fsS https://api.reviewrouter.site/openapi.json | jq .info
```

7. Confirm the web dashboard loads:

```bash
curl -fsS https://reviewrouter.site/status
```

## Local Validation Against Hosted Env

Create a local `.env.production` from the Render values, or export equivalent
environment variables locally, then run:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm hosted:check
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm public-beta:check
```

Before inviting public testers, also run a true GitHub-hosted action smoke
against the public API URL:

```text
GitHub-hosted runner -> public HTTPS API -> OIDC exchange -> config fetch -> health report -> dashboard health
```

## Operational Notes

- Keep web, API, and worker on the same git commit.
- Do not enable cloud review execution in Render.
- Do not add `pull_request_target` to generated customer workflows.
- In hosted production, leave `REVIEW_ROUTER_ACTION_REF` unset or set it to
  `777genius/review-router@main` so general/non-rotating generated customer
  workflows receive the latest public Action runtime. Rotating Codex OAuth
  workflows never inherit that channel: they require
  `REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF` at an exact 40-character SHA. Keep
  old exact SHAs in `REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS` only
  through the documented drain-and-reseed transition.
- The Postgres `ipAllowList: []` setting keeps the database private to Render's
  network. Use Render shell or trusted admin tooling for direct DB operations.
