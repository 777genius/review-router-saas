# GitHub Permission Matrix

## Principle

Every GitHub App permission must have a user-facing explanation.

If a permission cannot be explained clearly, do not request it until a feature needs it.

## Expected v1 Permissions

| Permission           |     Access | Why                                                                                                                                                                            |
| -------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Metadata             |       Read | Required baseline for GitHub Apps and repository identity.                                                                                                                     |
| Contents             | Read/Write | Create setup/update branch and workflow/config files through PR.                                                                                                               |
| Pull requests        | Read/Write | Create setup/update PRs and read setup PR state for provisioning.                                                                                                              |
| Workflows            |      Write | Required to create or update `.github/workflows/reviewrouter.yml` through the GitHub App.                                                                                      |
| Issues               |      Write | Support issue-style PR summary/setup/help conversations when App-bot identity or SaaS guidance is used.                                                                        |
| Secrets              |      Write | Verify GitHub Actions secret metadata and write encrypted rotating Codex OAuth secret payloads after OIDC/writeback checks. Secret values are never readable through this API. |
| Organization secrets |       Read | Verify selected-repository organization secret metadata for organization-owned repositories. Secret values are never readable.                                                 |
| Actions              | Read/Write | Dispatch an exact-revision T0 review from a durable request and read the resulting run metadata. ReviewRouter does not cancel or mutate unrelated workflow runs.               |
| Checks               |      Write | Create or update ReviewRouter-owned check runs when direct GitHub check integration is enabled.                                                                                |
| Commit statuses      |      Write | Create or update ReviewRouter-owned commit statuses when direct GitHub status integration is enabled.                                                                          |

## Optional Advanced Permission Profile

Org-wide required workflow is an advanced organization-only setup path. It is
not the default onboarding path.

| Permission                  | Access | Why                                                                                                                       |
| --------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------- |
| Organization Administration |  Write | Create/update one ReviewRouter organization ruleset and its required workflow source. Used only after explicit UI action. |

Implementation rule:

```text
standard profile    -> no organization_administration permission
org-ruleset profile -> organization_administration: write
```

Because GitHub App permissions are registration-level, ReviewRouter cannot
truly request this permission only at the exact button click. The product UX
therefore treats it as an on-demand upgrade:

1. user keeps using per-repository setup PR by default
2. user opens Advanced org-wide mode
3. ReviewRouter probes ruleset access with the installation token
4. if permission is missing, UI explains why and links to approve/update App permissions
5. if the user declines, per-repository setup PR remains available

## Permissions to Avoid in v1

Avoid unless a specific feature requires them:

```text
Members
Deployments
Packages
Organization webhooks beyond App installation webhook needs
```

Organization Administration remains avoided for default onboarding. It is
allowed only for the advanced org-ruleset mode above.

## Workflow File Caveat

Creating or modifying `.github/workflows/*.yml` requires workflow-related permission in addition to contents write. The spike verified that `contents: write` alone is not enough for App-managed workflow provisioning.

If workflow permission looks too strong for a customer, fallback options:

1. Generate setup PR using user OAuth token after explicit confirmation.
2. Ask user to add workflow manually from dashboard instructions.
3. Use curl installer for local setup.

## User-Facing Copy

Example:

```text
ReviewRouter needs Contents and Workflows write to open a pull request that adds or updates `.github/workflows/reviewrouter.yml`. It needs Pull requests write to create and inspect setup PRs, Issues write for PR summary/setup/help conversations when App-bot identity or SaaS guidance is enabled, and Secrets write to verify GitHub Actions secret metadata and write encrypted rotating Codex OAuth payloads after OIDC/writeback checks. GitHub never returns secret values. Actions read, Checks write, and Commit statuses write are used for live workflow/status integration owned by ReviewRouter. It does not push directly to your default branch.

Advanced org-wide mode additionally needs Organization Administration write to create or update a GitHub organization ruleset. Provider secrets still stay in GitHub Actions and are never sent to ReviewRouter.
```

## Review Cadence

Any permission change requires:

- ADR or architecture note update
- UI copy update
- install flow screenshot update
- security review
