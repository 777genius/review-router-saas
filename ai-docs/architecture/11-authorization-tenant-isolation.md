# Authorization and Tenant Isolation

## Core Rule

Every read/write operation must be scoped through workspace membership and GitHub installation/repository access.

Do not rely on UI filtering for authorization.

## Tenant Entities

```text
Workspace
WorkspaceMember
GitHubInstallation
RepositoryConnection
ReviewConfiguration
ProviderSetupState
WorkflowProvisioning
AuditEvent
```

Every tenant-owned table should include `workspaceId` directly or through a required parent relation.

## Authorization Policy Service

Application layer should expose explicit policies:

```ts
canViewWorkspace(userId, workspaceId)
canManageWorkspace(userId, workspaceId)
canViewRepository(userId, repoId)
canManageRepository(userId, repoId)
canInstallWorkflow(userId, repoId)
canUpdateReviewConfig(userId, scope)
canViewAuditLog(userId, workspaceId)
```

Do not scatter role checks across tRPC routers and React components.

## Roles

Initial roles:

```text
owner - full workspace control
admin - manage repos/config/workflows/users except ownership transfer
maintainer - manage repo config/workflow for selected repos
viewer - read-only dashboard access
```

## GitHub Membership Drift

GitHub org membership and ReviewRouter workspace membership can drift.

v1 approach:

- initial membership based on installing/logged-in user
- explicit ReviewRouter members stored in DB
- installation sync records GitHub account metadata
- future org membership sync can tighten access

For beta, be conservative:

- only installer/admin gets owner by default
- invite/add members explicitly or via later org sync

## Row-Level Safety

Every repository query should include workspace scope.

Bad:

```ts
findRepoById(repoId)
```

Good:

```ts
findRepoForWorkspace(workspaceId, repoId)
```

## Tests Required

- user cannot read repo outside workspace
- user cannot update config outside workspace
- viewer cannot provision workflow
- maintainer cannot change workspace ownership
- deleted/suspended installation blocks provisioning
- repository id from OIDC token must map to active selected repo

## Future Hardening

Potential future layer:

- Postgres Row Level Security
- organization membership sync
- SSO/SAML roles
- SCIM provisioning
- enterprise audit exports

## See Also

- [Tenant Isolation Invariants](./34-tenant-isolation-invariants.md)
