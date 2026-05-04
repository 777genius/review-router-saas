# Beta Readiness Checklist

## Current Private MVP Status

Status: private/local beta is functionally validated for the intended v1 model:
SaaS control plane plus review execution inside customer GitHub Actions.

For the consolidated definition of done, first tester demo checklist, validation
commands, and launch blockers, use [Beta Runbook](../BETA_RUNBOOK.md).

Validated on real GitHub repositories:

- fresh repository creation under the authenticated owner
- GitHub App installation discovery
- repository sync into local Postgres
- setup PR creation through the GitHub App
- setup PR merge into default branch
- workflow health probe after merge
- Codex OAuth seeding directly into repository Actions secrets
- real pull request with intentional auth bypass
- real GitHub Actions ReviewRouter run
- intentional failed check on critical finding
- inline review comment on the changed line

The current MVP is showable to trusted testers when the latest full-review
smoke passes after the latest action/runtime provisioning change.

Latest full-review validation:

```text
Date: 2026-05-04 11:07 EEST
Command: REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
Repo: 777genius/rr-saas-fresh-e2e-1777881944408
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777881944408/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777881944408/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777881944408/actions/runs/25308054479
Result: setup PR merged, workflow detected on main, disposable repo CODEX_AUTH_JSON was seeded from the current local Codex account with explicit confirmation, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Email is ignored during login lookup".
Note: this validation also confirms the fresh-repository E2E assertion no longer depends on one brittle file/line oracle; it requires a ReviewRouter inline marker, critical severity, prompt-for-agents section, and auth-bypass semantics on the changed fixture lines.
```

Previous full-review validation:

```text
Date: 2026-05-04 10:47 EEST
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777880754438
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777880754438/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777880754438/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777880754438/actions/runs/25307252407
Result: setup PR merged, workflow detected on main, disposable repo CODEX_AUTH_JSON was seeded from the current local Codex account with explicit confirmation, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Authentication bypass".
Note: this validation includes the generated workflow Codex OAuth preflight with stale `last_refresh` warning support. The current local auth did not trigger the stale warning at the default 30-day threshold.
```

Previous full-review validation:

```text
Date: 2026-05-04 10:34 EEST
Command: REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
Repo: 777genius/rr-saas-fresh-e2e-1777879956635
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777879956635/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777879956635/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777879956635/actions/runs/25306759643
Result: setup PR merged, workflow detected on main, disposable repo CODEX_AUTH_JSON was seeded from the current local Codex account with explicit confirmation, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Email lookup ignores the supplied email".
Note: this validation confirms the fresh repository E2E harness passes REVIEW_ROUTER_CONFIRM_WRITE=1 only for the disposable target repo after seed script write-confirmation hardening.
```

Previous full-review validation:

```text
Date: 2026-05-04 09:43 EEST
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777876904596
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777876904596/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777876904596/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777876904596/actions/runs/25304911170
Result: setup PR merged, workflow detected on main, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Authentication bypass from unscoped user lookup".
Note: this validation includes the generated workflow Codex OAuth preflight check for `auth_mode=chatgpt` and `tokens.refresh_token` before writing `CODEX_HOME/auth.json`.
```

Previous full-review validation:

```text
Date: 2026-05-04 09:28 EEST
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777876068729
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777876068729/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777876068729/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777876068729/actions/runs/25304464905
Result: setup PR merged, workflow detected on main, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Login check ignores the supplied email".
Note: action health-report POST is implemented and unit-tested, but true GitHub-hosted OIDC/health-report E2E requires a public HTTPS ReviewRouter API instead of local http://localhost:4000.
```

Previous full-review validation:

```text
Date: 2026-05-04 08:58 EEST
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777874235486
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777874235486/actions/runs/25303510196
Result: setup PR merged, workflow detected on main, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Authentication ignores the supplied email".
Note: action health-report POST is implemented and unit-tested, but true GitHub-hosted OIDC/health-report E2E requires a public HTTPS ReviewRouter API instead of local http://localhost:4000.
```

Previous full-review validation:

```text
Date: 2026-05-04
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777852871545
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777852871545/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777852871545/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777852871545/actions/runs/25294602854
Result: setup PR merged, workflow detected on main, latest `777genius/review-router@main` action bundle ran from static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5.
Note: action health-report POST is implemented and unit-tested, but true GitHub-hosted OIDC/health-report E2E requires a public HTTPS ReviewRouter API instead of local http://localhost:4000.
```

Previous full-review validation:

```text
Date: 2026-05-04
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777852435110
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777852435110/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777852435110/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777852435110/actions/runs/25294449535
Result: setup PR merged, workflow detected on main, new `777genius/review-router@main` action runtime ran from the generated static fallback config, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5.
```

Latest full-review validation:

```text
Date: 2026-05-04 11:27 EEST
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777883214101
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777883214101/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777883214101/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777883214101/actions/runs/25308892488
Result: setup PR merged, workflow detected on main, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5 with title "Login ignores requested email".
```

Latest local beta gate:

