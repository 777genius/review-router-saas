# Agent Start Here

This file is the handoff guide for an implementation agent that has no prior context.

## Current State

This repository is now an implemented local-beta ReviewRouter SaaS control plane, not just a planning spike.

Implemented so far:

- planning and implementation handoff docs under `ai-docs/`
- production monorepo skeleton with `apps/web`, `apps/api`, `apps/worker`, `packages/ui`, `packages/platform/*`, and `packages/features/*`
- Prisma/Postgres schema, migrations, local readiness checks, and DB smoke scripts
- GitHub App/OIDC spike and real smoke helpers under `spikes/github-oidc/`
- GitHub webhook ingestion with signature verification, normalized metadata storage, idempotent delivery handling, and outbox sync requests
- repository sync, dashboard repository health, workflow provisioning PR rendering, review config, provider setup guidance, action control-plane OIDC exchange, safe action health reports, entitlements, audit/outbox maintenance, and worker loop baseline
- fenced, versioned Codex OAuth setup/recovery under the dashboard and rotating
  installer contracts
- unit, integration-style, and local DB E2E checks for the implemented beta paths

Still not production-complete:

- hosted deployment and real domain/callback URLs
- payments
- enterprise SSO
- public production support/admin tooling
- polished production onboarding launch flow
- production release and compatibility automation for the separate `777genius/review-router` Action runtime

The current implementation focus is beta hardening across [Iteration 08](./iterations/08-health-audit-beta-hardening.md), [Iteration 09](./iterations/09-entitlements-billing-boundary.md), [Iteration 10](./iterations/10-github-app-lifecycle-webhooks.md), and [Iteration 11](./iterations/11-provider-secret-onboarding.md). Prefer unverified `Done When` items in those iteration files before adding new product scope.

For the full end-to-end build sequence, follow [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md).

For operational setup and recovery, follow [Operations runbooks](./operations/02-runbooks.md).
For releases and deployment, follow
[Environment and release management](./operations/07-environments-and-release-management.md)
and [Render hosted deployment](../deploy/render.md). The former
[Beta Runbook](./BETA_RUNBOOK.md) is a superseded compatibility landing page,
not an operational source.

If blocked, follow [Blocker Handling](./appendices/blocker-handling.md) and continue with unblocked tests, contracts, mocks, docs, or adjacent tasks instead of waiting silently.

## Decision Hierarchy

When documents appear to conflict, use this order:

1. [Root Plan](./ROOT_PLAN.md)
2. [Decision Records](./decisions/README.md)
3. `architecture/` documents
4. `product/` documents
5. `iterations/` documents
6. `appendices/open-questions.md`

Do not reopen an accepted ADR unless the user explicitly asks.

## Required Reading Before Coding

Read these first:

1. [Root Plan](./ROOT_PLAN.md)
2. [Context Summary](./context-summary.md)
3. [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md)
4. [Operations Runbooks](./operations/02-runbooks.md)
5. [Implementation Principles](./appendices/implementation-principles.md)
6. [Blocker Handling](./appendices/blocker-handling.md)
7. [Iteration Roadmap](./iterations/00-roadmap.md)
8. The current iteration file.

If touching frontend, also read:

- [Dashboard Frontend Architecture](./architecture/35-dashboard-frontend-architecture.md)
- [UI Component Wrapper Conventions](./architecture/36-ui-component-wrapper-conventions.md)
- [Frontend Clean Architecture](./architecture/37-frontend-clean-architecture.md)
- [Visual Direction](./product/08-visual-direction.md)

If touching GitHub/OIDC/workflow setup, also read:

- [One-Click Workflow Provisioning ADR](./decisions/014-one-click-workflow-provisioning.md)
- [GitHub Permission Matrix](./architecture/14-github-permission-matrix.md)
- [Generated Workflow Security](./architecture/15-generated-workflow-security.md)
- [Action Control Plane Protocol](./architecture/10-control-plane-protocol.md)
- [OIDC Validation and Action Session Security](./architecture/26-oidc-validation-and-action-session-security.md)
- [Incremental Review Snapshots](./architecture/46-incremental-review-snapshots.md)
- [GitHub/OIDC Reality Spike](./spikes/github-app-oidc-reality-spike.md)

If touching provider/auth setup, also read:

- [Codex Secret Seeding](./architecture/33-codex-secret-seeding.md)
- [Security and Secrets](./architecture/05-security-and-secrets.md)
- [Secret and Trust Model](./architecture/20-secret-and-trust-model.md)

## Non-Negotiable Product Boundaries

Do not implement:

- cloud code review execution in v1
- SaaS storage of repository code or PR diffs
- SaaS storage of Codex OAuth `auth.json`
- SaaS storage of model API keys by default
- default review execution through `pull_request_target`
- in-memory locks for correctness
- unversioned action-control-plane payloads
- raw webhook payload storage by default
- logging of secrets, diffs, prompts, or model responses

## Locked Stack

Use:

```text
Language: TypeScript
Package manager: pnpm
Monorepo: pnpm workspaces + Turborepo
Frontend: Next.js App Router
UI primitives: Base UI through packages/ui
Styling: Tailwind CSS
Client UI state: Zustand
Server state: TanStack Query through tRPC
URL state: nuqs
Forms: React Hook Form + Zod
Backend API: Fastify
Dashboard API: tRPC
Webhooks: plain Fastify routes
Database: PostgreSQL
ORM: Prisma
Jobs: pg-boss
GitHub SDK: Octokit
Auth: Auth.js behind auth ports
Validation: Zod
```

