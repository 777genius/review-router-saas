# ReviewRouter

ReviewRouter is a local-beta SaaS control plane for AI pull request review.

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
- Codex OAuth, Codex API-key, and OpenRouter setup guidance without secret
  custody
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
- release automation for the separate `777genius/review-router` Action runtime

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
REVIEW_ROUTER_API_URL=https://reviewrouter-api.onrender.com pnpm hosted:api-demo:check
```

Public demo endpoints:

```text
GET /       - public API index with demo, docs, and dashboard links
GET /health - liveness plus dependency health
GET /ready  - compact readiness response for demos and uptime checks
GET /demo   - public control-plane capability summary, quick start, security boundaries
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
