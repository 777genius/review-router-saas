# ADR-022: Balanced Memory Data Residency and Tenant Isolation

## Status

Accepted.

## Decision

Balanced Memory is tenant-scoped by workspace. Every repository, suggestion,
item, usage event, export, support diagnostic and search operation must carry a
workspace boundary. Repository memory must also carry repository scope where
applicable.

For v1, data residency follows the workspace's SaaS database region. The schema
and ports should remain compatible with future workspace-region routing.

## Rationale

Memory becomes high-trust context in AI replies. Cross-workspace leakage would
be a severe product and security failure, especially with private repositories.

## Rules

- Repository methods require `workspaceId`.
- Object id lookup without workspace scope is forbidden in use cases.
- Search hits are untrusted until canonical tenant rehydration.
- Support diagnostics expose counts and states only, not memory body or source
  excerpts.
- Export is workspace-admin only and excludes deleted rows, embeddings and raw
  source fields.

## Consequences

Positive:

- tenant isolation is testable at port and E2E levels
- future region routing has a clear boundary
- support tooling can remain privacy-safe

Negative:

- all adapters need explicit workspace predicates
- global analytics must use aggregated safe metadata only
