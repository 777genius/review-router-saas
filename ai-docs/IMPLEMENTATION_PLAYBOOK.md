# Implementation Playbook

This playbook explains how to build ReviewRouter from the current planning/spike repository into a working public beta.

Use it as the execution guide. Use the ADRs and architecture docs as the source of truth for decisions.

## Product To Build

ReviewRouter is a SaaS control plane for AI pull request review.

```text
SaaS owns:
  onboarding
  GitHub App installation
  repository discovery
  workflow setup PRs
  configuration
  provider setup guidance
  health
  audit

Customer GitHub Actions owns:
  repository checkout
  provider credentials
  Codex/OpenAI/OpenRouter execution
  pull request review comments
  pull request status
```

The SaaS does not store repository code, PR diffs, Codex OAuth `auth.json`, prompts, model responses, or provider API keys in v1.

## Implementation Mindset

Build vertically, but keep architectural seams.

For each slice:

1. Add domain/application model first when invariants exist.
2. Add ports before adapters.
3. Add Prisma/Octokit/Fastify/tRPC/Next adapters at the edge.
4. Add tests for the use case and the adapter behavior.
5. Add UI only after the application use case contract is clear.
6. Run checks.

Do not implement unrelated future features while inside a slice.

If a task is blocked by an external account, secret, GitHub org action, or unavailable service, follow [Blocker Handling](./appendices/blocker-handling.md). Keep working on unblocked tests, contracts, mocks, UI states, docs, or adjacent tasks.

## End-To-End User Journey

The final beta should support this path:

```text
1. User opens ReviewRouter dashboard.
2. User signs in with GitHub.
3. User installs the shared ReviewRouter GitHub App on selected repositories.
4. SaaS receives installation webhook and syncs repositories.
5. User selects a repository.
6. User chooses review preset, provider, model, effort, and action version.
7. SaaS creates a setup PR in the repository.
8. User merges setup PR.
9. User seeds provider credentials directly into GitHub Secrets or trusted runner.
10. User opens or updates a pull request.
11. GitHub Actions runs `777genius/review-router@v1`.
12. Action fetches runtime config from SaaS through GitHub Actions OIDC.
13. If SaaS is unavailable, action uses static workflow config.
14. Action runs provider review inside customer CI.
15. Action posts PR summary/comments/status.
16. Action reports safe health metadata to SaaS.
17. Dashboard shows last review health and setup status.
```

## End-To-End Technical Flow

```text
Browser
  -> Next.js dashboard
  -> tRPC dashboard API
  -> Fastify application use cases
  -> Prisma/Postgres
  -> Octokit/GitHub App adapters

GitHub App Webhook
  -> Fastify webhook route
  -> webhook signature verification
  -> normalized internal event
  -> pg-boss job
  -> feature use case with idempotency
  -> Prisma/Postgres

Customer GitHub Actions
  -> ReviewRouter Action
  -> GitHub OIDC token
  -> SaaS OIDC exchange endpoint
  -> short-lived action session
  -> runtime config fetch
  -> static fallback if needed
  -> provider review in customer CI
  -> GitHub PR comments/status
  -> safe health report to SaaS
```

## Repo Target Shape

Create this monorepo during Iteration 01:

```text
review-router/
  apps/
    web/
    api/
    worker/

  packages/
    ui/
    platform/
      config/
      db/
      logger/
      queue/
      locks/
      github/
      crypto/
      telemetry/
    features/
      identity-access/
      github-installations/
      repository-management/
      workflow-provisioning/
      review-configuration/
      provider-setup/
      action-control-plane/
      webhook-ingestion/
      audit-log/
      billing-entitlements/
    shared/
      result/
      errors/
      ids/
      time/
      validation/
```

Do not put all domain logic in `apps/api`. `apps/api` and `apps/worker` are composition roots.

## Iteration 01 - Foundation

Goal: create a working monorepo skeleton with dependency boundaries and one example feature.

Create:

- pnpm workspace
- Turborepo
- shared TypeScript config
- ESLint/import-boundary rules
- Vitest setup
- apps/web Next.js app
- apps/api Fastify app
- apps/worker worker process
- packages/ui with Base UI wrappers
- packages/shared utilities
- packages/platform adapters
- packages/features structure
- Prisma/Postgres local dev
- Docker Compose for Postgres

Frontend foundation:

- Tailwind CSS
- cyberpunk-future tokens from [Visual Direction](./product/08-visual-direction.md)
- Base UI wrapper examples: Button, Card, Dialog, Badge, CodeBlock
- Zustand shell UI store example
- TanStack Query/tRPC provider setup
- nuqs example for URL tab/filter state
- React Hook Form + Zod example form

Backend foundation:

- config/env validation
- logger port and adapter
- result/error utilities
- API error contract
- database connection package
- migration convention
- checked-in Prisma baseline migration
- migration smoke against a temporary fresh database
- basic health route
- example feature that proves domain/application/infrastructure/interface boundaries

