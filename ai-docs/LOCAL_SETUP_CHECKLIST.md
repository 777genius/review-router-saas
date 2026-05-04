# Local Setup Checklist

This checklist prepares a local developer machine so an implementation agent can work autonomously.

The current target is local development only:

```text
web: http://localhost:3000
api: http://localhost:4000
database: local PostgreSQL
deploy/domain: not required yet
```

## Already Prepared Locally

These are expected to exist on this machine:

```text
review_router_dev
review_router_test
```

Local environment files:

```text
.env.example
.env.local
.local-secrets/
```

`.env.local` is ignored by git. `.local-secrets/` and `*.pem` files are ignored by git.

For first-time bootstrap, run:

```bash
pnpm local:bootstrap
```

This command is safe to rerun. It creates `.env.local` from `.env.example` if
needed, generates a local `AUTH_SECRET` when the placeholder is still present,
ensures dev/test PostgreSQL databases exist, installs dependencies, generates
Prisma client, and applies migrations. It does not create a GitHub App and it
does not write provider credentials.

Do not put provider credentials in `.env.local`. `pnpm local:check` fails if
the SaaS env file contains `CODEX_AUTH_JSON`, `CODEX_CONFIG_TOML`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or
`GEMINI_API_KEY`. Those values belong in customer GitHub Actions secrets or
trusted runner environments, not in the ReviewRouter control plane.

Apply database migrations before running the app:

```bash
pnpm db:migrate:deploy
pnpm db:migrate:smoke
```

`db:migrate:deploy` applies checked-in Prisma migrations to the configured local database. `db:migrate:smoke` creates a temporary fresh database, applies the migrations from zero, verifies critical tables/indexes, and drops the temporary database.

Run:

```bash
pnpm local:check
```

Expected result:

```text
Local readiness check passed.
```

Start local services with the root scripts so `.env.local` is injected from the repository root:

```bash
pnpm web:dev
pnpm api:dev
pnpm worker:dev
```

## Human Action 1 - Create Local GitHub App

Create a GitHub App for local development:

[Create a new GitHub App](https://github.com/settings/apps/new)

Recommended local values:

```text
GitHub App name:
ReviewRouter Local <your-nickname>

Homepage URL:
http://localhost:3000

Callback URL:
http://localhost:3000/api/auth/callback/github

Webhook:
Inactive for first local setup
```

If GitHub requires a webhook URL while inactive, use:

```text
http://localhost:4000/webhooks/github
```

GitHub will not reach localhost from the internet. Real webhook testing can be done later with ngrok.

## Human Action 2 - App Permissions

Repository permissions:

```text
Metadata: Read-only
Contents: Read and write
Workflows: Read and write
Pull requests: Read and write
Issues: no access for minimal v1, unless SaaS setup/help comments are explicitly enabled later
Actions: no access for minimal v1
```

Organization/account permissions:

```text
Members: no access for local v1
Administration: no access
Secrets: no access
```

Why these are needed:

- `contents: write` creates setup/update branch commits
- `workflows: write` writes `.github/workflows/reviewrouter.yml`
- `pull_requests: write` creates setup/update PRs
- `issues: write` is not required for minimal v1; the review workflow comments from customer CI with its own `GITHUB_TOKEN`
- `actions: write` is not required for minimal v1; action health reports use GitHub Actions OIDC instead

The app must still create PRs only. It must not push directly to default branches.

## Human Action 3 - Subscribe To Events

For first local development:

```text
Installation
Installation repositories
Pull request
```

Later, if dashboard health needs GitHub workflow event ingestion:

```text
Workflow run
Check suite
```

Do not subscribe to broad events unless a feature needs them.

## Human Action 4 - Generate Private Key

In the GitHub App settings:

1. Generate a private key.
2. Download the `.pem`.
3. Move it into:

```bash
mkdir -p .local-secrets
mv ~/Downloads/*.private-key.pem .local-secrets/review-router-local.private-key.pem
chmod 600 .local-secrets/review-router-local.private-key.pem
```

Never commit this file.

## Human Action 5 - Fill `.env.local`

Fill these values from the GitHub App settings:

```text
AUTH_SECRET
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_SLUG
GITHUB_APP_PRIVATE_KEY_FILE
GITHUB_WEBHOOK_SECRET
REVIEW_ROUTER_ACTION_REF
```

`REVIEW_ROUTER_ACTION_REF` is optional. Leave it unset to use the beta default
`777genius/review-router@main`. Set it only for a smoke branch or a pinned
release tag.

`REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS` is optional. Use it only to simulate or
mitigate a known-bad installed Action version during compatibility testing.

For local private key path:

```text
GITHUB_APP_PRIVATE_KEY_FILE="/Users/belief/dev/projects/review-router/.local-secrets/review-router-local.private-key.pem"
```

Use the same GitHub App client ID/secret for GitHub OAuth during local development unless a separate OAuth App is intentionally created later.

For local dashboard provisioning buttons:

```text
REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS="1"
REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING="1"
REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS="your-github-login"
```

`REVIEW_ROUTER_LOCAL_ADMIN_GITHUB_LOGINS` is a local beta escape hatch for GitHub App-created workspaces that do not yet have explicit `WorkspaceMember` rows. Do not use it as a production authorization model.

`pnpm local:check` intentionally requires the GitHub App, Auth.js, webhook
secret, private key file, and `REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING="1"`.
The goal is to catch broken setup-PR readiness before the dashboard looks
usable.

## Human Action 6 - Install App On Test Repo

Install the local GitHub App on selected repositories only.

Use a disposable test repository first. Do not install on production repos until the setup PR flow is tested.

## Optional Human Action - Real Webhooks With ngrok

Only needed when testing GitHub webhook delivery locally.

Run:

```bash
ngrok http 4000
```

Then update GitHub App settings:

```text
Webhook active: enabled
Webhook URL: https://<ngrok-host>/webhooks/github
Webhook secret: value from GITHUB_WEBHOOK_SECRET in .env.local
```

After testing, webhooks can be disabled again.

## What The Agent Can Do After This

Once the local App credentials are filled, the agent can:

- run local DB checks
- scaffold the monorepo
- implement Auth.js/GitHub OAuth behind ports
- mint GitHub App installation tokens
- test repository sync against the selected test repo
- create setup PRs in the selected test repo
- run local webhook tests with fixtures
- run real webhook tests if ngrok is configured

## If This Is Blocked

If the GitHub App is not ready, the agent should not wait.

The agent should continue with:

- domain/application layers
- mocked GitHub adapters
- workflow YAML renderer
- UI screens with fixtures
- DB schema and migrations
- unit and contract tests

See [Blocker Handling](./appendices/blocker-handling.md).
