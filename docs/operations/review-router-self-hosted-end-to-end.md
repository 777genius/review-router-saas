# Self-Hosted ReviewRouter End-to-End

This runbook takes an operator from a clean host to the first real ReviewRouter
review on github.com.

Use a disposable test organization and repository for the first rollout. Do
not make a production repository the first proof of a new control-plane
deployment.

## Target Architecture

The self-hosted stack runs:

```text
web + api + worker + migrate + PostgreSQL
```

The target repository runs the public ReviewRouter Action in GitHub Actions.
The runner reads source code and invokes the provider. The control plane
receives identities, revision metadata, normalized review artifacts, and
publication state. Provider secrets and raw OAuth files stay in GitHub Actions
secrets.

This guide uses the recommended client-triggered Direct V2 path:

```text
pull_request event
  -> canonical schema-2 workflow
  -> GitHub OIDC
  -> self-hosted control plane authorization
  -> provider work on the GitHub runner
  -> revision-fenced publication
```

## 1. Prerequisites

Prepare:

- a Linux host with Docker and Docker Compose v2
- public HTTPS web and API names, for example
  `reviewrouter.example.com` and `api.reviewrouter.example.com`
- Node.js 24 LTS, Corepack, Git, `gh`, `curl`, and OpenSSL on the operator
  machine
