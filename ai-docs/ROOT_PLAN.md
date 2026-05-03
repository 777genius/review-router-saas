# ReviewRouter Root Plan

## Product Goal

Build ReviewRouter as a SaaS control plane for AI pull request review where the expensive and sensitive review execution runs inside the customer's CI/CD by default.

The SaaS should make setup, configuration, policy management, audit, and updates easy without taking custody of repository code or Codex OAuth credentials in v1.

## Core Direction

```text
ReviewRouter SaaS = control plane
Customer CI/CD = execution plane
GitHub App = shared identity and installation surface
ReviewRouter Action = review runtime executed in customer repo
```

## Non-Negotiable v1 Principles

1. Do not run code review in ReviewRouter cloud by default.
2. Do not store Codex ChatGPT OAuth `auth.json` in ReviewRouter SaaS.
3. Do not store repository code or pull request diffs in SaaS v1.
4. Treat GitHub installations, repositories, configs, and users as multi-tenant from day one.
5. Every webhook and background job must be idempotent.
6. API instances must be stateless and horizontally scalable.
7. Workers must support multiple instances safely.
8. Distributed locks must use Postgres/queue-level mechanisms, not in-memory mutexes.
9. Config changes must be versioned and auditable.
10. Frameworks must stay outside domain/application layers.
11. Runtime config fetch must use GitHub Actions OIDC, not long-lived SaaS tokens in repos.
12. Action-to-SaaS reporting must be metadata-only.
13. Generated workflows must not use `pull_request_target` for default review execution.
14. Runtime config must be versioned and backwards compatible with installed action versions.
15. Dashboard auth must use OAuth state, secure sessions, CSRF protection, and application authorization policies.
16. GitHub installation lifecycle changes must be modeled explicitly.
17. Same-repository PRs are not automatically safe; docs and generated workflows must reflect the trust boundary.
18. Action release/update compatibility must be explicit and reversible.
19. Support/admin access must be audited and metadata-only.
20. Every new SaaS payload field must be data-classified before implementation.
21. Action health reports must enforce strict schema, size limits, and server-side secret/code rejection.
22. Critical invariants must be backed by database constraints, not only application checks.
23. Free beta still needs quotas and abuse controls.
24. Webhooks must be normalized into safe internal events; raw GitHub payloads are not stored by default.
25. OIDC validation must handle JWKS caching, clock skew, replay resistance, and action-session scoping.
26. Customer CI must degrade gracefully when SaaS control plane is unavailable.
27. Internal events/jobs must be versioned and poison jobs must dead-letter safely.
28. Telemetry/tracing must not capture request bodies, code, diffs, prompts, secrets, or raw webhook payloads.
29. Workspace membership, invites, and ownership transfer must preserve at least one owner and audit every role change.


## Validated Technical Spike

A real GitHub App + GitHub Actions OIDC spike has been implemented and run against a smoke repository. Results are documented in [`spikes/github-app-oidc-reality-spike.md`](./spikes/github-app-oidc-reality-spike.md).

Key outcome:

```text
ReviewRouter will use `workflows: write` for one-click workflow setup/update PRs.
GitHub Actions OIDC is sufficient for short-lived action sessions and metadata-only config exchange.
Provider credentials still stay in customer GitHub Secrets or trusted runners, not in SaaS.
```

## Recommended Stack

```text
Language: TypeScript
Monorepo: pnpm workspaces + Turborepo
Frontend: Next.js
Frontend primitives: Base UI
Frontend styling: Tailwind CSS
Frontend client UI state: Zustand
Frontend server state: TanStack Query through tRPC
Frontend URL state: nuqs
Frontend forms: React Hook Form + Zod
Backend API: Fastify
Dashboard API: tRPC
Public webhooks: plain Fastify routes
DB: PostgreSQL
ORM: Prisma
Queue/jobs: pg-boss first, replaceable later
Locks: Postgres advisory locks first, replaceable later
Action auth: GitHub Actions OIDC with short-lived action session token
GitHub SDK: Octokit
Validation: Zod
Auth: GitHub OAuth, implemented behind auth ports
```

## Hybrid Config Direction

