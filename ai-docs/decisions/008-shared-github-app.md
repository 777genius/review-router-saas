# ADR-008: Shared GitHub App Product Model

## Status

Accepted.

## Decision

Use one shared ReviewRouter GitHub App for the SaaS product.

## Rationale

A shared GitHub App gives customers a clean install flow and consistent bot identity. It also allows ReviewRouter to manage installations, repositories, webhook events, and workflow provisioning centrally.

## Difference From Current Curl Installer

Current open-source installer flow can create/reuse user-owned GitHub Apps. SaaS flow should use one ReviewRouter-owned app.

Open-source mode remains valuable for self-managed users. SaaS mode improves onboarding and product consistency.

## Permissions Principle

Request only permissions needed for v1:

```text
metadata: read
contents: write
workflows: write
pull_requests: write
```

Every permission must be explained in onboarding. The accepted permission rationale is detailed in [ADR-014](./014-one-click-workflow-provisioning.md) and [GitHub Permission Matrix](../architecture/14-github-permission-matrix.md).

## Consequences

Positive:

- better UX
- unified bot identity
- centralized installation lifecycle
- future billing per installation/workspace

Negative:

- GitHub App security review/trust matters more
- permission changes affect all customers
- App outage affects all SaaS users
