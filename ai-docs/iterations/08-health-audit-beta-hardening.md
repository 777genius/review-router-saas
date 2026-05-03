# Iteration 08 - Health, Audit, and Beta Hardening

## Goal

Make the product understandable and supportable for beta users.

## Scope

- audit log feature
- repo health checks
- workflow presence/version checks
- provider setup health display
- error pages/messages
- internal support debug view
- support access audit
- incident response kill switches
- free beta abuse/quotas guardrails
- onboarding permission explanations
- security warnings for public repos/fork PRs

## Tests

- audit events emitted for install/config/provisioning
- health check detects missing workflow
- health check detects version mismatch
- no secrets logged in error paths

## Done When

- user can understand what is installed, what is missing, and what to do next
- support can debug without reading code or secrets
- support/admin access is audited

## Implemented Baseline

- Repository health evaluates setup status, workflow presence, expected action ref, provider setup state, and latest provider runtime health.
- Repository health marks old action health reports as stale so a repository does not stay `Ready` forever after the workflow stops reporting.
- API `/health` accepts dependency checks and marks the service degraded when the database adapter cannot run a safe `SELECT 1` probe.
- Action control-plane has DB-backed fixed-window rate limits for OIDC exchanges and action health reports, returning safe `rate_limited` errors.
- Action control-plane has DB-backed OIDC `jti` replay protection in production API composition; duplicate tokens are returned as safe auth failures before issuing a session.
- Dashboard mutations have DB-backed fixed-window rate limits for manual syncs, setup PRs, config saves, and outbox retries.
- Expired rate-limit buckets are pruned by the worker in bounded periodic batches after outbox processing, and cleanup failures are logged without blocking critical jobs.
- Expired OIDC replay nonces are pruned by the worker in bounded periodic batches after outbox processing, and cleanup failures are logged without blocking critical jobs.
- Dashboard probes installed workflow files through a `RepositoryWorkflowProbePort` and `OctokitRepositoryWorkflowProbe`.
- The workflow probe reads only `.github/workflows/reviewrouter.yml` metadata through the GitHub App installation token and returns safe states only:
  - `missing`
  - `present + expectedActionRefFound`
  - `unavailable + safe reason`
- The probe does not store or return raw workflow YAML.
- Dashboard caps live workflow probes to a small repository batch to avoid slow page loads and GitHub API pressure.
- Real smoke command:

```bash
REVIEW_ROUTER_TARGET_REPO=777genius/review-router-saas-e2e \
  node scripts/run-with-env.mjs pnpm spike:repo-health:e2e
```

Expected for the current smoke repo main branch: `check.status = "missing"`.
