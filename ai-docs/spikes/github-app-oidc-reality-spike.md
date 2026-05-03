# GitHub App and OIDC Reality Spike

## Purpose

Validate the riskiest SaaS assumptions before full scaffold:

- existing ReviewRouter GitHub App profile can authenticate with a private key
- installed App can be discovered without asking the user again
- setup workflow can be provisioned into a real repository
- GitHub Actions OIDC token contains enough claims for tenant-safe config exchange
- SaaS API can exchange the OIDC token for a short-lived action session

## Local App Profile Used

The spike used the locally saved profile created by the current console installer:

```text
~/.config/review-router/apps/review-router-ai.env
```

Secret material was not committed or printed.

Detected public metadata:

```text
APP_ID: 3574589
APP_CLIENT_ID: Iv23liekUwzl13goGaMP
APP_SLUG: review-router-ai
APP_NAME: Review Router AI
```

The App is installed for account `777genius` with `repository_selection: all`.

## Real Installation Permissions Observed

Observed permissions:

```text
metadata: read
contents: read
pull_requests: write
issues: write
actions: write
```

This is enough for runtime comment/status behavior but not enough for provisioning a new workflow file through the App token.

## Important Finding

Creating or updating `.github/workflows/*` through GitHub REST requires repository write permission and workflow permission. GitHub returned:

```text
Resource not accessible by integration
x-accepted-github-permissions: contents=write; contents=write,workflows=write
```

Official GitHub docs also state that modifying files in `.github/workflows` requires workflow permission in addition to repository contents write permission.

Reference: [GitHub REST repository contents API](https://docs.github.com/en/rest/repos/contents)

## Product Decision From Spike

Initial spike conclusion considered keeping the shared App lower-permission and using a user-authorized provisioning token for setup PRs.

That direction was superseded by [ADR-014](../decisions/014-one-click-workflow-provisioning.md).

Current accepted v1 decision:

```text
Shared ReviewRouter GitHub App requests the permissions needed to create setup/update PRs for workflow files.
The App creates PRs only and never pushes directly to the default branch.
The local/curl path remains a fallback for customers who do not want to grant workflow write.
```

Why:

- the product goal is one-click SaaS onboarding
- GitHub requires workflow permission to modify `.github/workflows/*`
- the permission prompt is stronger, so onboarding copy must explain it clearly
- the fallback path remains available when a customer rejects App-managed provisioning

## Real Smoke Tests

### Test 1 - OIDC Claims Only

Repository:

```text
777genius/review-router-smoke-20260501203854
```

PR:

```text
https://github.com/777genius/review-router-smoke-20260501203854/pull/3
```

Result:

```text
ReviewRouter SaaS Spike / oidc-claims: success
```

Validated claims included:

```text
actor
actor_id
aud
base_ref
check_run_id
event_name
head_ref
iss
job_workflow_ref
job_workflow_sha
ref
repository
repository_id
repository_owner
repository_owner_id
repository_visibility
run_attempt
run_id
sub
workflow_ref
workflow_sha
```

### Test 2 - Real OIDC Exchange Through ngrok

Repository:

```text
777genius/review-router-smoke-20260501203854
```

PR:

```text
https://github.com/777genius/review-router-smoke-20260501203854/pull/4
```

Local API:

```text
pnpm spike:server
```

Temporary public endpoint:

```text
ngrok http 8787
```

Result:

```text
ReviewRouter SaaS Spike / oidc-claims: success
ReviewRouter OIDC exchange succeeded
POST /api/action/v1/session/exchange -> 200
```

This proves the control-plane bridge works end-to-end:

```text
GitHub Actions OIDC JWT -> ReviewRouter API validation -> short-lived action session
```

No repository code, diff, prompt, Codex auth, OpenAI key, or OpenRouter key was sent to SaaS.

## Current Spike Code

Location:

```text
spikes/github-oidc/
```

Main pieces:

```text
src/github-app.ts              App private-key auth and installation lookup
src/create-setup-pr.ts         setup PR creator with App token then gh-user fallback
src/workflow-template.ts       temporary OIDC workflow
src/oidc.ts                    GitHub OIDC validation and short-lived action session
src/privacy.ts                 metadata-only health report validation
src/server.ts                  Fastify spike API
```

## Tests Added

```text
pnpm typecheck
pnpm spike:test
```

Coverage:

- OIDC rejects wrong audience
- OIDC accepts valid shaped claims
- action session token contains repo/run scope
- health report rejects secret-looking content
- health report rejects diff-looking content
- health report rejects oversized payload
- generated workflow includes `id-token: write`
- generated workflow does not contain static ReviewRouter secrets

## Follow-Up Requirements

1. Keep setup provisioning behind a port:

```text
WorkflowProvisioningPort
  createSetupPullRequest(...)
  createUpdatePullRequest(...)
```

2. Implement adapters:

```text
GitHubUserTokenWorkflowProvisioningAdapter
GitHubAppWorkflowProvisioningAdapter optional later
```

3. Onboarding UI must explain permissions honestly:

```text
Runtime App permissions: comments/webhooks/config identity
Setup provisioning permission: only used to create workflow PR
```

4. OIDC exchange must validate immutable repository ids, not only names.

5. The action session must stay short-lived and scoped to one repo/run/runAttempt.

6. Health reports remain metadata-only with server-side rejection of secret/code-looking payloads.

## Confidence

```text
🎯 9   🛡️ 8   🧠 5
```

The architecture assumption is now validated by a real GitHub Actions run and real OIDC exchange. The remaining complexity is productizing permissions, UI, persistence, and error handling.