Generated workflows include a static config snapshot and OIDC dynamic config support from the start. Dashboard changes to provider/model/effort are served through OIDC config fetch, while static workflow env remains a fallback if SaaS is unavailable. See [`architecture/32-provider-config-control-plane.md`](./architecture/32-provider-config-control-plane.md).

Codex OAuth is seeded with a separate local script that writes directly to GitHub Actions secrets. SaaS never receives `auth.json`. See [`architecture/33-codex-secret-seeding.md`](./architecture/33-codex-secret-seeding.md).

## Review Runtime

The existing `777genius/review-router` Action/Codex runtime is the baseline for agent execution. SaaS should configure and provision it, not move review execution into cloud by default. See [`architecture/31-review-agent-runtime-architecture.md`](./architecture/31-review-agent-runtime-architecture.md).

## Architecture Style

Feature-first modular monolith with DDD/Clean Architecture/Ports and Adapters.

Each feature owns its own layers:

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

Forbidden imports:

```text
No Prisma, Octokit, Fastify, tRPC, Next.js imports inside domain/application.
```

Frontend follows the same dependency discipline. See [`architecture/35-dashboard-frontend-architecture.md`](./architecture/35-dashboard-frontend-architecture.md), [`architecture/36-ui-component-wrapper-conventions.md`](./architecture/36-ui-component-wrapper-conventions.md), and [`architecture/37-frontend-clean-architecture.md`](./architecture/37-frontend-clean-architecture.md).

Visual direction is cyberpunk-future command center, implemented through accessible tokens rather than noisy decoration. See [`product/08-visual-direction.md`](./product/08-visual-direction.md).

## MVP Scope

Lean public beta without payments.

Included:

- GitHub OAuth login.
- Shared ReviewRouter GitHub App installation support.
- Workspace/org/repo dashboard.
- Workspace membership lifecycle with explicit roles and audited ownership changes.
- Repository sync from GitHub installations.
- One-click workflow provisioning by creating a pull request in selected repos with `workflows: write`.
- ReviewRouter config presets.
- Provider setup state tracking without storing Codex OAuth secrets.
- GitHub webhook ingestion with signature verification and idempotency.
- Audit log.
- Health checks for workflow/config/secrets.
- GitHub Actions OIDC protocol for runtime config fetch and safe health reports.
- OIDC validation and short-lived action-session security.
- Control-plane outage fallback behavior.
- Generated workflow security model for fork PRs and minimal permissions.
- Versioned action control plane API contract.
- GitHub installation lifecycle handling.
- Action update compatibility and rollback strategy.
- Support/admin access model.
- Data classification, webhook normalization, and action payload privacy model.
- Database constraints/indexes baseline.
- Abuse quotas and fair-use controls.
- Free plan entitlement boundary, ready for billing later.

Excluded from v1:

- Running reviews in ReviewRouter cloud.
- Storing customer Codex OAuth credentials.
- Storing repository source code or PR diffs.
- Paid billing enforcement.
- SSO/SAML.
- Enterprise self-hosted control plane.

## Rough Size Estimate

Lean beta:

```text
5k-8k LOC application code
1k-2.5k LOC tests
```

Production public beta with better audit, health, onboarding, and operational hardening:

```text
8k-14k LOC application code
2k-4k LOC tests
```

## Implementation Phases

For a detailed execution guide, follow [`IMPLEMENTATION_PLAYBOOK.md`](./IMPLEMENTATION_PLAYBOOK.md). This root plan defines the direction; the playbook tells an agent how to implement it from start to beta.

If an external dependency blocks real E2E work, follow [`appendices/blocker-handling.md`](./appendices/blocker-handling.md). The agent should keep moving on tests, contracts, mocks, docs, or adjacent tasks rather than waiting for the user unless the next step truly requires user action.

1. Foundation and monorepo skeleton with API contracts and dependency boundaries.
2. GitHub App/OAuth integration with secure sessions and CSRF.
3. Repository sync and workspace model.
4. Workflow provisioning PRs with generated workflow security rules.
5. Review config and provider setup state with config resolution rules.
6. Versioned action control plane protocol with GitHub Actions OIDC.
7. Webhooks, jobs, locks, and idempotency.
8. Health checks, audit, and public beta hardening.
9. Billing boundary, still free plan only.

See [`iterations/`](./iterations/00-roadmap.md) for detailed steps.
