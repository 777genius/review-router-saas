# Tenant Isolation Invariants

## Purpose

Tenant isolation is the highest-risk SaaS area. A bug here can leak repository metadata, config, audit events, or allow one workspace to provision workflows in another workspace's repository.

## Hard Invariants

These invariants must be enforced by both application policies and database constraints where possible.

```text
User is not authority by itself.
Workspace membership is authority for dashboard actions.
GitHub installation is authority for repository access.
RepositoryConnection must belong to exactly one active workspace in v1.
Every config, workflow provisioning job, action report, and audit event is workspace-scoped.
OIDC config fetch is authorized by immutable GitHub repository id, not by repo name alone.
```

## Identity Keys

Prefer immutable GitHub ids:

```text
githubUserId
githubInstallationId
githubRepositoryId
githubRepositoryOwnerId
```

Store names as display snapshots:

```text
login
owner
repo name
fullName
```

Never authorize only by `owner/repo` string.

## Repository Ownership Rule

v1 rule:

```text
githubRepositoryId is globally unique in RepositoryConnection
```

This means one GitHub repository can be connected to only one ReviewRouter workspace at a time.

Why:

- simpler tenant isolation
- avoids two workspaces racing over the same workflow/config
- avoids confusing billing/audit ownership

Future enterprise sharing can add an explicit transfer/share flow, not implicit duplication.

## Required Query Pattern

Bad:

```ts
repositoryRepository.findById(repoId)
configRepository.findByRepoId(repoId)
```

Good:

```ts
repositoryRepository.findSelectedByWorkspaceAndRepoId(workspaceId, repoId)
configRepository.findCurrentForWorkspaceRepository(workspaceId, repoId)
```

Every repository lookup in application services must include `workspaceId` unless it is resolving an OIDC token by immutable `githubRepositoryId` and then deriving workspace from the active connection.

## OIDC Exchange Isolation

OIDC exchange flow:

```text
1. Verify JWT issuer/signature/audience/time.
2. Extract repository_id, repository, repository_owner_id, event_name, run_id, run_attempt, workflow_ref.
3. Find active RepositoryConnection by githubRepositoryId.
4. Verify repository fullName matches token repository.
5. Verify installation is active.
6. Verify repository is selected/enabled.
7. Verify workflow_ref path is allowed.
8. Create action session scoped to workspaceId, repoId, githubRunId, runAttempt.
```

Important:

```text
OIDC token proves the GitHub workflow identity.
It does not prove the PR code is trusted.
```

Secret-backed provider enablement must still check event/fork/trust policy.

## Config Fetch Isolation

Action session can fetch only:

```text
its own repo config
its own workspace inherited config for that repo
metadata needed for this run
```

Action session cannot:

```text
list workspace repos
read audit log
mutate config
access dashboard APIs
fetch another repo config
```

## Workflow Provisioning Isolation

Creating setup/update PR requires:

```text
user is workspace owner/admin/maintainer with repo permission
repository belongs to workspace
installation is active
App token can access the repository
workflow template version is approved
```

Provisioning job payload stores ids, not names as authority:

```text
workspaceId
repoId
githubInstallationId
githubRepositoryId
templateVersion
actionRef
requestedByUserId
```

## Database Constraints

Baseline constraints:

```text
User.githubUserId unique
Workspace.slug unique
WorkspaceMember unique(workspaceId, userId)
GitHubInstallation.githubInstallationId unique
RepositoryConnection.githubRepositoryId unique
RepositoryConnection unique(workspaceId, githubRepositoryId)
ReviewConfiguration unique(workspaceId, repoId, scope)
ReviewConfigurationVersion unique(configurationId, version)
ActionRunReport unique(repoId, githubRunId, githubRunAttempt)
GitHubWebhookDelivery.deliveryId unique
WorkflowProvisioning unique(repoId, branchName, status in active statuses) via partial index if supported
```

Critical foreign keys:

```text
RepositoryConnection.workspaceId -> Workspace.id
RepositoryConnection.installationId -> GitHubInstallation.id
ReviewConfiguration.repoId -> RepositoryConnection.id
ProviderSecretBinding.repoId -> RepositoryConnection.id nullable
ActionRunReport.repoId -> RepositoryConnection.id
AuditEvent.workspaceId -> Workspace.id
```

## Authorization Policies

Application policies:

```text
canViewWorkspace
canManageWorkspace
canViewRepository
canManageRepository
canProvisionWorkflow
canUpdateReviewConfig
canManageProviderSecrets
canViewAuditLog
canTransferRepositoryConnection
```

No tRPC router or React component should implement role checks directly. They call policy services.

## Audit Requirements

Audit every cross-boundary action:

```text
GitHub App installed/uninstalled/suspended
repository selected/removed
workflow setup PR requested/created/failed
review config changed
provider secret setup state changed
OIDC exchange rejected
support/admin access
workspace role changed
ownership transfer
```

Audit metadata must be safe and should not contain code, diffs, prompts, or secrets.

## Tests

Minimum isolation tests:

- user from workspace A cannot read workspace B repo
- user from workspace A cannot create setup PR for workspace B repo
- OIDC token for repo A cannot fetch repo B config
- OIDC token with renamed repository still maps by repo id and validates name snapshot
- removed repository cannot fetch config
- suspended installation blocks provisioning
- viewer cannot update config
- maintainer cannot change workspace owners
- action session cannot call dashboard routes
- webhook duplicate delivery is idempotent
