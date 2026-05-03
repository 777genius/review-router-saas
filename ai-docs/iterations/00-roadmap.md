# Iteration Roadmap

## Strategy

Build a lean public beta with production-grade architectural seams.

Do not start with payment, cloud execution, or enterprise SSO. Start with shared GitHub App onboarding and customer-CI execution.

Use [Implementation Playbook](../IMPLEMENTATION_PLAYBOOK.md) as the executable end-to-end guide. The files below are per-iteration summaries.

If an external account, GitHub org, secret, or real E2E dependency blocks a task, follow [Blocker Handling](../appendices/blocker-handling.md). Keep progress inside the current iteration by implementing tests, contracts, mocked adapters, UI states, or docs that do not require the blocked dependency.

## Iterations

1. [Iteration 01 - Foundation](./01-foundation.md)
2. [Iteration 02 - GitHub Identity and App Install](./02-github-identity-and-app-install.md)
3. [Iteration 03 - Repository Sync and Workspace Dashboard](./03-repository-sync-dashboard.md)
4. [Iteration 04 - Workflow Provisioning](./04-workflow-provisioning.md)
5. [Iteration 05 - Review Config and Provider Setup](./05-review-config-provider-setup.md)
6. [Iteration 06 - Action Control Plane Protocol](./06-action-control-plane-protocol.md)
7. [Iteration 07 - Webhooks, Jobs, Locks, and Outbox](./07-webhooks-jobs-locks-outbox.md)
8. [Iteration 08 - Health, Audit, and Beta Hardening](./08-health-audit-beta-hardening.md)
9. [Iteration 09 - Free Entitlements and Future Billing Boundary](./09-entitlements-billing-boundary.md)
10. [Iteration 10 - GitHub App Lifecycle Webhooks](./10-github-app-lifecycle-webhooks.md)
11. [Iteration 11 - Provider Secret Onboarding](./11-provider-secret-onboarding.md)

## Quality Gate Before Public Beta

- install flow works on a fresh GitHub org/repo
- setup PR is correct and mergeable
- workflow runs in customer repo
- action can fetch runtime config through GitHub Actions OIDC or fall back to static config
- provider setup state is understandable
- fork PR safety is documented and enforced in generated workflow
- generated workflow does not use `pull_request_target` for default review execution
- action protocol has versioned schemas and size limits
- duplicate webhooks do not duplicate side effects
- workflow provisioning cannot create duplicate setup PRs under concurrent requests
- audit events exist for important actions
- all GitHub permissions are documented in onboarding
- install/uninstall/repository removed lifecycle events are handled
- same-repository PR trust caveat is visible in docs/onboarding
- action update/rollback path is documented