Tests:

- typecheck
- lint
- unit test for example domain/application use case
- dependency-boundary smoke test
- API health route test
- UI wrapper render/accessibility smoke test
- Prisma migration applies to empty DB through `pnpm db:migrate:smoke`

Do not implement GitHub OAuth in this iteration beyond config placeholders.

If blocked:

- if Next.js/Fastify integration is slow, still create packages, shared config, and tests
- if Postgres is unavailable, write Prisma schema and domain/application tests with fakes
- if UI styling is blocked, implement tokens and accessible unstyled wrappers first
- if dependency-boundary lint is difficult, add a smoke test/script and document the stricter rule for follow-up

## Iteration 02 - GitHub Identity And App Install

Goal: a user can sign in and the SaaS can track a GitHub App installation.

Feature contexts:

- `identity-access`
- `github-installations`
- `audit-log`

Domain/application:

- User
- Workspace
- WorkspaceMember
- Role policy
- GitHubInstallation
- Installation lifecycle state: active, suspended, removed, permission_error
- Last-owner protection
- OAuth account linking policy
- Installation access policy

Ports:

- AuthProviderPort
- SessionPort
- GitHubOAuthPort
- GitHubAppPort
- AuditLogPort

Adapters:

- Auth.js adapter behind auth ports
- Octokit GitHub OAuth adapter
- Octokit GitHub App adapter
- Prisma repositories
- Fastify webhook route for installation events
- tRPC routes for dashboard identity/install state

UI:

- sign-in page
- workspace shell
- GitHub App install CTA
- installation status card
- permission explanation screen

Tests:

- OAuth callback accepts valid state
- OAuth callback rejects invalid state
- CSRF protected mutations reject missing token
- workspace created on first login
- last owner cannot be removed
- installation webhook signature verified
- duplicate webhook is idempotent
- removed/suspended installation updates state

Do not create setup PRs yet.

If blocked:

- if GitHub OAuth credentials are missing, implement AuthProviderPort and mocked auth adapter tests
- if GitHub App installation is unavailable, implement installation domain/application and webhook fixture tests
- if webhook E2E is blocked, use signed fixture payloads and document the real smoke command

## Iteration 03 - Repository Sync And Workspace Dashboard

Goal: synced repositories appear in the dashboard and can be selected.

Feature contexts:

- `repository-management`
- `github-installations`
- `audit-log`

Domain/application:

- RepositoryConnection
- RepositorySelection
- Repository visibility/default branch metadata
- Repository access policy
- Sync installation repositories use case
- Repository removed/unselected handling

Ports:

- GitHubRepositoryPort
- RepositorySyncLockPort
- RepositoryConnectionRepository
- AuditLogPort

Adapters:

- Octokit list installation repositories
- Prisma repository storage
- pg-boss sync job
- Postgres advisory lock
- tRPC repo list/detail endpoints

UI:

- repository list
- repository details
- setup eligibility badge
- selected repo status
- empty states for no installation/no repos/no permission

Tests:

- sync creates repos
- sync updates metadata
- sync handles removed/unselected repo
- duplicate sync does not duplicate rows
- unauthorized workspace user cannot view repo
- concurrent sync uses lock

Do not generate workflow YAML yet.

If blocked:

- if GitHub installation repo access is unavailable, implement repository sync against mocked Octokit responses
- if worker queue is not ready, implement sync use case and lock port with fakes
- if UI data is unavailable, build dashboard screens from typed view models and fixtures

## Iteration 04 - Workflow Provisioning

Goal: SaaS creates a setup PR that adds ReviewRouter workflow to a selected repository.

Feature context:

- `workflow-provisioning`

Domain/application:

- WorkflowProvisioning aggregate
- Provisioning state: idle, creating_branch, pr_open, merged, failed, superseded
- Action version choice: stable, release, main
- Workflow template version
- Existing setup PR detection
- Permission failure classification

Ports:

- GitHubBranchPort
- GitHubContentsPort
- GitHubPullRequestPort
- WorkflowTemplateRenderer
- WorkflowProvisioningLockPort
- AuditLogPort

Adapters:

- Octokit branch/content/PR adapter using GitHub App installation token
- deterministic YAML renderer
- Prisma provisioning repository
- pg-boss provisioning job
- Postgres advisory lock
- tRPC create setup PR mutation

UI:

- create setup PR button
- setup PR status panel
- permission explanation for `workflows: write`
- generated workflow preview
- stale workflow/update available status

Workflow rules:

- use `pull_request`
- do not use `pull_request_target`
- include fork PR secret guard
- include `id-token: write`
- set `permissions` explicitly
- use `777genius/review-router@v1`
- default model `gpt-5.5`
- default effort `medium`
- default fail severity `critical`

