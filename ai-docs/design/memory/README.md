# Balanced Memory Design References

These PNG files are the design source of truth for the Balanced Memory dashboard
until a Figma file replaces them.

## Files

| File                                  | Size      | Purpose                                                                        |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `memory-management-concept-board.png` | 1823x863  | Overall direction: quiet operational dashboard, dense scanning, no hero screen |
| `knowledge-base-split-reference.png`  | 1236x1640 | Main knowledge base: scope rail, grouped list, detail panel                    |
| `suggestion-inbox-reference.png`      | 1096x1640 | Pending suggestions: review queue, risk flags, approve/reject/edit flow        |
| `operational-table-reference.png`     | 1312x1640 | Admin mode: dense table, filters, row actions, pagination                      |

## Implementation Contract

- The first viewport must be the working memory manager, not a landing page.
- Preserve the split-dashboard feel: filters, list/table and detail surfaces are
  siblings, not cards inside cards.
- Use existing shared UI primitives before creating memory-only controls.
- Keep status/scope/risk chips visible in list, inbox and table modes.
- Include empty, loading, error, permission-denied, stale-version and over-quota
  states inside the same layouts.
- Destructive actions must use confirmation dialogs and explain retention impact.
- If implementation discovers a better UX, update this README or the PNG
  reference in the same change as the code.

## Verification

Before the UI is considered done, capture screenshots for:

- desktop 1440x1000;
- tablet 900x1100;
- mobile 390x844.

Compare those screenshots against the PNG references above and document any
intentional deviation in the implementation notes.

Design QA matrix:

| State              | Required screenshot/check                                      |
| ------------------ | -------------------------------------------------------------- |
| normal data        | knowledge split, suggestion inbox and admin table              |
| empty workspace    | same layout density, no marketing/landing screen               |
| permission denied  | read-only state with disabled mutation controls                |
| over quota         | quota banner and safe actions without blocking export/delete   |
| stale edit         | conflict/version dialog and recovery path                      |
| indexing degraded  | search degradation indicator without implying memory data loss |
| destructive action | confirmation dialog with retention impact                      |
| mobile             | list/detail flow without clipped actions or overlapping chips  |

Suggested artifact paths:

- `tmp/design-verification/memory/desktop-knowledge.png`
- `tmp/design-verification/memory/desktop-suggestions.png`
- `tmp/design-verification/memory/desktop-table.png`
- `tmp/design-verification/memory/tablet-knowledge.png`
- `tmp/design-verification/memory/mobile-list.png`
- `tmp/design-verification/memory/mobile-detail.png`

## Implementation Notes

2026-05-12 verification pass:

- Preview URL: `/dashboard/memory-preview`.
- Preview guard: `REVIEW_ROUTER_ENABLE_MEMORY_PREVIEW=1`; without the flag the
  route returns `notFound()`.
- Data source: deterministic synthetic fixtures only. No DB, auth cookie, source
  code, diff, prompt or production memory is read by the preview route.
- Browser captures were saved to all suggested artifact paths above at
  `1440x1000`, `900x1100` and `390x844`.
- Edge-state smoke checks passed for empty, permission denied/read-only, over
  quota, stale edit and indexing degraded states.
- Clean-profile browser captures rendered without preview-route failures after
  fixing a disabled-dialog hydration mismatch. A persistent local dev profile can
  still emit unrelated stale NextAuth JWT cookie noise before the preview route
  renders.

Intentional implementation choices:

- The dashboard keeps the reference split layout. Knowledge and suggestion modes
  use left scope rail, center work area and right policy/detail panel.
- Table mode uses the reference operational shape with left filters and a wide
  dense table. The policy/detail panel is hidden in table mode to prevent overlap
  and keep scan density.
- Memory badges are compact labels in this feature, not large action-like pills.
  Real actions continue using shared `@reviewrouter/ui` Button/FormSubmitButton
  and shared Dialog primitives.
- Export CSV remains disabled in this slice. Disable/delete/edit flows are live
  and keep confirmation dialogs with retention impact.

Token notes to capture during implementation:

- background/surface/border/text/muted/accent colors;
- danger/warning/success/status chip colors;
- focus ring token;
- table row height, toolbar height and detail panel width;
- mobile breakpoint behavior and minimum action target size;
- any intentional deviation from existing `packages/ui` tokens.

Reference update rule:

- update PNG and README in the same change when the design direction changes;
- keep one source-of-truth screenshot per mode instead of accumulating stale
  variants;
- do not accept implementation screenshots as new references until overflow,
  focus, contrast and permission states are verified.
