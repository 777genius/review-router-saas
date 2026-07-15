# ReviewRouter

ReviewRouter is a local-beta SaaS control plane for AI pull request review.
It is open source: https://github.com/777genius/review-router.

The product does not run customer review workloads in the cloud by default.
Customer code, diffs, provider secrets, and Codex OAuth files stay inside the
customer GitHub Actions environment. The SaaS owns GitHub App onboarding,
repository sync, workflow setup PRs, dashboard-managed review config, audit,
health, and safe provider setup guidance.

## Current State

Implemented local-beta baseline:

- GitHub App installation and webhook ingestion
- repository sync and dashboard repository health
- workflow setup PR provisioning
- GitHub Actions OIDC action session exchange
- versioned workspace default and repository override review config
- Codex OAuth, Claude Code OAuth, OpenAI API-key, and OpenRouter setup guidance
  without sending secrets to ReviewRouter
- safe action health reports and repo-health rollups
- audit log, entitlements, outbox, worker loop, rate limits, and DB-backed
  smoke checks
- Codex OAuth secret seeding helper at `scripts/seed-codex-auth.sh`

Not production-complete yet:

- hosted GitHub App lifecycle events and public onboarding polish
- public onboarding polish
- payments
- enterprise SSO
- production support/admin tooling

## Start Here

New implementation agents should read:

1. [`ai-docs/AGENT_START_HERE.md`](./ai-docs/AGENT_START_HERE.md)
2. [`ai-docs/ROOT_PLAN.md`](./ai-docs/ROOT_PLAN.md)
3. [`ai-docs/IMPLEMENTATION_PLAYBOOK.md`](./ai-docs/IMPLEMENTATION_PLAYBOOK.md)
4. [`ai-docs/LOCAL_SETUP_CHECKLIST.md`](./ai-docs/LOCAL_SETUP_CHECKLIST.md)
5. [`ai-docs/iterations/00-roadmap.md`](./ai-docs/iterations/00-roadmap.md)
6. [`ai-docs/appendices/blocker-handling.md`](./ai-docs/appendices/blocker-handling.md)

The current implementation focus is beta hardening across iterations 08-11,
not rebuilding the foundation from scratch.

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

Use `--reuse-current-auth` only immediately after creating a known-current
session in that dedicated home. The default fresh login avoids reseeding stale
local OAuth state.

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

Fresh repository E2E:

```bash
node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

Full review E2E with Codex OAuth and a real inline finding:

```bash
REVIEW_ROUTER_FRESH_E2E_MODE=review \
  node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

The same real GitHub smokes can be included in `beta:check`:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
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
