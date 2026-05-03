# GitHub Installation Lifecycle

## Why This Matters

GitHub App installation state changes outside ReviewRouter. Users can add/remove repositories, suspend installations, uninstall the app, rename repos, transfer repos, or change permissions. ReviewRouter must model this explicitly.

## Lifecycle States

```text
pending - install flow started but webhook/sync not completed
active - installation can be used
suspended - installation exists but cannot be used
removed - app uninstalled or installation deleted
permission_error - installation exists but permissions are insufficient
sync_error - last sync failed but installation may still be usable
```

## Events to Handle

```text
installation.created
installation.deleted
installation.suspend
installation.unsuspend
installation_repositories.added
installation_repositories.removed
repository.renamed
repository.transferred
repository.deleted
```

## Repository Selection

SaaS should prefer GitHub selected-repository installs for trust and least privilege.

When GitHub sends repository removed event:

- enqueue full installation repository sync through outbox
- mark RepositoryConnection as unselected/unavailable after sync confirms it is absent
- block workflow provisioning
- keep audit/history metadata
- show clear dashboard status

When repository is added back:

- enqueue full installation repository sync through outbox
- do not automatically re-enable review if previous state was intentionally disabled by ReviewRouter user

## App Uninstall

When app is uninstalled:

- mark installation removed
- block all GitHub operations for that installation
- mark repos disconnected
- keep workspace/config/audit metadata for retention period
- show reconnect CTA in dashboard
- do not delete customer data immediately unless user requests workspace deletion
- reject future OIDC config fetches for repos under removed installation
- note that existing workflow files remain in the customer repo until they remove them

Implementation note: do not rely on GitHub API after `installation.deleted`. The installation token may no longer be mintable, so the webhook handler must immediately mark the installation `removed` and set linked repositories `selected=false`.

## Permission Changes

If permissions are reduced:

- health checks should detect missing capabilities
- workflow provisioning should fail with actionable permission error
- dashboard should explain which permission is missing and why

## Repository Rename or Transfer

Repository identity must use GitHub repository id where possible.

Installation workspace identity must use the immutable GitHub installation id once the installation exists. If GitHub account login changes, ReviewRouter updates the installation account snapshot and workspace display name, but it must not create a replacement workspace or move configs/audit/repositories to a new workspace only because the login-derived slug changed.

On rename:

- update owner/name/fullName
- keep same internal repo id
- preserve config/history

On transfer:

- verify installation/workspace ownership
- if repository no longer belongs to installation/workspace, disconnect until explicit re-selection

## Org Approval Pending

Some organizations require owner approval for GitHub App installation or OAuth access.

Dashboard should represent:

```text
approval_pending
installed_but_no_repo_access
installed_selected_repos_empty
```

## Tests

- app uninstall marks installation removed and blocks provisioning
- repository removed from installation disconnects repo
- repository rename preserves config by GitHub repo id
- permission reduction surfaces health error
- repeated installation events are idempotent
- signed lifecycle E2E runs against local Postgres test DB via `pnpm spike:webhook-lifecycle:e2e`
