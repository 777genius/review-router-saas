# ReviewRouter Beta Runbook

This is the consolidated runbook for finishing, validating, and demoing the
local/private beta. Use it when an agent needs one practical document instead
of jumping between architecture, product, operations, and iteration files.

## Current Beta Position

ReviewRouter is currently a local/private beta control plane with real GitHub
Action review execution.

What is proven:

- GitHub App installation discovery works.
- Repository sync into Postgres works.
- Dashboard can show workspaces, installations, repositories, health, review config, provider setup, audit, and operational queue metadata.
- SaaS can create a workflow setup PR through the GitHub App.
- Setup PR can be merged on a fresh repository.
- Generated workflow runs review inside the customer repository GitHub Actions.
- Codex OAuth is seeded directly into GitHub Actions secrets, not into SaaS.
- ReviewRouter Action can post PR summary, inline findings, and blocking check results.
- Real GitHub full-review smoke has passed on disposable public repositories.
- Action runtime can attempt OIDC config fetch and can fall back to static workflow config.
- Action runtime can send metadata-only health reports when it has a control-plane session.

Main unproven public-beta path:

```text
GitHub-hosted runner -> public HTTPS ReviewRouter API -> OIDC exchange -> config fetch -> health report -> dashboard health
```

This requires hosted HTTPS staging/prod. It cannot be fully proven from a local
`http://localhost:4000` API.

## Definition Of Done - Local/Private Beta

Local/private beta is done when all items below are true.

### Product DoD

- Dashboard explains the product honestly: SaaS control plane, review execution in customer CI.
- Dashboard shows a clear path: install App, sync repo, create setup PR, seed provider, open first PR.
- Provider setup guidance gives copyable commands for repository secrets and organization selected-repo secrets.
- Codex OAuth copy clearly says `CODEX_AUTH_JSON` is stored in GitHub Actions secrets, not in ReviewRouter SaaS.
- Public repo/fork PR warning is visible before users rely on secret-backed review.
- Failure summaries tell users how to reseed Codex OAuth or fix API-key/provider setup.
- Status/support/security/privacy/disconnect pages exist and do not overclaim production readiness.

### Technical DoD

- `pnpm beta:check` passes.
- `REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check` passes after schema or worker changes.
- `REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check` passes after action/workflow/provider changes.
- `pnpm runtime:smoke` passes after build/package/export/server changes.
- Automated web smoke covers `/`, `/dashboard`, `/getting-started`, `/security`, `/fair-use`, `/disconnect`, `/privacy`, `/terms`, `/status`, and `/support`.
- Action runtime full test suite passes after touching `777genius/review-router`.
- Generated workflow snapshot tests cover security-sensitive defaults.
- No workflow uses `pull_request_target` for default review execution.
- No SaaS route stores code, diffs, prompts, model responses, raw provider output, raw webhook payloads, or provider secrets.
- Health reports are schema-limited, size-limited, and rejected if they look like code/diff/secret payloads.
- Tenant/workspace/repository authorization is tested for dashboard mutations and action-control-plane routes.
- Workflow provisioning is idempotent and protected by a distributed lock.
- Outbox retries and dead-letter handling are tested.

### Demo DoD

- A fresh disposable repo can be created and configured by the beta script.
- Setup PR is visible and mergeable.
- Workflow exists on the default branch after merge.
- A test PR with an intentional bug gets a ReviewRouter run.
- ReviewRouter posts at least one useful inline finding on a changed line.
- Blocking policy is understandable: critical findings fail by default, major does not unless configured.
- The demo can explain that OIDC/health-report full hosted path awaits public HTTPS staging.

## First Tester Demo Checklist

Use this when showing ReviewRouter to a trusted tester.

### 1. Explain The Trust Boundary

Say this clearly:

```text
ReviewRouter SaaS manages setup, config, health, and audit.
Your GitHub Actions runner runs the actual review.
ReviewRouter SaaS does not store repo code, PR diffs, prompts, model output, Codex auth.json, or provider API keys in v1.
```

### 2. Show The Install Path

Show these screens:

- `/` for positioning.
- `/getting-started` for setup sequence and copyable secret commands.
- `/security` for GitHub App permissions and secret custody.
- `/dashboard` for workspace/repo/config/health.
- `/support` for safe support report expectations.
- `/disconnect` for uninstall and secret cleanup.

### 3. Show A Real GitHub Smoke

Run:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

Show:

- disposable repository URL
- setup PR URL
- review PR URL
- GitHub Actions run URL
- inline finding URL or changed-file comment

### 4. Show Provider Setup

For one repository:

```bash
curl -fsSL https://app.reviewrouter.dev/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash
```

For organization selected repositories:

```bash
curl -fsSL https://app.reviewrouter.dev/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=acme REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b bash
```

Explain:

- ordinary repo collaborators cannot read GitHub Actions secret values back from GitHub
- org selected-repo secrets are preferred for team-owned repos
- fork PRs are skipped by default for secret-backed review

### 5. Show Config Control

Show that workspace and repository config can set:

- provider auth mode
- model
- reasoning effort
- agentic context
- fail-on severity
- inline max comments
- token budget per batch

Explain current local limitation:

```text
Local beta-generated workflows include a static config snapshot.
Hosted SaaS will let the action fetch updated config through OIDC.
```

## Validation Commands