Tests:

- YAML snapshot tests
- no `pull_request_target`
- fork PR guard present
- permissions minimal and explicit
- setup PR created with mocked GitHub API
- duplicate clicks return existing PR
- permission errors persisted and displayed
- generated branch name deterministic

Do not implement OIDC config endpoint yet. Include static config and OIDC placeholders.

If blocked:

- if `workflows: write` is missing, finish renderer snapshots, error classification, and UI permission copy
- if real PR creation is blocked, keep mocked Octokit integration tests and a gated E2E checklist
- if action version resolution is blocked, default to `777genius/review-router@v1` and keep resolver behind a port

## Iteration 05 - Review Config And Provider Setup

Goal: users can configure review behavior and understand provider secret setup.

Feature contexts:

- `review-configuration`
- `provider-setup`

Domain/application:

- ReviewConfiguration
- ProviderConfiguration
- ProviderSetupState
- ConfigVersion
- Config preset policy
- Provider secret health status
- Static vs runtime config precedence

Providers in v1:

- Codex OAuth subscription
- Codex/OpenAI API key
- OpenRouter API key

Default config:

```text
provider: codex subscription OAuth
model: gpt-5.5
effort: medium
agenticContext: true
inlineMaxComments: 5
failOnSeverity: critical
actionVersion: stable
```

Ports:

- ReviewConfigRepository
- ProviderSetupRepository
- SecretSetupInstructionRenderer
- AuditLogPort

Adapters:

- Prisma repositories
- tRPC config routes
- generated shell command renderer for secret seeding
- dashboard command copy UI

UI:

- preset selector
- provider selector
- model/effort selector
- fail severity selector
- Codex OAuth setup page
- org selected-repo secret guidance
- OpenAI/OpenRouter secret guidance
- provider health checklist

Tests:

- config validation
- config version conflict handling
- invalid provider config rejected
- provider setup transitions
- generated secret setup commands are correct
- SaaS never accepts secret plaintext
- UI shows public/fork repo warnings

Do not store provider secrets in SaaS.

If blocked:

- if real Codex OAuth is unavailable, use fixture validation for `auth.json` shape only
- if GitHub secret seeding cannot be run, implement command renderer and docs
- if model/provider options are uncertain, keep provider descriptors extensible and default to Codex OAuth

## Iteration 06 - Action Control Plane Protocol

Goal: the ReviewRouter Action can fetch current config and report safe health metadata through OIDC.

Feature context:

- `action-control-plane`

Domain/application:

- ActionSession
- OidcExchangePolicy
- RuntimeConfigPolicy
- HealthReportPolicy
- ActionProtocolVersion
- Replay protection model

Ports:

- OidcJwtVerifier
- ActionSessionTokenPort
- RuntimeConfigRepository
- HealthReportRepository
- RepositoryAuthorizationPort

Adapters:

- GitHub OIDC JWKS verifier
- JWT/session token signer
- Fastify OIDC exchange route
- Fastify config fetch route
- Fastify health report route
- Prisma action session/health storage

Rules:

- validate issuer
- validate audience
- validate repository claims
- validate repository owner/id
- validate workflow ref/sha where possible
- fail closed on invalid token
- cache JWKS safely
- allow small clock skew
- short action-session TTL
- report payload has strict schema and size limits
- reject secret-looking/code-looking/diff-looking payloads

Tests:

- valid token accepted
- wrong audience rejected
- expired token rejected
- wrong repo rejected
- unselected repo rejected
- replay-sensitive fields handled
- health report rejects oversize payload
- health report rejects code/diff/secret-looking data
- static config fallback documented and tested at workflow-renderer level

Do not create a long-lived SaaS token in customer repos.

If blocked:

- if real GitHub Actions OIDC is unavailable, use recorded/sample claims and mocked JWKS
- if public endpoint tunneling is unavailable, test Fastify handlers directly
- if action runtime cannot call SaaS yet, finish schema validation and static fallback tests

## Iteration 07 - Webhooks, Jobs, Locks, And Outbox

Goal: backend is safe under GitHub retries and multiple worker instances.

Feature contexts:

- `webhook-ingestion`
- `audit-log`
- cross-feature job consumers

Domain/application:

- WebhookDelivery
- NormalizedEvent
- OutboxEvent
- PoisonJob
- IdempotencyKey

Ports:

- WebhookSignatureVerifier
- WebhookDeliveryRepository
- EventNormalizer
- QueuePort
- DistributedLockPort
- OutboxRepository

Adapters:

- Fastify webhook routes
- GitHub signature verifier
- pg-boss queue
- Postgres advisory locks
- Prisma delivery/outbox repositories

Rules:

- verify signature before parsing trust
- store delivery metadata, not raw payload by default
- normalize to safe internal events
- every job idempotent
- every external side effect has idempotency key
- unknown event versions dead-letter
- poison jobs have actionable summaries

