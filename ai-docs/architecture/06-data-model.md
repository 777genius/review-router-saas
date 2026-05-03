# Data Model Draft

## Core Tables

### User

```text
id
githubUserId unique
login
avatarUrl
name nullable
createdAt
updatedAt
```

### Workspace

```text
id
slug unique
name
type: personal | organization
createdAt
updatedAt
```

### WorkspaceMember

```text
id
workspaceId
userId
role: owner | admin | maintainer | viewer
createdAt
updatedAt
unique(workspaceId, userId)
```

### GitHubInstallation

```text
id
workspaceId
githubInstallationId unique
accountLogin
accountType: User | Organization
accountAvatarUrl
status: active | suspended | deleted
lastSyncedAt nullable
syncStatus
createdAt
updatedAt
```

### RepositoryConnection

```text
id
workspaceId
installationId
githubRepoId unique
owner
name
fullName
private boolean
defaultBranch
selected boolean
permissionsJson
lastSyncedAt nullable
createdAt
updatedAt
```

### ReviewConfiguration

```text
id
workspaceId
repoId nullable
scope: workspace | repository
currentVersion
createdAt
updatedAt
unique(workspaceId, repoId nullable normalized)
```

### ReviewConfigurationVersion

```text
id
configurationId
version
configJson
createdByUserId
createdAt
changeReason nullable
unique(configurationId, version)
```

### ProviderSecretBinding

Tracks where a provider credential should exist. It does not store the secret value.

```text
id
workspaceId
repoId nullable
providerKind: codex | openai | openrouter | anthropic | gemini | custom
authMode: subscription_oauth | api_key | cli_oauth | managed_cloud later
secretScope: repo | org_selected_repo | environment | self_hosted_runner | unknown
secretName
optional boolean
configuredState: configured | missing | stale_or_invalid | unknown
lastCheckedAt nullable
lastCheckSummary nullable
createdAt
updatedAt
unique(workspaceId, repoId, providerKind, authMode, secretName)
```

### ProviderSetupState

Materialized current provider readiness for dashboard display. Derived from Action reports and secret binding checks.

```text
id
workspaceId
repoId nullable
providerKind
authMode
state: unknown | missing | configured | stale_or_invalid | unavailable_in_fork_pr
lastHealthyRunId nullable
lastErrorCode nullable
lastCheckedAt nullable
createdAt
updatedAt
```

### WorkflowProvisioning

```text
id
workspaceId
repoId
status: pending | running | succeeded | failed | cancelled
desiredActionVersion
branchName
pullRequestNumber nullable
errorSummary nullable
createdByUserId
createdAt
updatedAt
```

### GitHubWebhookDelivery

```text
id
deliveryId unique
eventName
installationId nullable
payloadHash
status: received | processed | ignored | failed
errorSummary nullable
receivedAt
processedAt nullable
```

### OutboxEvent

```text
id
type
aggregateType
aggregateId
payloadJson
status: pending | processing | processed | failed
afterAt nullable
attempts
lastError nullable
createdAt
processedAt nullable
```

### ActionSession

Can be implemented as signed JWT only, but persisted sessions are useful for audit/debug in beta. If persisted, keep short retention.

```text
id
workspaceId
repoId
githubRunId
githubRunAttempt
githubActor
githubEventName
oidcSubject
expiresAt
createdAt
```

### ActionRunReport

```text
id
workspaceId
repoId
githubRunId
githubRunAttempt
actionVersion
configVersion
status: started | succeeded | failed | skipped
providerSummaryJson
safeErrorCategory nullable
safeErrorSummary nullable
startedAt nullable
finishedAt nullable
createdAt
updatedAt
unique(repoId, githubRunId, githubRunAttempt)
```

### ActionProtocolAudit

```text
id
workspaceId
repoId
githubRunId nullable
event: oidc_exchange | config_fetch | health_report | rejected
reason nullable
metadataJson
createdAt
```

### AuditEvent

```text
id
workspaceId
repoId nullable
actorUserId nullable
actorType: user | github | system
kind
summary
metadataJson
createdAt
```

### Entitlement

```text
id
workspaceId
plan: free | team | enterprise
featuresJson
limitsJson
createdAt
updatedAt
```

## Notes

- This is a draft, not final Prisma schema.
- Use strong ids/value objects in domain, not raw strings everywhere.
- JSON fields are acceptable for v0 config, but important query dimensions should become columns.
- Do not store secrets or repository code in this model.
- Do not store pull request diffs, raw prompts, or raw model responses in this model.

## Critical Constraints

Tenant isolation constraints that should become Prisma schema constraints/indexes:

```text
User.githubUserId unique
WorkspaceMember unique(workspaceId, userId)
GitHubInstallation.githubInstallationId unique
RepositoryConnection.githubRepoId unique
RepositoryConnection unique(workspaceId, githubRepoId)
ReviewConfiguration unique(workspaceId, repoId, scope)
ReviewConfigurationVersion unique(configurationId, version)
ActionRunReport unique(repoId, githubRunId, githubRunAttempt)
GitHubWebhookDelivery.deliveryId unique
```

`RepositoryConnection.githubRepoId unique` is intentional in v1: one GitHub repo belongs to one ReviewRouter workspace at a time.
