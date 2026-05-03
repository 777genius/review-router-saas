# System Overview

## One Sentence

ReviewRouter is a SaaS control plane that installs, configures, audits, and updates AI pull request review workflows while review execution runs in the customer's CI/CD.

## High-Level Components

```text
Customer Browser
  -> ReviewRouter Web Dashboard
      -> ReviewRouter API
          -> PostgreSQL
          -> Job Queue
          -> GitHub API

GitHub
  -> ReviewRouter GitHub App Webhooks
      -> ReviewRouter API
          -> Webhook Delivery Store
          -> Jobs

Customer Repository
  -> GitHub Actions Workflow
      -> ReviewRouter Action
          -> Codex CLI / OpenAI / OpenRouter / future providers
          -> GitHub PR comments/status
```

## SaaS Responsibilities

- GitHub OAuth login.
- Shared GitHub App installation lifecycle.
- Workspace/org/repo discovery.
- ReviewRouter workflow provisioning via PR.
- Config and policy management.
- Provider setup state and health visibility.
- OIDC-authenticated runtime config fetch for ReviewRouter Action.
- Metadata-only action health reporting.
- Audit log.
- Update recommendations and update PRs.
- License/entitlement checks, free plan first.

## Customer CI Responsibilities

- Checkout repository code.
- Restore provider secrets from GitHub repo/org secrets or runner environment.
- Run ReviewRouter Action.
- Run Codex CLI / provider calls.
- Post review comments and status checks.
- Report optional health/status metadata back to SaaS in future.

## Trust Boundary

ReviewRouter SaaS v1 should not receive:

- repository source code
- pull request diffs
- Codex OAuth `auth.json`
- model API keys

ReviewRouter SaaS v1 may receive:

- GitHub Actions OIDC claims for action authentication
- action health metadata without code/diff/secrets
- GitHub installation metadata
- repository names/ids/visibility
- workflow health status
- config metadata
- audit events
- setup state

## Deployment Shape

```text
Load Balancer
  -> apps/api instance 1
  -> apps/api instance 2
  -> apps/api instance N

apps/web
  -> static/server-rendered dashboard

apps/worker instance 1..N
  -> pg-boss jobs
  -> outbox consumers

Shared:
  PostgreSQL
  queue tables
  advisory locks
  object storage later if needed
```

## Stateless Rule

API and worker instances must not rely on in-memory state for correctness.

State belongs in:

- PostgreSQL
- queue tables
- outbox tables
- signed cookies/session store
- GitHub as external source of truth where appropriate

## Implementation Stack

```text
TypeScript
pnpm workspaces
Turborepo
Next.js
Base UI
Tailwind CSS
Zustand
TanStack Query
nuqs
React Hook Form
Fastify
tRPC
PostgreSQL
Prisma
pg-boss
Octokit
Zod
```