Tests:

- duplicate webhook returns success without duplicate side effects
- invalid signature rejected
- normalized event excludes PR/comment bodies unless explicitly allowed
- concurrent provisioning cannot create duplicate PRs
- outbox retries safely
- poison event dead-letters safely

If blocked:

- if real webhooks are unavailable, use fixture payloads and signature tests
- if multi-worker runtime is hard locally, test lock contention with parallel promises/processes
- if pg-boss setup is unavailable, implement QueuePort fakes and repository tests first

## Iteration 08 - Health, Audit, And Beta Hardening

Goal: beta users can understand what is installed, broken, or unsafe.

Feature contexts:

- `audit-log`
- health/status inside setup/repo features
- support/admin access

Domain/application:

- AuditEvent
- RepoHealthCheck
- WorkflowHealth
- ProviderHealth
- SupportAccessPolicy
- KillSwitchPolicy
- QuotaPolicy

UI:

- repo health page
- last review status
- workflow version mismatch warning
- missing secret warning
- stale Codex auth reseed guidance
- public/fork PR security warning
- audit log table
- support debug metadata view
- incident/banner area

Tests:

- audit emitted for install/config/provisioning
- health detects missing workflow
- health detects stale workflow version
- provider setup status rendered clearly
- support view never shows secrets/code/diff
- kill switch disables provisioning safely

If blocked:

- if real action health reports are not available, build health UI with fixture reports
- if support policy is not final, implement metadata-only debug view with strict redaction
- if quotas are not final, implement configurable policy defaults and disabled future feature errors

## Iteration 09 - Free Entitlements And Future Billing Boundary

Goal: add plan boundaries without collecting payment.

Feature context:

- `billing-entitlements`

Domain/application:

- Entitlement
- Plan
- WorkspaceUsage
- EntitlementPolicy
- FeatureFlag

Rules:

- no payment collection in v1
- all future paid checks go through application policy services
- do not scatter plan checks in React components
- free beta limits are configurable

UI:

- beta/free label
- usage summary
- disabled future feature messages

Tests:

- free plan allows MVP features
- disabled future feature returns actionable error
- entitlement events audited

If blocked:

- if pricing/free limits are not final, keep limits configurable and conservative
- if billing provider is undecided, do not integrate payment APIs
- if UI copy is not final, use beta/free labels and keep copy centralized

## Vertical Smoke Path

After Iteration 06, this path should work in staging:

```text
1. Create fresh test org/repo.
2. Sign in to dashboard.
3. Install ReviewRouter GitHub App on selected repo.
4. Sync repo.
5. Create setup PR.
6. Merge setup PR.
7. Seed Codex OAuth secret through local command.
8. Open test PR with intentional bug.
9. GitHub Actions runs ReviewRouter Action.
10. Action fetches config through OIDC.
11. Action posts review comments/status.
12. Dashboard shows health metadata.
```

This is the main confidence test before public beta hardening.

## Autonomy Rules For Agents

Make reasonable implementation decisions inside accepted architecture.

Do not ask the user about:

- whether to use TypeScript
- whether to use Prisma
- whether to use Base UI
- whether to use Zustand
- whether to store Codex OAuth in SaaS
- whether to use cloud execution in v1
- whether to use `pull_request_target`

Ask only when:

- a real external secret/account action is required
- GitHub org ownership blocks a real E2E test
- a decision is listed in `appendices/open-questions.md` and blocks the current implementation
- implementing the request would violate a non-negotiable boundary

When asking, do not stop all work. State the blocker and continue with the best unblocked task from [Blocker Handling](./appendices/blocker-handling.md).

## Common Mistakes To Avoid

- Putting all code in route handlers.
- Storing server state in Zustand.
- Importing Base UI directly from feature components.
- Letting Prisma types leak into domain/application.
- Using GitHub App tokens inside provider subprocesses.
- Adding cloud review execution because it looks simpler.
- Storing raw GitHub webhook payloads by default.
- Logging OIDC tokens, GitHub tokens, secrets, prompts, diffs, or model output.
- Creating setup PRs without a repository-scoped lock.
- Treating fork PRs as safe for secret-backed review.
- Introducing billing before the free beta boundary is implemented.

## Final Public Beta Gate

The app is beta-ready only when:

- fresh org/repo onboarding works
- setup PR is correct and mergeable
- workflow runs in customer CI
- provider setup guidance is clear
- Codex OAuth stays outside SaaS
- OIDC runtime config works or static fallback works
- duplicate webhooks/jobs are idempotent
- workflow provisioning is concurrency-safe
- fork PR safety is enforced
- user-facing errors are actionable
- audit log covers important actions
- telemetry excludes code/diffs/secrets/prompts
- support debug view is metadata-only
- docs explain uninstall and permissions
