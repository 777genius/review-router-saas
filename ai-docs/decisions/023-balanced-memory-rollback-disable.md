# ADR-023: Balanced Memory Rollback and Disable Behavior

## Status

Accepted.

## Decision

Balanced Memory must be disableable at both service and workspace level without
breaking normal reviews. The disable path blocks runtime bundles, new writes,
suggestion proposals, confirmations and edits, while preserving authorized
cleanup: reject pending suggestions, disable/delete memory and export existing
records.

## Rationale

Memory is privacy-sensitive and can influence AI responses. Operators need a
fast kill switch that removes memory from runtime without requiring database
surgery or a risky rollback.

## Rules

- Service flags: `REVIEW_ROUTER_MEMORY_ENABLED=0|false|off` or
  `REVIEW_ROUTER_DISABLE_MEMORY=1|true|on`.
- Workspace flag: entitlement feature `balanced_memory=false`.
- Use cases fail closed through `MemoryPolicyConfigPort`.
- Runtime bundle failure is non-blocking for normal review.
- Cleanup actions remain available for authorized admins.
- Runbooks must document expected API and dashboard behavior.

## Consequences

Positive:

- emergency rollback is fast
- users can still remove/export memory after disable
- normal ReviewRouter review flow does not depend on memory availability

Negative:

- disabled state needs explicit UI copy to avoid confusing admins
- cleanup paths must be tested separately from write paths
