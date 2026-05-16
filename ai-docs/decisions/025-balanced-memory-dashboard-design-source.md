# ADR-025: Balanced Memory Dashboard Design Source

## Status

Accepted.

## Decision

The PNG files in `ai-docs/design/memory/` are the design source of truth until a
Figma file replaces them. Implementation must preserve the reference structure:
left scope/repository rail, center work area, right policy/detail panel,
pending suggestions mode and dense operational table mode.

## Rationale

Memory management is a trust surface, not a marketing page. Admins need dense,
predictable controls for scanning, approving, disabling, deleting and exporting
memory.

## Rules

- Use shared `@reviewrouter/ui` primitives and Radix-based components first.
- Badges are compact labels, not action-like buttons.
- Destructive actions use confirmation dialogs with retention impact.
- Empty, read-only, disabled, over-quota, stale edit and degraded index states
  stay inside the same layout.
- Screenshot QA records desktop, tablet and mobile artifacts.
- If the reference changes, update the PNG or README in the same commit.

## Consequences

Positive:

- UI implementation cannot drift into a different product shape unnoticed
- badge/button distinction stays clear
- responsive regressions are easier to catch

Negative:

- some implementation changes require design README updates
- preview fixtures must stay maintained with the component
