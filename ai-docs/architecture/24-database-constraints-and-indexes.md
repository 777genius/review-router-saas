# Database Constraints and Indexes

## Principle

Application checks are not enough. Critical invariants must be backed by database constraints.

## Required Unique Constraints

```text
User.githubUserId
Workspace.slug
WorkspaceMember(workspaceId, userId)
GitHubInstallation.githubInstallationId
RepositoryConnection.githubRepoId
ReviewConfiguration(workspaceId, repoId normalized)
ReviewConfigurationVersion(configurationId, version)
GitHubWebhookDelivery.deliveryId
ActionRunReport(repoId, githubRunId, githubRunAttempt)
OutboxEvent.id
JobExecution.idempotencyKey if separate table exists
```

## Required Foreign Keys

- workspace-owned records reference Workspace
- repo records reference Workspace and GitHubInstallation
- config versions reference config
- audit events reference workspace and optionally repo/user
- action reports reference workspace/repo

Use restrictive deletes for safety unless deletion flow explicitly cascades through a tested job.

## Important Indexes

```text
GitHubInstallation(workspaceId, status)
RepositoryConnection(workspaceId, selected, fullName)
RepositoryConnection(installationId)
WorkflowProvisioning(repoId, status)
ProviderSetupState(workspaceId, repoId, provider)
GitHubWebhookDelivery(receivedAt, status)
OutboxEvent(status, afterAt, createdAt)
AuditEvent(workspaceId, createdAt)
ActionRunReport(repoId, createdAt)
```

## Soft Delete vs Hard Delete

Default:

- operational entities use status fields
- workspace deletion schedules hard-delete job
- audit retention follows retention policy

Do not cascade-delete data accidentally through Prisma relation defaults.

## Migration Tests

Before public beta:

- migration applies to empty DB
- migration applies to seeded DB
- rollback or forward-fix path documented
- unique constraints tested for race conditions
