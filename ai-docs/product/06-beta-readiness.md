# Beta Readiness Checklist

## Current Private MVP Status

Status: private/local beta is functionally validated for the intended v1 model:
SaaS control plane plus review execution inside customer GitHub Actions.

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

## Public Beta Must Have

- clear privacy statement: ReviewRouter SaaS does not store code, diffs, or Codex OAuth in v1
- GitHub App permissions explanation
- safe generated workflow defaults
- install flow tested on fresh org/repo
- clear fork PR behavior
- clear Codex OAuth reseed guidance
- support contact/channel
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
- repeatable fresh repository E2E script
- repeatable full review E2E script with Codex OAuth

## Remaining Before Public Launch

- deploy web/API/worker behind real HTTPS URLs
- configure production GitHub App callback/setup URLs
- choose production database and backup target
- run one backup restore drill
- write customer-facing terms/privacy
- define support contact and incident status page/channel
- decide public beta limits and abuse policy text

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
