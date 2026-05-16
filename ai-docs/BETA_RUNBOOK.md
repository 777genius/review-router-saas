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
- Dashboard repository health shows latest action-run metadata counts without storing code, diffs, prompts, model output, or secrets.
- Support diagnostics aggregates safe action-run counts for support triage without storing code, diffs, prompts, model output, or secrets.
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
curl -fsSL https://app.reviewrouter.dev/install/codex | bash -s -- --confirm-write --scope repo --repo owner/repo
```

For organization selected repositories:

```bash
curl -fsSL https://app.reviewrouter.dev/install/codex | bash -s -- --confirm-write --scope org --org acme --visibility selected --repos repo-a,repo-b
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
This gate also verifies support diagnostics can read safe action-run metadata
aggregates and audit the access without touching code, diffs, prompts, model
output, or secrets.

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

### Real GitHub Memory E2E

```bash
REVIEW_ROUTER_GITHUB_MEMORY_E2E=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_E2E_PREFLIGHT_ONLY=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_E2E_PR=4 \
  pnpm spike:github-memory:e2e
```

Use after Balanced Memory, interaction workflow, action runtime discussion, or
memory endpoint changes. The preflight must pass before enabling side effects.
It verifies the disposable repo default branch has
`.github/workflows/reviewrouter-interaction.yml`, the workflow ignores bot
comments, issue comments are enabled, and the referenced runtime exposes memory
candidate/command endpoints.

For the full side-effect smoke, remove
`REVIEW_ROUTER_GITHUB_MEMORY_E2E_PREFLIGHT_ONLY=1` only after:

- the SaaS memory API is deployed and `/api/action/v1/memory*` is available on the public API URL;
- the disposable repo `777genius/review-router-saas-e2e` default branch has the interaction workflow;
- the workflow references a pushed memory-capable action runtime ref;
- no secrets or raw Codex auth are printed into logs or docs.

### GitHub App Credential Smoke

Create a production or staging GitHub App with the manifest helper:

```bash
pnpm github-app:create --name ReviewRouter
```

For an organization-owned App:

```bash
pnpm github-app:create --name ReviewRouter --owner your-org
```

The helper opens GitHub, submits the ReviewRouter manifest, receives the
temporary manifest code on a localhost callback, converts it through GitHub's
manifest conversion API, then saves a local `.env` profile and `.pem` private
key under `.local-secrets/github-apps/`. It does not print generated secrets.
After conversion it prints the App install URL, settings URL, and optional logo
URL. The logo is a manual GitHub settings step:

```text
Logo URL: https://i.imgur.com/Yz9XIQM.png
```

Apply the generated profile to local development env without printing secrets:

```bash
pnpm github-app:use-profile --profile .local-secrets/github-apps/review-router-ai.env
```

This updates only GitHub App/OAuth keys in `.env.local` by default and keeps
local `http://localhost` URLs. Add `--include-urls` only when intentionally
applying the profile's hosted URLs to the target env file.

Default hosted URLs:

```text
Callback URL: https://reviewrouter.site/api/auth/callback/github
Setup URL: https://reviewrouter.site/setup
Webhook URL: https://api.reviewrouter.site/webhooks/github
```

The generated manifest keeps `request_oauth_on_install=false`. Do not enable
"Request user authorization (OAuth) during installation" for the beta App unless
a custom GitHub App OAuth callback is implemented. GitHub redirects that flow to
the user authorization callback instead of the setup URL, while ReviewRouter's
beta flow intentionally uses:

```text
Install App -> Setup URL /setup -> Sign in with GitHub if needed
```

```bash
pnpm github-app:check
```

Use after changing local/staging GitHub App credentials. It authenticates with
the App private key, compares `GITHUB_APP_ID` and `GITHUB_APP_SLUG` with the
actual App, prints the App install/settings URLs, and lists installations
without printing secrets. If no installation exists yet, use the printed install
URL and select only the test repositories needed for E2E.

The manifest helper intentionally does not set `default_events` for
`installation` or `installation_repositories`. GitHub delivers both lifecycle
events to all GitHub Apps by default and does not allow manual subscription to
them in an App manifest.

To prove the App can read one repository:

```bash
REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO=owner/repo pnpm github-app:check
```

For hosted readiness, run the check in hosted mode:

```bash
REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted pnpm github-app:check
```

Hosted mode validates credentials, permissions, and installation visibility.
After installing the App, verify lifecycle delivery in the GitHub App
`Advanced` webhook delivery log if repository sync does not update.

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

After each hosted web deploy, run the live web smoke:

```bash
pnpm hosted:web:check
```

This checks `/dashboard` on the public web URL, verifies that Next CSS assets
load, confirms the GitHub App install CTA points at the configured App slug, and
exercises the GitHub post-install redirect notice. It exists because a page can
return HTTP 200 while still degrading to an unstyled text-only shell.

Before calling the app public-beta ready, run the full public-beta doctor:

```bash
REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm public-beta:check
```

This combines hosted env validation, hosted GitHub App credential and
permission validation, live hosted web smoke, production build, and compiled
runtime smoke. It is expected to fail until public HTTPS env values and hosted
GitHub App credentials are configured.

The public-beta doctor intentionally uses the same
`REVIEW_ROUTER_HOSTED_ENV_FILE` for both hosted env validation and GitHub App
hosted readiness. It also sets
`REVIEW_ROUTER_GITHUB_APP_REQUIRE_INSTALLATION=1`, so the doctor fails until
the hosted GitHub App is installed on at least one selected test repository.
This prevents accidentally calling the SaaS public-beta ready before the
install/setup path can be validated. The shared env file prevents accidentally
validating `.env.production` for the app runtime while checking a local
`.env.local` GitHub App.

The smoke test for this wiring runs in `pnpm beta:check`:

```bash
pnpm public-beta:check:smoke
```

`pnpm beta:check` also runs `pnpm github-app:manifest:smoke` to guard the
manifest helper. This catches unsafe regressions such as enabling OAuth during
installation, adding unsupported lifecycle `default_events`, or dropping setup
permissions.

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