```text
Date: 2026-05-04 11:14 EEST
Command: pnpm beta:check
Result: passed.
Coverage: local readiness, 171 unit/integration tests, architecture boundary check, typecheck, lint, format, production build, compiled API/worker runtime smoke, automated 10-page web smoke with installer command assertions and installer redirect check, whitespace, shell syntax, hosted readiness smoke, public beta readiness smoke.
```

Latest GitHub App credential smoke:

```text
Date: 2026-05-04 10:55 EEST
Command: REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO=777genius/rr-saas-fresh-e2e-1777880754438 pnpm github-app:check
Result: passed.
Coverage: local GitHub App private key authenticated as app id 3586778 / slug reviewrouter-local-777genius, required setup permissions were present, installation 129154876 was visible, and the App installation token could read the latest disposable E2E repository.
Warning: current local App is missing hosted lifecycle webhook subscriptions `installation` and `installation_repositories`. This is acceptable for local setup PR E2E, but `REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted pnpm github-app:check` correctly fails until hosted App webhook events are enabled.
```

Latest hosted readiness gate smoke:

```text
Date: 2026-05-04
Command: pnpm hosted:check:smoke
Result: passed.
Coverage: valid hosted env passes; SaaS env containing provider API key fails; localhost public API URL fails.
```

Latest local + DB beta gate:

```text
Date: 2026-05-04 11:26 EEST
Command: REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
Result: passed.
Coverage: stricter local readiness, 171 unit/integration tests, architecture boundary check, typecheck, lint, format, production build, compiled API/worker runtime smoke, automated 10-page web smoke with installer redirect check, whitespace, shell syntax, migration smoke, backup restore smoke, webhook lifecycle, outbox maintenance, rate limits, distributed locks, review config, action control plane OIDC, support diagnostics.
```

Latest browser smoke:

```text
Date: 2026-05-04 10:03 EEST
Command: pnpm web:smoke
Pages: /, /dashboard, /getting-started, /security, /fair-use, /disconnect, /privacy, /terms, /status, /support
Result: production Next server returned 200 for all pages; getting-started/security included the configured Codex installer commands; /install/codex returned the expected redirect to the raw GitHub seed script.
```

Latest fresh setup validation:

```text
Date: 2026-05-04
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777850784656
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777850784656/pull/1
Result: setup PR created and merged; workflow health changed from missing to present with expected action ref 777genius/review-router@main.
```

## Public Beta Must Have

- clear privacy statement: ReviewRouter SaaS does not store code, diffs, or Codex OAuth in v1
- GitHub App permissions explanation
- safe generated workflow defaults
- install flow tested on fresh org/repo
- clear fork PR behavior
- clear Codex OAuth reseed guidance
- support contact/channel or trusted-beta support path
- basic status/incident communication path
- terms/privacy draft before public users beyond trusted testers

## Product Trust Must Have

- screenshots or docs showing where secrets live
- no misleading token/cost display for Codex OAuth
- clear “review runs in your CI” explanation
- uninstall/disconnect instructions
- workspace deletion instructions

## Technical Beta Must Have

- staging and production separated
- backup restore tested once
- webhook signature verification tested
- duplicate webhook test
- workflow provisioning concurrency test for GitHub write conflicts and raced PR creation
- OIDC token reject tests
- generated workflow security snapshot test

## Already Validated In Local Beta

- webhook signature verification
- duplicate webhook delivery idempotency
- outbox retry and stale processing recovery
- repository health workflow probe
- workflow provisioning idempotency and conflict handling
- OIDC action session exchange and replay guard tests
- action health metadata reporting
- provider setup guidance without SaaS secret custody
- local backup/restore smoke for metadata database
- repeatable fresh repository E2E script
- repeatable full review E2E script with Codex OAuth
- trusted-beta support page with safe report template and secret redaction rules
- trusted-beta privacy, terms, and status draft pages
- trusted-beta disconnect page covering App uninstall, workflow cleanup, secret deletion, and workspace deletion request path
- trusted-beta fair-use page and deterministic repository sync cap
- generated workflow security snapshot test

## Remaining Before Public Launch

- deploy web/API/worker behind real HTTPS URLs
- use `deploy/README.md` and `deploy/env.production.example` for first hosted beta rollout
- run `REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm hosted:check` against real hosted secrets before deploy
- run `REVIEW_ROUTER_HOSTED_ENV_FILE=.env.production pnpm public-beta:check` after hosted GitHub App webhook events are enabled
- configure production GitHub App callback/setup URLs
- choose production database and backup target
- run one restore drill against the chosen production backup target
- replace beta draft legal/status pages with reviewed production text
- define production support contact and hosted incident status channel
- tune public beta limits after trusted tester feedback

## Not Required For First Private Beta

- payment collection
- SSO/SAML
- SOC2
- cloud review execution
- enterprise self-hosted control plane

## Launch Blockers

- any default workflow using `pull_request_target` for untrusted code review
- storing Codex OAuth in SaaS
- storing repo code/diff in SaaS
- unscoped repository access bug
- setup PR can be duplicated by repeated clicks or GitHub API races
- invalid webhook signature accepted
