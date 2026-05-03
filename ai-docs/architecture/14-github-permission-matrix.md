# GitHub Permission Matrix

## Principle

Every GitHub App permission must have a user-facing explanation.

If a permission cannot be explained clearly, do not request it until a feature needs it.

## Expected v1 Permissions

| Permission | Access | Why |
|---|---:|---|
| Metadata | Read | Required baseline for GitHub Apps and repository identity. |
| Contents | Read/Write | Create setup/update branch and workflow/config files through PR. |
| Pull requests | Read/Write | Create setup/update PRs and read PR state for provisioning. |
| Issues | Read/Write | PR comments use the issues comments API in GitHub. Needed if SaaS posts setup/help comments. |
| Workflows | Write | Required to create or update `.github/workflows/reviewrouter.yml` through the GitHub App. |
| Actions | Write | Required for workflow-related App capabilities and future workflow run management paths. Keep usage audited and narrow. |
| Checks | Not v1 | Only needed if SaaS creates check runs directly. v1 avoids this because the action handles status. |

## Permissions to Avoid in v1

Avoid unless a specific feature requires them:

```text
Administration
Members
Secrets
Deployments
Packages
Organization webhooks beyond App installation webhook needs
```

## Workflow File Caveat

Creating or modifying `.github/workflows/*.yml` requires workflow-related permission in addition to contents write. The spike verified that `contents: write` alone is not enough for App-managed workflow provisioning.

If workflow permission looks too strong for a customer, fallback options:

1. Generate setup PR using user OAuth token after explicit confirmation.
2. Ask user to add workflow manually from dashboard instructions.
3. Use curl installer for local setup.

## User-Facing Copy

Example:

```text
ReviewRouter needs Contents write only to open a pull request that adds or updates `.github/workflows/reviewrouter.yml`. It does not push directly to your default branch.
```

## Review Cadence

Any permission change requires:

- ADR or architecture note update
- UI copy update
- install flow screenshot update
- security review
