# ReviewRouter

ReviewRouter is an open-source control plane for AI pull request review. It can
run as the hosted ReviewRouter service or as a self-hosted deployment on your
own infrastructure. The public GitHub Action runtime lives at
[777genius/review-router](https://github.com/777genius/review-router).

Review execution stays inside the repository's GitHub Actions runner. Source
code, diffs, provider credentials, and Codex OAuth files are not sent to the
control plane by default. The control plane owns authorization, repository and
revision state, reusable review evidence, publication, audit, and health.

## Deployment Options

| Mode        | Control plane                                | Review execution           | Start here                                                                                 |
| ----------- | -------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| Hosted      | Operated by ReviewRouter                     | Your GitHub Actions runner | [Hosted deployment](./deploy/README.md)                                                    |
| Self-hosted | Your API, web, worker, Postgres, DNS and TLS | Your GitHub Actions runner | [End-to-end self-hosting guide](./docs/operations/review-router-self-hosted-end-to-end.md) |

The self-hosted control plane is implemented and covered by disposable Compose,
migration, OIDC, and Review v2 E2E gates. It is currently an operator-managed
deployment rather than a one-click installer: the operator must configure a
GitHub App, HTTPS, release attestations, signing keys, and repository activation.
See the [deployment reference](./deploy/self-hosted/README.md) for the complete
configuration contract.

## Current State

Implemented:

- GitHub App installation and webhook ingestion
- repository sync and dashboard repository health
- workflow setup PR provisioning
- GitHub Actions OIDC action session exchange
- first-class Docker Compose self-hosted control plane with migration, web, API,
  worker, and PostgreSQL services
- client-triggered Direct V2 review with the least-privilege `review-only`
  GitHub App profile
- exact-revision authorization, revision-aware evidence reuse, stale-run
  fencing, and fail-closed publication
- versioned workspace default and repository override review config
- Codex OAuth, Claude Code OAuth, OpenAI API-key, and OpenRouter setup guidance
  without sending secrets to ReviewRouter
- safe action health reports and repo-health rollups
- audit log, entitlements, outbox, worker loop, rate limits, and DB-backed
  smoke checks
- Codex OAuth rotating-auth reseed flow with generation confirmation

Remaining product work:

- one-click self-hosted install and automated release-material distribution
- public onboarding and operator UX polish
- payments
- enterprise SSO
- production support/admin tooling

## Self-Hosted Quick Check

The disposable E2E gate needs Docker Compose but does not require a real GitHub
App or repository:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm self-hosted:check:smoke
pnpm self-hosted:e2e
```

For a real deployment, follow the
[end-to-end self-hosting guide](./docs/operations/review-router-self-hosted-end-to-end.md).
Do not start from the Compose file alone: production readiness also requires an
exact Action release, release attestations, repository authority initialization,
and a canonical schema-2 workflow.

## Documentation

- [Self-hosted end-to-end guide](./docs/operations/review-router-self-hosted-end-to-end.md)
- [Self-hosted deployment reference](./deploy/self-hosted/README.md)
- [Self-hosted workflow contract](./docs/operations/review-router-self-hosted-workflow-contract.md)
- [Review Action v2 cutover](./docs/operations/review-action-v2-cutover.md)
- [Review configuration operator CLI](./docs/operations/review-configuration-operator-cli.md)
- [Self-hosted privacy boundary](./docs/privacy-self-hosted.md)
- [Self-hosted architecture decision](./docs/adr/ADR-review-router-self-hosted-control-plane.md)

## Contributor Start Here

New implementation agents should read:

1. [`ai-docs/AGENT_START_HERE.md`](./ai-docs/AGENT_START_HERE.md)
2. [`ai-docs/ROOT_PLAN.md`](./ai-docs/ROOT_PLAN.md)
3. [`ai-docs/IMPLEMENTATION_PLAYBOOK.md`](./ai-docs/IMPLEMENTATION_PLAYBOOK.md)
4. [`ai-docs/LOCAL_SETUP_CHECKLIST.md`](./ai-docs/LOCAL_SETUP_CHECKLIST.md)
5. [`ai-docs/iterations/00-roadmap.md`](./ai-docs/iterations/00-roadmap.md)
6. [`ai-docs/appendices/blocker-handling.md`](./ai-docs/appendices/blocker-handling.md)

For hosted beta handoff, read [`deploy/README.md`](./deploy/README.md) and use
[`deploy/env.production.example`](./deploy/env.production.example) as the env
template.

## Local Checks

First-time local bootstrap:

```bash
pnpm local:bootstrap
```

This creates `.env.local` if needed, ensures dev/test Postgres databases exist,
installs dependencies, generates Prisma client, and applies migrations. It does
not create a GitHub App or store secrets.

Baseline:

```bash
pnpm beta:check
```

Compiled production runtime smoke:

```bash
pnpm build
pnpm runtime:smoke
```

Hosted env readiness:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=deploy/env.production.example pnpm hosted:check
```

Hosted API demo smoke:

```bash
REVIEW_ROUTER_API_URL=https://api.reviewrouter.site pnpm hosted:api-demo:check
```

## Codex OAuth Reseed

Reconnect a repository-scoped rotating Codex session without signing in to the
ReviewRouter dashboard:

```bash
curl -fsSL https://reviewrouter.site/install/codex-reseed | bash -s -- \
  --repo OWNER/REPOSITORY
```

The bootstrap uses the current `gh auth` token only for a request-scoped GitHub
repository permission check. It performs a fresh Codex login in the dedicated
`~/.reviewrouter/codex/OWNER-REPOSITORY` home, writes `auth.json` directly to
the repository GitHub Actions secret, and confirms the new rotating generation.
The GitHub token and Codex OAuth file are not persisted by ReviewRouter.

Do not update `REVIEWROUTER_CODEX_AUTH_JSON` with a direct `gh secret set`.
Rotating Codex auth has a generation confirmation step; bypassing it can leave
the control plane rejecting the run as an older queued secret generation.

Operational evidence from the 2026-07-27 managed ReviewRouter v2 smoke matched
this failure mode: a direct secret write produced an older-generation rejection,
while the generated reseed flow succeeded after selecting a non-limited Codex
session. Provider quota-limit failures are capacity state, not proof that the
rotating auth contract is broken.

Use `--reuse-current-auth` only immediately after creating a known-current
session in that dedicated home. The default fresh login avoids reseeding stale
local OAuth state.

## Review Configuration CLI

Platform operators can read or pin a repository's reasoning effort without
opening the ReviewRouter dashboard or signing in to GitHub:

```bash
reviewrouter config get --repo OWNER/REPOSITORY
reviewrouter config set --repo OWNER/REPOSITORY --effort xhigh
```

The command uses a host-bound local operator profile and a dedicated
least-privilege server credential. It does not use GitHub OAuth and cannot
perform Review v2 rollout or emergency-control operations. See the
[operator CLI runbook](./docs/operations/review-configuration-operator-cli.md).

Draft pull request review is disabled by default. Enable or disable it per
repository without reprovisioning the workflow:

```bash
gh variable set REVIEW_ROUTER_REVIEW_DRAFTS --repo OWNER/REPOSITORY --body true
gh variable delete REVIEW_ROUTER_REVIEW_DRAFTS --repo OWNER/REPOSITORY
```

Only the exact value `true` enables draft review. Removing the variable, or
setting any other value, keeps draft pull requests skipped. Fork and bot pull
requests remain blocked in both modes.

Reviews have a 60-minute job budget by default, with the review subprocess
stopped five minutes earlier so cleanup can finish. Override the full job
budget per repository with an integer from 10 through 360 minutes:

```bash
gh variable set REVIEW_ROUTER_TIMEOUT_MINUTES --repo OWNER/REPOSITORY --body 180
gh variable delete REVIEW_ROUTER_TIMEOUT_MINUTES --repo OWNER/REPOSITORY
```

To skip oversized pull requests before any OAuth lease or Codex session is
used, set a maximum for `additions + deletions`:

```bash
gh variable set REVIEW_ROUTER_MAX_CHANGED_LINES --repo OWNER/REPOSITORY --body 10000
gh variable delete REVIEW_ROUTER_MAX_CHANGED_LINES --repo OWNER/REPOSITORY
```

An unset, empty, or `0` value disables the size limit. A configured limit fails
closed when GitHub does not provide the changed-line count.

Public demo endpoints:

```text
GET /       - public API index with demo, docs, and dashboard links
GET /health - liveness plus dependency health
GET /ready  - compact readiness response for demos and uptime checks
GET /demo   - public control-plane capability summary, quick start, security boundaries
GET /demo.md - terminal-friendly Markdown API demo summary
GET /docs   - browser-friendly API demo page
GET /openapi.json - machine-readable public API surface
```

Use a real staging/prod env file or host-provided environment variables. The
example file should fail until placeholders are replaced.

Database and protocol smoke can be included:

```bash
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
```

The DB gate includes migration smoke, backup/restore smoke, webhook lifecycle,
outbox recovery, rate limits, distributed locks, runtime config, and support
diagnostics.

## Release And Git Flow

Release process, `v1` tag handling, and daily git flow are documented in
[`ai-docs/operations/07-environments-and-release-management.md`](./ai-docs/operations/07-environments-and-release-management.md).

Real GitHub smoke helpers require a disposable GitHub App installation and
selected test repository:

```bash
REVIEW_ROUTER_TARGET_REPO=owner/repo \
  node scripts/run-with-env.mjs pnpm spike:repo-health:e2e
```

App-first Codex rotating live E2E in a disposable repository:

```bash
REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1 \
REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER=owner \
REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME=rr-codex-rotating-e2e \
REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF=owner/review-router@FULL_40_CHAR_SHA \
pnpm subscription-runtime:live-e2e
```

This gate verifies the rotating workflow, real writeback, and the exact GitHub
App comment author. The historical `spike:github:fresh-repo:e2e` direct workflow
is not valid SaaS rollout evidence.

The same real GitHub smokes can be included in `beta:check`:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=codex-rotating pnpm beta:check
```

The fresh E2E script creates real GitHub repositories and does not delete them
automatically. Use a disposable owner/repo name and clean up manually when done.

## Architecture Boundary

Feature packages follow Clean Architecture:

```text
domain <- application <- interface/adapters
application -> ports <- infrastructure
```

The web dashboard composes features at the edge. Domain/application packages do
not import Prisma, Octokit, Fastify, tRPC, Next.js, or Auth.js directly.
