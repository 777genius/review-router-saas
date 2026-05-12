# ADR-021: Balanced Memory Confirmation Authority

## Status

Accepted.

## Decision

Project memory confirmation requires workspace admin authority for workspace
scope and repository maintainer or workspace admin authority for repository
scope. PR authors and regular members cannot save project memory by default.

User preference memory is limited to safe response preferences and can only be
changed by that user. Model-suggested candidates and natural language requests
create pending suggestions unless an explicit command path is allowed by policy.

Fork PRs do not receive private workspace memory by default.

## Rationale

Memory poisoning is an authorization problem. A helpful-looking PR comment can
teach the model incorrect or malicious project rules if PR authors can confirm
memory freely.

## Rules

- `MemoryPermissionPort` is the only confirmation authority boundary.
- GitHub `write` permission is not enough for project memory confirmation.
- Repository maintainers can manage repository memory, not workspace memory.
- Pending suggestions stay out of runtime until confirmation.
- Bot actors and action runtime actors cannot grant themselves memory
  authority.
- Future custom role support must be explicit workspace policy.

## Consequences

Positive:

- memory poisoning risk is reduced
- authority can be audited and tested independently
- fork and Dependabot behavior stays fail-closed

Negative:

- PR authors need a maintainer/admin to approve useful project memory
- some teams may need future custom role mapping
