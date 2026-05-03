# Workspace Membership Lifecycle

## Purpose

ReviewRouter is multi-tenant. Workspace membership and ownership must be explicit before team usage, otherwise authorization becomes fragile.

## Roles

```text
owner - full control, billing/entitlements later, ownership transfer, delete workspace
admin - manage repositories, config, workflow provisioning, members except owners
maintainer - manage selected repository config/workflows
viewer - read-only dashboard
```

## Owner Safety

Rules:

- workspace must always have at least one owner
- owner cannot remove their own owner role if they are the last owner
- workspace deletion requires owner role
- ownership transfer is audited

## Invites

Invitation should include:

```text
workspaceId
email or GitHub login if available
role
invitedByUserId
expiresAt
acceptedAt nullable
revokedAt nullable
```

Rules:

- only owner/admin can invite
- owner invites may require owner role
- invite tokens are single-use and expire
- accepting invite links GitHub user id, not mutable login only

## GitHub Org Membership Drift

GitHub org membership can change outside ReviewRouter.

v1 policy:

- ReviewRouter membership is explicit after initial owner setup
- signed GitHub installation webhook `sender` becomes initial workspace owner when the App is installed or reactivated
- this owner grant is keyed by immutable `sender.id`; login is only a display snapshot
- GitHub App installation access does not automatically grant dashboard access to every org member
- future org membership sync can suggest/remediate access

Why:

- the webhook is signed by GitHub and proves who performed the installation event
- it avoids requiring broad `read:org` OAuth scopes for basic onboarding
- it keeps tenant access explicit and auditable after the first owner is established

## Repository-Level Access Later

Maintainer role may need repo scoping:

```text
WorkspaceMemberRepositoryAccess(memberId, repoId, roleOverride)
```

Do not implement until needed, but do not hard-code that maintainers manage every repo forever.

## Audit

Audit:

- invite created
- invite accepted
- invite revoked
- member role changed
- member removed
- ownership transferred
- workspace deletion requested

## Tests

- last owner cannot be removed
- viewer cannot mutate config
- maintainer cannot manage workspace members
- invite token cannot be reused
- GitHub login rename does not break identity because GitHub user id is canonical
