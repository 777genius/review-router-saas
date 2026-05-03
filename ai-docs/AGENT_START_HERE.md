# Agent Start Here

This file is the handoff guide for an implementation agent that has no prior context.

## Current State

This repository is currently a planning/spike repository for the ReviewRouter SaaS control plane.

Implemented so far:

- planning docs under `ai-docs/`
- GitHub App/OIDC spike code under `spikes/github-oidc/`
- Codex OAuth secret seeding helper under `scripts/seed-codex-auth.sh`
- TypeScript test/typecheck setup for the spike

Not implemented yet:

- production monorepo skeleton
- `apps/web`
- `apps/api`
- `apps/worker`
- `packages/ui`
- Prisma schema
- production SaaS runtime

The next implementation step is [Iteration 01 - Foundation](./iterations/01-foundation.md).

For the full end-to-end build sequence, follow [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md).

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
4. [Implementation Principles](./appendices/implementation-principles.md)
5. [Blocker Handling](./appendices/blocker-handling.md)
6. [Iteration Roadmap](./iterations/00-roadmap.md)
7. The current iteration file.

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

Follow [Implementation Playbook](./IMPLEMENTATION_PLAYBOOK.md) and iterations in order:

1. Foundation and monorepo skeleton.
2. GitHub identity and App installation.
3. Repository sync and workspace dashboard.
4. Workflow provisioning PRs.
5. Review config and provider setup.
6. Action control-plane protocol with OIDC.
7. Webhooks, jobs, locks, and outbox.
8. Health, audit, and beta hardening.
9. Free entitlements and future billing boundary.

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

Baseline checks available now:

```bash
pnpm typecheck
pnpm spike:test
pnpm local:check
git diff --check
bash -n scripts/seed-codex-auth.sh
```

After the monorepo skeleton exists, add and use:

```bash
pnpm lint
pnpm test
pnpm build
pnpm db:migrate
```

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
issues: write
actions: write
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
- user seeds `CODEX_AUTH_JSON` directly to GitHub repo/org Actions secrets or uses persistent trusted runner `CODEX_HOME`

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