Do not replace these choices without a new ADR.

## Current Implementation Order

The foundation through core beta paths exists. Continue from the latest iteration docs and keep the same architectural boundaries:

1. Close unverified quality gates in iterations 08-11.
2. Prefer tests/E2E for already implemented flows over broad new features.
3. Keep SaaS metadata-only: no code, diffs, prompts, model responses, or provider secrets in the control plane.
4. Add behavior through feature application services and ports before adapters/UI.
5. Update the matching iteration file when a baseline becomes implemented.

Do not jump to billing, cloud execution, enterprise SSO, or managed review workers.

## How To Work On A Task

1. Read the current iteration file.
2. Check `git status --short`.
3. Identify the bounded context/feature affected.
4. Add or update tests first when behavior is clear.
5. Implement inside the feature's layer boundaries.
6. Run the relevant checks.
7. Update docs if the architecture or product behavior changed.
8. Keep changes within the current iteration unless the user asks otherwise.
9. If blocked, record the blocker and switch to the highest-value unblocked task from [Blocker Handling](./appendices/blocker-handling.md).

## Commands

Baseline checks:

```bash
pnpm beta:check
```

Include local DB E2E in the same gate:

```bash
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
```

Useful local DB E2E commands:

```bash
node scripts/run-with-env.mjs pnpm spike:webhook-lifecycle:e2e
node scripts/run-with-env.mjs pnpm spike:outbox-maintenance:e2e
node scripts/run-with-env.mjs pnpm spike:action:e2e
node scripts/run-with-env.mjs pnpm spike:review-config:e2e
node scripts/run-with-env.mjs pnpm spike:support-diagnostics:e2e
```

Useful real GitHub E2E commands:

```bash
node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

Or through the beta gate:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

The first command creates a disposable repository, provisions and merges the
setup PR, then verifies workflow health. The second also seeds Codex OAuth into
the disposable repo, opens an intentional auth-bypass PR, waits for GitHub
Actions, and verifies a failing ReviewRouter check plus inline finding.

## Backend Architecture Rules

Feature layout:

```text
features/<feature>/
  domain/
  application/
    ports/
  infrastructure/
  interface/
  tests/
```

Dependency rule:

```text
domain <- application <- interface
application -> ports <- infrastructure
```

Frameworks are adapters. Do not import Prisma, Octokit, Fastify, tRPC, or Next.js into domain/application layers.

## Frontend Architecture Rules

Feature layout:

```text
apps/web/src/features/<feature>/
  domain/
  application/
  adapters/
  interface/
  tests/
```

Rules:

- Base UI imports only inside `packages/ui`.
- Feature components import `@reviewrouter/ui/*`.
- Zustand stores are UI state only.
- TanStack Query/tRPC owns server state.
- nuqs owns URL state.
- React Hook Form + Zod owns form state.
- Route files compose screens and should not contain business logic.

## GitHub Workflow Provisioning Rules

The shared GitHub App uses these v1 repository permissions:

```text
metadata: read
contents: write
workflows: write
pull_requests: write
```

Workflow provisioning must:

- create a branch and PR
- never push directly to default branch
- not overwrite existing workflow without explicit update flow
- produce deterministic, testable workflow YAML
- include fork PR safety guards
- use `id-token: write` for OIDC runtime config
- avoid `pull_request_target` for default review execution

## Provider Secret Rules

Codex OAuth:

- SaaS never receives `auth.json`
- never write a stable or versioned GitHub Actions secret directly and never
  assemble an installer from a mutable URL
- use only the dashboard-issued command for the exact repository/provider; it
  carries the immutable installer URL/version/SHA-256 tuple, short-lived setup
  manifest, exact Action commit, mutation epoch, and never-reused namespace
- for a dropped response, external drift, account switch, restore, or writer
  promotion, stop prior writers and use the dashboard's acknowledged
  **Recover and issue forced reseed** flow; ordinary setup cannot mint recovery
  authority
- follow the full replay, tombstone, and witness transition contract in
  [Operations runbooks](./operations/02-runbooks.md)

OpenAI/OpenRouter API keys:

- v1 stores them in customer GitHub secrets by default
- SaaS tracks setup status only

## Data Classification Rule

Before adding a SaaS payload field, classify it:

```text
public
customer_metadata
sensitive_metadata
secret
code_or_diff
```

`secret` and `code_or_diff` are not allowed in SaaS v1 payloads.

## Definition Of Done For Implementation Work

Minimum:

- tests cover the behavior
- typecheck passes
- no dependency-boundary violation
- user-facing errors are actionable
- logs do not contain secrets/code/diffs
- docs updated if behavior or architecture changed

For GitHub/webhook/workflow work:

- idempotency tested
- retry behavior safe
- permission errors persisted and shown clearly
- tenant/workspace authorization enforced

For frontend work:

- keyboard/focus behavior preserved
- server state not mirrored into Zustand
- Base UI not imported directly from features
- design tokens used instead of hardcoded one-off styling