- a GitHub organization or account that can create and install a GitHub App
- a disposable repository for the first live review
- an exact 40-character commit from the public
  [ReviewRouter Action](https://github.com/777genius/review-router)
- a maintainer-approved Review v2 release bundle for that exact Action commit

Commands marked **host** run on the self-hosted server. Commands marked
**workstation** run where the operator has a browser, `gh`, and Codex login.
Keeping two source checkouts is acceptable; deploy only the reviewed host
revision and transfer credentials through a secure channel.

On the **host**, clone and install:

```bash
git clone https://github.com/777genius/review-router-saas.git
cd review-router-saas
corepack enable
pnpm install --frozen-lockfile
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
chmod 600 deploy/self-hosted/.env
```

Pin the control-plane source to a reviewed commit or release. Do not deploy an
unreviewed moving branch.

## 2. Configure DNS and TLS

Terminate HTTPS with Caddy, Nginx, Traefik, or a load balancer and route:

```text
https://reviewrouter.example.com     -> 127.0.0.1:3000
https://api.reviewrouter.example.com -> 127.0.0.1:4000
```

Keep the Compose ports and PostgreSQL bound to localhost unless they are on a
private network.

Set these values in `deploy/self-hosted/.env`:

```dotenv
REVIEW_ROUTER_WEB_URL=https://reviewrouter.example.com
REVIEW_ROUTER_API_URL=https://api.reviewrouter.example.com
REVIEW_ROUTER_PUBLIC_WEB_URL=https://reviewrouter.example.com
REVIEW_ROUTER_PUBLIC_API_URL=https://api.reviewrouter.example.com
NEXTAUTH_URL=https://reviewrouter.example.com
```

## 3. Create the GitHub App

On the **workstation**, generate a GitHub App manifest. Passing the public URLs
is mandatory; otherwise the helper defaults to the hosted ReviewRouter service:

```bash
pnpm github-app:create -- \
  --permission-profile review-only \
  --web-url https://reviewrouter.example.com \
  --api-url https://api.reviewrouter.example.com \
  --name "ReviewRouter Self-Hosted"
```

For the client-triggered flow in this guide, `review-only` is the least
privilege profile. Use `managed-review` only when server-side dispatch and
cancellation are intentionally enabled in a different deployment mode.

Configure the App:

```text
Callback URL: https://reviewrouter.example.com/api/auth/callback/github
Setup URL:    https://reviewrouter.example.com/setup
Webhook URL:  https://api.reviewrouter.example.com/webhooks/github
```

Enable redirect after installation updates. Install the App only on the
disposable repository at first.

Copy the App values into the env file:

```dotenv
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY=
REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE=review-only
```

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` use the same values as the App
client ID and client secret. Encode private-key line breaks as `\n` in the env
file.

## 4. Configure Secrets and Direct V2

On the **host**, generate a URL-safe PostgreSQL password, then generate every
other secret independently. Never reuse one value for two purposes:

```bash
openssl rand -hex 32
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 32
```

At minimum, replace every placeholder for:

```text
POSTGRES_PASSWORD
AUTH_SECRET
REVIEW_ROUTER_ACTION_SESSION_SECRET
REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY
GITHUB_WEBHOOK_SECRET
```

Keep `DATABASE_URL` synchronized with `POSTGRES_PASSWORD`.

Client-triggered Direct V2 must keep these authority flags together:

```dotenv
REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE=client_triggered_t0
REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED=1
REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED=0
REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED=0
REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY=0
REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED=1
```

Do not enable server-side intent ingress or workflow dispatch in this mode. It
would create a second execution authority for the same review.

## 5. Bind an Exact Action Release

Set the exact public Action commit:

```dotenv
REVIEW_ROUTER_ACTION_REF=777genius/review-router@<40-character-commit>
```

A tag or branch is not accepted for Direct V2. The control plane also requires:

- independent authorization, Review V2 capability, and investigation lease
  capability signing key rings
- context session and replay keys
- a producer release attestation for the same Action commit
- a provider vote lane
- the SHA-256 of an operator credential

Generate and validate release material from the exact Action checkout:

```bash
pnpm protocol:release-manifest \
  --action-repo /path/to/review-router \
  --target-branch RELEASE_BRANCH \
  --expected-head ACTION_COMMIT_SHA \
  --output /secure/path/review-action-v2-release-manifest.json

pnpm protocol:release-manifest:check \
  --manifest /secure/path/review-action-v2-release-manifest.json \
  --action-repo /path/to/review-router
```

Populate the key rings, producer attestations, provider lanes, and context keys
using the exact shapes documented in
[`deploy/self-hosted/.env.example`](../../deploy/self-hosted/.env.example).
Do not invent release digests or copy the synthetic values from tests.

The repository does not yet generate a production policy bundle from the Action
manifest automatically. If you are not the release maintainer, use the
maintainer-approved bundle for the pinned Action commit and do not reconstruct
its digests manually. Automated release-material distribution remains tracked
as product work.

Create an operator credential, store only its hash in the shared env, and keep
the plaintext outside Compose:

```bash
export REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL="$(openssl rand -base64 48)"
printf %s "$REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL" \
  | openssl dgst -sha256 -r | awk '{print $1}'
```

Set the resulting hex digest as:

```dotenv
REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256=<sha256>
```

The detailed release bundle and activation contract is in the
[Review Action v2 cutover runbook](./review-action-v2-cutover.md).

## 6. Run Preflight and Disposable E2E

Validate the real env without printing secret values:

```bash
pnpm self-hosted:check
```

`self-hosted:check` already includes the Compose contract check. Use
`pnpm self-hosted:compose:check` alone only while editing Docker or Compose
wiring.

Before the first real deployment, run the isolated Compose proof:

```bash
pnpm self-hosted:e2e
```

The E2E creates its own synthetic environment and temporary Compose project. It
checks migrations, API/web health, OIDC, Review v2 contracts, secret redaction,
and cleanup. Passing it does not validate your real GitHub App, DNS, or provider
account; those are covered by the live canary below.

## 7. Start the Control Plane

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

The `migrate` service applies Prisma and Review v2 migrations before web, API,
and worker start.

Verify local services:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  ps

curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:3000/api/health
```

Then verify the public HTTPS endpoints:

```bash
curl -fsS https://api.reviewrouter.example.com/health
curl -fsS https://reviewrouter.example.com/api/health
```

Do not continue while migrations, API readiness, public TLS routing, or the
worker container startup is unhealthy. The worker currently has no separate
Compose health endpoint; inspect its state and startup logs:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  ps worker

docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  logs --tail=100 worker
```

## 8. Register the Release

The validated release manifest proves the Action artifacts. The Review v2
release bundle also binds protocol limits, operational SLOs, owner references,
and runbook references. Build the bundle described in the
[cutover runbook](./review-action-v2-cutover.md) from the validated manifest,
then copy it into the API container:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  cp /secure/path/review-v2-release-bundle.json \
  api:/tmp/review-v2-release-bundle.json
```

Operator commands must run against the Compose database and runtime env. Export
the plaintext credential only in the operator shell and use this helper:

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

Check the runtime env and register the release:

```bash
rr_admin env-preflight
rr_admin release register \
  --bundle /tmp/review-v2-release-bundle.json \
  --confirm release
```

Do not run the admin CLI directly on the host unless the host process has the
same production `DATABASE_URL`, keys, GitHub App identity, and operator
credential as the Compose API.

## 9. Connect a Repository

1. Open the self-hosted web URL and sign in with GitHub.
2. Install the self-hosted GitHub App on the disposable repository.
3. Return to the setup flow and wait for repository sync.
4. Confirm the repository is selected, active, and reports a healthy App
   installation.

On the **workstation**, point the Codex rotating OAuth reseed command at the
self-hosted web app:

```bash
REVIEW_ROUTER_CODEX_RESEED_API_URL="https://reviewrouter.example.com/api/codex-rotating/cli/setup-command" \
  scripts/reseed-codex-rotating-auth.sh \
  --repo OWNER/REPOSITORY
```

The command performs a repository-scoped GitHub permission check, starts an
isolated Codex login, and writes the confirmed rotating generation to the
repository secret. With the least-privilege `review-only` App profile it does
not write repository workflow files.

Never replace `REVIEWROUTER_CODEX_AUTH_JSON` with a direct `gh secret set`.
Rotating auth has a generation handshake. Bypassing it can make a queued run
present an older generation and be rejected.

Generate the canonical workflow from the same domain renderer used by
ReviewRouter. Run this from the ReviewRouter control-plane checkout on the
**workstation**, with a local checkout of the target repository:

```bash
export TARGET_REPO=OWNER/REPOSITORY
export TARGET_REPO_CHECKOUT=/path/to/target-repository
export REVIEW_ROUTER_ACTION_SHA=<40-character-commit>
export REVIEW_ROUTER_SELF_HOSTED_API_URL=https://api.reviewrouter.example.com
export TARGET_REPO_ID="$(gh api "repos/$TARGET_REPO" --jq .id)"

mkdir -p "$TARGET_REPO_CHECKOUT/.github/workflows"

pnpm tsx -e '
import { renderCanonicalCodexRotatingT0WorkflowV2 } from "./packages/features/codex-oauth-rotating/src/index.ts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

process.stdout.write(renderCanonicalCodexRotatingT0WorkflowV2({
  actionRef: `777genius/review-router@${required("REVIEW_ROUTER_ACTION_SHA")}`,
  apiUrl: required("REVIEW_ROUTER_SELF_HOSTED_API_URL"),
  providerInstanceId: `codex-rotating:${required("TARGET_REPO_ID")}`,
  refreshScheduleCron: "17 */6 * * *",
  claudeCodeOAuthTokenSecret: false,
  openRouterApiKeySecret: false,
}));
' > "$TARGET_REPO_CHECKOUT/.github/workflows/reviewrouter-codex.yml"
```

Commit the workflow through a pull request. Do not write it directly to the
default branch. Operators using the broader `provisioning` profile may use the
dashboard setup PR instead, but the resulting file must be byte-compatible
with the canonical renderer.

Inspect `.github/workflows/reviewrouter-codex.yml` on the repository's default
branch and confirm:

- schema version is `2`
- the reusable workflow and runtime ref use the configured full Action SHA
- the API URL points to this self-hosted deployment
- the workflow uses `pull_request`, not `pull_request_target`
- permissions are limited to `contents: read`, `pull-requests: read`, and
  `id-token: write`

## 10. Initialize Review Authority

Migration leaves the global emergency stop active. For a repository first
onboarded after migration v7:

```bash
rr_admin cohort stage \
  --repo OWNER/REPOSITORY \
  --confirm OWNER/REPOSITORY

rr_admin emergency global open \
  --confirm global

rr_admin mutation initialize-direct-v2 \
  --repo OWNER/REPOSITORY \
  --confirm OWNER/REPOSITORY
```

`initialize-direct-v2` must reject a non-canonical workflow, an unregistered
Action SHA, missing worker/safety policy, or evidence of previous legacy
authority.

Do not use this command for a repository identity that existed during migration
v7. Existing identities are deliberately fenced as `v1_open` and require the
drain/activate sequence in the
[cutover runbook](./review-action-v2-cutover.md).

## 11. Prove the First Review

Open a small pull request in the disposable repository and confirm:

- exactly one ReviewRouter workflow starts for the head SHA
- OIDC admission succeeds before provider work
- the provider runs only on the GitHub Actions runner
- the ReviewRouter check reaches a terminal state
- summary and inline findings refer to the current revision
- API and worker logs contain safe codes, not auth or provider secrets

Push one additional commit and verify the previous revision cannot publish as
fresh output for the new head. Completed evidence may be reused only when the
attested compatibility policy accepts it.

Treat provider quota exhaustion and auth revocation as different failures. A
quota-limited account does not prove the ReviewRouter auth contract is broken.

## 12. Operate and Upgrade

Create a database backup before every upgrade:

```bash
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > reviewrouter.dump
```

Upgrade one reviewed revision at a time:

```bash
git fetch --tags origin
git checkout <reviewed-commit-or-release>
pnpm install --frozen-lockfile
pnpm self-hosted:check
docker compose \
  --env-file deploy/self-hosted/.env \
  -f deploy/self-hosted/compose.yml \
  up -d --build
```

All services must run the same commit. The migration step is idempotent and
must finish before application services become healthy.

Emergency stop:

```bash
rr_admin emergency global stop --confirm global
```

Pause one repository when publication is ambiguous:

```bash
rr_admin mutation pause \
  --repo OWNER/REPOSITORY \
  --confirm OWNER/REPOSITORY
```

Do not delete or rewrite authority rows to recover a repository.

## Definition of Done

- `pnpm self-hosted:check` passes against the production env
- `pnpm self-hosted:e2e` passes on the release source
- web, API, migration, and PostgreSQL are healthy; worker is running without
  startup failures
- public HTTPS endpoints and GitHub webhooks work
- GitHub App permissions match the configured profile
- the repository workflow is canonical schema 2 at the exact Action SHA
- rotating auth was installed through the reseed flow
- repository authority is initialized through the correct path
- a disposable PR and a follow-up revision both complete correctly
- backups and emergency stop have been exercised

For configuration details, failure codes, scaling, restore, and security notes,
use the [self-hosted deployment reference](../../deploy/self-hosted/README.md).
