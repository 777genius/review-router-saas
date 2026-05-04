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

Previous full-review validation:

```text
Date: 2026-05-04
Command: REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
Repo: 777genius/rr-saas-fresh-e2e-1777851508064
Setup PR: https://github.com/777genius/rr-saas-fresh-e2e-1777851508064/pull/1
Review PR: https://github.com/777genius/rr-saas-fresh-e2e-1777851508064/pull/2
Run: https://github.com/777genius/rr-saas-fresh-e2e-1777851508064/actions/runs/25294139796
Result: setup PR merged, workflow detected on main, Codex OAuth review ran, intentional critical finding posted inline on auth.js:5.
```

Latest local beta gate:

```text
Date: 2026-05-04 09:18 EEST
Command: pnpm beta:check
Result: passed.
Coverage: local readiness, unit/integration tests, typecheck, lint, format, production build, compiled API/worker runtime smoke, automated 10-page web smoke, whitespace, shell syntax.
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
Date: 2026-05-04 09:12 EEST
Command: REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
Result: passed.
Coverage: stricter local readiness, unit/integration tests, typecheck, lint, format, production build, compiled API/worker runtime smoke, automated 10-page web smoke, whitespace, shell syntax, migration smoke, backup restore smoke, webhook lifecycle, outbox maintenance, rate limits, distributed locks, review config, action control plane OIDC, support diagnostics.
```

Latest browser smoke:

```text
Date: 2026-05-04 08:55 EEST
Command: pnpm build && pnpm web:smoke
Pages: /, /dashboard, /getting-started, /security, /fair-use, /disconnect, /privacy, /terms, /status, /support
Result: production Next server returned 200 for all pages and each page included expected text.
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
