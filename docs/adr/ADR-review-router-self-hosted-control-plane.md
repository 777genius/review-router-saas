# ADR: ReviewRouter Self-Hosted Control Plane

Status: accepted

Date: 2026-07-27

## Context

ReviewRouter already separates pull request review execution from the hosted
control plane. The GitHub Action checks out PR code, builds review context, runs
providers, records context attestation, and submits review artifacts. The hosted
control plane owns metadata, release gates, leases, revision-aware reuse,
publication lifecycle, webhook ingestion, and durable review-request dispatch.

Some customers need stronger privacy and operational control. They should be
able to run the control plane themselves while keeping the same GitHub Action
runtime and the same domain/application rules.

Official platform constraints that shape this decision:

- GitHub Apps should request the minimum permissions required for the endpoints
  and webhook events they use: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Creating or updating Checks API check runs requires GitHub App Checks write
  permission: https://docs.github.com/en/rest/checks/runs
- OIDC runtime config requires GitHub Actions `id-token: write` in the caller
  workflow and validates the workflow/run identity through the control plane:
  https://docs.github.com/en/actions/reference/security/oidc
- `pull_request_target` receives elevated trust and must not check out
  untrusted PR code with secrets: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
- Workflow dispatch, cancel, rerun, and private workflow run inspection require
  Actions permissions according to the endpoint used:
  https://docs.github.com/en/rest/actions/workflow-runs
- Docker Compose supports dependency conditions such as `service_healthy` and
  `service_completed_successfully`, which lets the API/worker wait for
  Postgres and migrations:
  https://docs.docker.com/compose/how-tos/startup-order/
- Docker Compose `env_file` paths are relative to the Compose file, and `.env`
  files provide interpolation/defaults for Compose:
  https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/
- Prisma recommends `prisma migrate deploy` for applying pending migrations in
  staging/production:
  https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate

## Decision

Make self-hosted control plane a first-class deployment target, but keep review
execution in the customer's GitHub Action runner.

The implementation reuses the existing feature-sliced DDD packages instead of
creating a second parallel domain tree. The logical layers from the self-hosted
plan map to the current packages like this:

| Goal layer                           | Current implementation                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `packages/review-router-domain`      | `packages/features/*/src/domain`                                   |
| `packages/review-router-application` | `packages/features/*/src/application`                              |
| `packages/review-router-ports`       | `packages/features/*/src/application/ports`                        |
| `packages/review-router-adapters`    | `packages/features/*/src/infrastructure` and app-specific adapters |
| `apps/review-router-saas`            | `apps/web`, `apps/api`, `apps/worker` on hosted infra              |
| `apps/review-router-self-hosted`     | `deploy/self-hosted` composition of the same app services          |
| `review-router-action`               | public GitHub Action runtime on customer runner                    |

This avoids duplicated domain concepts while preserving Clean Architecture:
domain and application packages own rules and ports; GitHub, Prisma, HTTP,
Docker, Render, and workflow generation stay in adapters or composition roots.

## Bounded Contexts

- Review Coordination: requested intents, dispatch, leases, retries,
  cancellation, stale revision handling.
- Evidence Ledger: provider invocation identity, observations, attestation,
  reusable evidence decisions.
- Finding Lifecycle: active/resolved/stale/suppressed state and stable finding
  identity.
- Publishing: PR reviews, summary comments, check runs, lifecycle reconciliation.
- Installation/Auth: GitHub App installation tokens, webhooks, OIDC, capability
  tokens.
- Privacy/Retention: payload classification, redaction, retention and deletion.
- Runtime Policy: batch sizing, model/provider selection, changed-line limits.

## Permission Profiles

Self-hosted operators choose one GitHub App permission profile:

| Profile          | Purpose                                                                                                                           | Permissions                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `review-only`    | Customer-managed workflows that run directly on PR events. No server-side dispatch or setup PRs.                                  | Actions read, Checks write, Contents read, Issues write, Pull requests write, Commit statuses write, Metadata read      |
| `managed-review` | Durable server-side `workflow_dispatch` review requests and cancellation, but workflows/secrets are managed outside ReviewRouter. | `review-only` plus Actions write                                                                                        |
| `provisioning`   | Dashboard setup PRs, workflow updates, and GitHub Actions secret provisioning.                                                    | `managed-review` plus Contents write, Workflows write, Secrets write, Organization secrets read, Organization plan read |
| `org-ruleset`    | Provisioning plus org required workflow/ruleset management.                                                                       | `provisioning` plus Organization administration write                                                                   |

`standard` remains an alias for `provisioning` for backward compatibility.

The default self-hosted env example uses `managed-review`. Operators who want
ReviewRouter to create setup PRs or write repo secrets must explicitly switch
to `provisioning`.

## Privacy Invariants

- The hosted SaaS/control plane must not receive PR source files by default.
- Runner-side review execution may read the checked out repository because it
  runs in the customer's workflow trust boundary.
- Control-plane payloads may contain repository identity, PR number, revision
  SHAs, review revision hash, fingerprints, batch states, findings, summaries,
  attestation digests, and audit events.
- Control-plane payloads must not contain provider tokens, raw OAuth files,
  GitHub installation tokens, raw source files, full prompts, or unredacted
  provider stderr/stdout.
- Reusable evidence must be accepted only when attestation proves the new
  revision is compatible with the recorded context.

## Consequences

Positive:

- Hosted and self-hosted deployments share the same domain/application code.
- Customers can choose least-privilege GitHub App permissions.
- The action can point at a customer control plane with `control_plane_url`
  while keeping `api_url` as a backward-compatible alias.
- Big PR review reuse remains a server-side coordination concern without moving
  code review execution into the server.

Tradeoffs:

- Self-hosted operators need to run Postgres, API, worker, web, migrations, and
  HTTPS.
- Managed durable dispatch requires Actions write permission.
- Review-only mode cannot provide server-side `workflow_dispatch` or cancellation
  unless the operator upgrades to `managed-review`.
- Provisioning mode needs broad permissions because GitHub requires Workflows
  write for `.github/workflows` edits and Secrets write for repository secrets.

## Implementation Gates

- GitHub permissions/auth: permission profiles are shared by the manifest helper
  and readiness checker.
- GitHub Actions event model: documented in
  `docs/operations/review-router-self-hosted-workflow-contract.md`.
- Revision-aware reuse: covered by the Review Coordination and Evidence Ledger
  packages and test matrix.
- Storage: self-hosted starts with Postgres through the existing Prisma
  adapters. SQLite remains a future single-node adapter only if implemented
  behind the existing repository ports.
- Deployment: `deploy/self-hosted` owns Docker/Compose/env validation, and the
  migration container must complete before app services start.
- Privacy: payload classes and retention are documented in
  `docs/privacy-self-hosted.md`.
- E2E: required scenarios are listed in
  `docs/operations/review-router-self-hosted-test-matrix.md`.
