# Beta Readiness Checklist

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
