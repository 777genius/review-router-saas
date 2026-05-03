# UI Component Wrapper Conventions

## Goal

Keep UI primitives replaceable and product UI consistent.

ReviewRouter uses Base UI as the headless primitive layer, but application features should depend on ReviewRouter UI wrappers, not directly on Base UI.

## Package Boundary

```text
packages/ui
  owns Base UI imports

apps/web/src/features
  imports @reviewrouter/ui wrappers
```

Allowed:

```ts
import { Dialog } from "@reviewrouter/ui/dialog";
import { Button } from "@reviewrouter/ui/button";
```

Forbidden outside `packages/ui`:

```ts
import { Dialog } from "@base-ui/react/dialog";
```

Exception: while creating a new wrapper inside `packages/ui`.

## Package Shape

```text
packages/ui/src/
  tokens/
    index.css
    tokens.ts
  components/
    button/
      button.tsx
      button.styles.ts
      button.types.ts
      index.ts
    dialog/
      dialog.tsx
      dialog.styles.ts
      dialog.types.ts
      index.ts
    select/
    tabs/
    dropdown-menu/
    tooltip/
    toast/
  utils/
    cn.ts
    create-slot.ts
```

Use one folder per component once the component has styles/types/tests. Tiny primitives may start as one file, but should move to a folder when they grow.

## Component Categories

Generic UI components belong in `packages/ui`:

- Button
- Input
- Textarea
- Checkbox
- Switch
- Dialog
- Drawer
- DropdownMenu
- Select
- Tabs
- Tooltip
- Popover
- Card
- Badge
- CodeBlock
- CopyButton
- Kbd
- Toast

Product components do not belong in `packages/ui`:

- RepositorySetupStep
- ProviderConfigCard
- CodexAuthStatus
- GitHubInstallationBanner
- ReviewSeverityPolicyEditor
- WorkflowPrStatus

Those belong to feature `interface/components`.

Borderline shared product UI should live in `apps/web/src/shared/product-ui` first. Move to `packages/ui` only if it becomes truly generic.

## Styling API

Use a small variant vocabulary:

```text
variant: solid | soft | outline | ghost | link
tone: neutral | accent | success | warning | danger
size: xs | sm | md | lg
```

Avoid boolean prop soup:

Bad:

```tsx
<Button primary danger glowing small />
```

Good:

```tsx
<Button variant="solid" tone="danger" size="sm" />
```

## Variants Tooling

Use `tailwind-variants` for multi-slot components because Base UI components often have multiple parts.

Use simple class helpers for trivial single-slot components.

Do not introduce multiple competing variant systems unless there is a concrete need.

## Slot Conventions

Components with multiple DOM parts should expose stable slot names:

```text
root
trigger
positioner
popup
title
description
close
arrow
```

Use `data-slot` attributes to make styling and tests stable:

```tsx
<div data-slot="dialog-popup" />
```

## Accessibility Rules

Wrappers must preserve Base UI accessibility behavior.

Required:

- forward refs where Base UI expects refs
- expose accessible labels where needed
- keep keyboard behavior intact
- do not remove focus management
- use visible focus rings from tokens
- support `aria-*` passthrough
- include Storybook or component examples later for complex components

## Composition Rules

Preferred:

- composition over configuration
- small stable APIs
- controlled and uncontrolled support when Base UI supports both
- explicit subcomponents for complex primitives

Example:

```tsx
<Dialog.Root>
  <Dialog.Trigger asChild>
    <Button>Open</Button>
  </Dialog.Trigger>
  <Dialog.Content title="Provider setup">...</Dialog.Content>
</Dialog.Root>
```

## Product Severity UI

Severity is a product concept, not a generic UI primitive.

Use product-level components:

```text
apps/web/src/shared/product-ui/severity-badge.tsx
apps/web/src/features/review-configuration/interface/components/severity-policy-editor.tsx
```

These components may use generic `Badge` internally.

## Testing

Minimum tests for UI wrappers:

- renders with default props
- forwards `className`
- preserves accessible name
- keyboard interaction for complex components
- focus visible on interactive elements
- variant classes snapshot or explicit class assertions

## Change Rule

Changing a `packages/ui` component is a cross-product change.

Before changing a wrapper API:

- check all imports
- prefer additive props
- avoid breaking variant names
- add migration notes if needed
