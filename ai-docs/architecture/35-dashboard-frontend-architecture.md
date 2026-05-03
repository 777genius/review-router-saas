# Dashboard Frontend Architecture

## Goal

Build the dashboard as a scalable product frontend, not a pile of pages.

The dashboard must support:

- onboarding
- GitHub App installation
- repository setup
- workflow provisioning PRs
- provider/model/effort configuration
- Codex OAuth setup instructions
- health checks
- audit logs
- workspace roles
- future billing

## Layering

```text
apps/web/app
  route composition only

apps/web/src/features/<feature>
  feature-first product UI with domain/application/adapters/interface boundaries

packages/ui
  reusable design system wrappers

packages/api-client
  tRPC client bindings if needed

packages/shared
  shared result/types/helpers with no framework coupling
```

Routes should stay thin. They compose feature screens and providers.

Clean Architecture details are defined in [`37-frontend-clean-architecture.md`](./37-frontend-clean-architecture.md). UI wrapper conventions are defined in [`36-ui-component-wrapper-conventions.md`](./36-ui-component-wrapper-conventions.md).

## Feature Module Shape

```text
features/repository-setup/
  domain/
  application/
  adapters/
  interface/
    components/
    hooks/
    forms/
    state/
  tests/
```

Rules:

- `domain/` and `application/` must stay framework-free.
- `adapters/` owns tRPC/browser/telemetry integration.
- `interface/forms/` owns React Hook Form + Zod integration.
- `interface/state/` is Zustand UI state only.
- `interface/components/` should receive view models, not raw transport objects, when the mapping is non-trivial.
- Shared components move to `packages/ui` only after they are used by at least two features.

## State Model

Use four explicit state categories.

| State type      | Tool                        | Examples                                             |
| --------------- | --------------------------- | ---------------------------------------------------- |
| Server state    | TanStack Query through tRPC | repo setup status, installation state, health checks |
| URL state       | nuqs                        | tabs, filters, pagination, selected repo             |
| Form state      | React Hook Form + Zod       | provider config, policy settings, invites            |
| Client UI state | Zustand                     | sidebar, command palette, onboarding drawer          |

Do not mirror server state into Zustand. If a component needs server data, it should use a query or receive query-derived props.

## Zustand Rules

Allowed:

- small UI-only stores
- feature-local stores
- shallow selectors
- explicit actions
- persisted UI preferences only when useful

Forbidden:

- storing API response objects as source of truth
- storing auth/session permissions
- storing setup completion truth
- storing provider secret status
- global store that imports every feature
- async business workflows inside the store

Recommended store shape:

```ts
type ShellUiState = {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  setSidebarCollapsed(value: boolean): void;
  setCommandPaletteOpen(value: boolean): void;
};
```

## Base UI Usage

Use `@base-ui/react` through internal wrappers:

```text
packages/ui/src/dialog.tsx
packages/ui/src/dropdown-menu.tsx
packages/ui/src/tabs.tsx
packages/ui/src/toast.tsx
packages/ui/src/select.tsx
```

App features should import:

```ts
import { Dialog } from "@reviewrouter/ui/dialog";
```

They should not import Base UI primitives directly unless building a new wrapper inside `packages/ui`.

## Styling

Use Tailwind CSS for application styling and design tokens.

The visual direction is cyberpunk-future command center. See [`../product/08-visual-direction.md`](../product/08-visual-direction.md).

Use CSS variables for brand tokens. Initial core token names:

```text
--rr-bg
--rr-surface
--rr-text
--rr-muted
--rr-accent
--rr-danger
--rr-warning
--rr-success
```

Avoid locking product UI to a third-party visual theme.

## Data Fetching

Use tRPC for dashboard-facing API calls.

Query conventions:

- query keys stay generated/centralized through tRPC helpers
- mutations invalidate narrow affected queries
- long-running setup steps poll by status endpoint
- optimistic updates only for pure UI convenience, never for setup truth

## Setup Flow

Setup flow must be backend-owned.

The frontend displays:

- current step
- exact commands to run
- last verification result
- next action

The backend owns:

- setup state machine
- repository eligibility
- provider setup status
- generated workflow version
- audit events

## Testing

Minimum frontend test strategy:

- unit tests for view-model mappers
- component tests for setup step rendering
- form validation tests for provider config
- store tests for Zustand UI stores
- Playwright smoke for onboarding happy path
- accessibility checks for critical setup screens

## Open Frontend Decisions

Still to decide before implementation:

- chart library final choice after first dashboard analytics screen
- whether to use TanStack Table immediately or defer until tables need sorting/filtering
- whether to persist Zustand UI preferences in local storage from day one