### SaaS Local Gate

First-time local bootstrap:

```bash
pnpm local:bootstrap
```

It is safe to rerun and does not create GitHub Apps or provider credentials.

```bash
pnpm beta:check
```

Use after normal code/docs/UI changes.

### SaaS DB Gate

```bash
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
```

Use after Prisma, repositories, jobs, locks, outbox, webhooks, action-control-plane, or health logic changes.

### Real GitHub Setup E2E

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
```

Use after workflow provisioning or GitHub App setup changes.

### Real GitHub Review E2E

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

Use after action runtime, generated workflow, provider setup, review config, or review output behavior changes.

### GitHub App Credential Smoke

```bash
pnpm github-app:check
```

Use after changing local/staging GitHub App credentials. It authenticates with
the App private key, compares `GITHUB_APP_ID` and `GITHUB_APP_SLUG` with the
actual App, and lists installations without printing secrets.

To prove the App can read one repository:

```bash
REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO=owner/repo pnpm github-app:check
```

For hosted readiness, make lifecycle webhook event subscriptions a hard
requirement:

```bash
REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted pnpm github-app:check
```

Hosted mode requires these App webhook events:

```text
installation
installation_repositories
```

### Action Runtime Gate

Run in `/Users/belief/dev/projects/review-router-action`:

```bash
npm test -- --runInBand
npm run typecheck
npm run build
```

Use after touching `src/`, `scripts/`, action `dist/`, or action tests.

### Browser Smoke

Automated smoke after a production build:

```bash
pnpm build
pnpm web:smoke
```

It checks these pages:

```text
/
/dashboard
/getting-started
/security
/fair-use
/disconnect
/privacy
/terms
/status
/support
```

Expected:

- no 404/500/runtime error text
- main h1/content visible
- key beta/security/support pages include their expected text

Use the in-app browser for visual QA after larger frontend changes.

### Compiled Runtime Smoke

After package exports, build output, API boot, worker boot, or deploy script
changes, run:

```bash
pnpm build
pnpm runtime:smoke
```

Expected:

- compiled Fastify API starts through `pnpm api:start`
- `/health` returns `status: ok`
- compiled worker starts through `pnpm worker:start`
- worker can process one outbox batch and exit with `REVIEW_ROUTER_WORKER_ONCE=1`

The start scripts intentionally use `node --conditions=production` so workspace
package exports resolve to `dist/*.js` instead of source `.ts` files.

### Hosted Env Readiness

Before hosted staging/prod deploy, run:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm hosted:check
```

The gate checks production-only assumptions: public HTTPS web/API URLs,
`REVIEW_ROUTER_PUBLIC_API_URL`, GitHub App credentials, private key custody,
dashboard/provisioning enablement, and absence of provider secrets in SaaS env.

The smoke test for the gate itself runs in `pnpm beta:check`:

```bash
pnpm hosted:check:smoke
```

## What To Work On Next Without User Input

If there is no hosted HTTPS environment yet, keep improving local/private beta.

Priority order:

1. Fix correctness/security bugs found by tests or real GitHub smoke.
2. Improve onboarding clarity where a first tester could get stuck.
3. Improve health/readiness status wording in dashboard.
4. Add tests for any untested behavior in iterations 08-11.
5. Update docs/runbooks when behavior changes.
6. Keep deploy templates and env examples accurate, but do not pretend hosted E2E is done.

Do not wait for the user if a hosted dependency blocks only one path. Switch to
the highest-value unblocked item and record the limitation.

## Public Beta Blockers

These must be closed before broad public beta:

- public HTTPS web/API/worker deployment using the deploy handoff in `deploy/README.md`
- hosted env passing `pnpm hosted:check`
- production/staging GitHub App callback URL, setup URL, and webhook URL
- hosted Postgres and backup/restore drill
- true GitHub-hosted OIDC/config/health-report E2E
- production secret management for GitHub App client secret, OAuth secret, Auth.js secret, webhook secret, and DB URL
- GitHub App private key supplied by either hosted env secret `GITHUB_APP_PRIVATE_KEY` or local file `GITHUB_APP_PRIVATE_KEY_FILE`
- production status/support channel
- reviewed legal/privacy/terms copy

## Launch Blockers

Do not show as public beta if any of these are true:

- generated workflow uses `pull_request_target` for default review execution
- SaaS stores Codex OAuth, API keys, repo code, PR diffs, prompts, model responses, or raw provider output
- invalid webhook signatures are accepted
- OIDC tokens can be replayed or accepted for the wrong repository
- setup PRs can be duplicated by repeated clicks or write races
- tenant isolation bug lets one workspace see or mutate another workspace
- health reports can store code/diffs/secrets
- action failure hides actionable setup errors from the PR author/maintainer

## How To Report Status

Use these status labels:

```text
Local/private beta: ready when all local, DB, browser, action, and real GitHub fallback checks pass.
Public beta prepared: ready when deploy templates/docs exist but hosted HTTPS E2E is still missing.
Public beta ready: ready only after hosted OIDC/config/health-report E2E passes.
Production ready: requires public beta feedback, billing/support/legal/observability hardening, and release compatibility process.
```

Current recommended status wording:

```text
ReviewRouter is ready for trusted local/private beta. Public beta is blocked on hosted HTTPS staging and full GitHub-hosted OIDC/config/health-report E2E.
```
