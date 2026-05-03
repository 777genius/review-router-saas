# ADR-015: Dashboard Frontend Stack

## Status

Accepted.

## Context

ReviewRouter needs a dashboard that will grow beyond a simple settings page:

- GitHub App installation flow
- repository setup status
- workflow provisioning PR state
- provider/model/effort configuration
- Codex OAuth secret seeding guidance
- health checks and audit logs
- team membership and permissions
- future billing and plan management

The frontend should be accessible, composable, and not locked into a heavy visual component framework. It should also keep server state, URL state, form state, and local UI state clearly separated.

## Decision

Use this frontend stack:

```text
Framework: Next.js App Router
Language: TypeScript
Headless UI primitives: Base UI
Styling: Tailwind CSS
Internal UI package: packages/ui
Component variants: tailwind-variants for multi-slot components
Server state: TanStack Query through tRPC
Client UI state: Zustand
URL state: nuqs
Forms: React Hook Form + Zod
Notifications: Sonner
Tables: TanStack Table when tables become complex
Charts: Recharts first, replaceable later
```

Base UI package:

```text
@base-ui/react
```

Do not use the older package coordinate:

```text
@base-ui-components/react
```

That package line is behind the current Base UI release line.

## Why Base UI

Base UI is headless and unstyled, which matches ReviewRouter's need for a custom SaaS design system. It gives accessible primitives while leaving markup, styling, and product visual language under our control.

Current verified status:

```text
GitHub repo: mui/base-ui
Latest GitHub release observed: v1.4.1
Current npm package: @base-ui/react
```

Base UI is still newer than Radix in ecosystem age, so the decision is not "Base UI everywhere forever". The architecture must isolate primitives behind `packages/ui` wrappers so primitives can be swapped if needed.

## State Ownership Rules

Server state belongs to TanStack Query/tRPC:

- repositories
- installations
- setup status
- workflow PR status
- provider configuration
- health checks
- audit records

URL state belongs to nuqs:

- selected tab
- filters
- search
- pagination
- selected repository in shareable views

Form state belongs to React Hook Form + Zod:

- provider setup forms
- policy forms
- workspace invites
- billing forms later

Client UI state belongs to Zustand:

- sidebar collapsed state
- command palette open state
- onboarding drawer state
- transient setup checklist UI state
- locally dismissed UI hints
- cross-layout UI preferences

Zustand must not own:

- setup truth
- GitHub installation truth
- repository sync truth
- auth/session truth
- permission truth
- provider secret status truth
- action run truth

Those are backend/domain facts and must come from API queries.

## Frontend Architecture Rule

Use feature-first frontend modules, not page-level god components.

```text
apps/web/
  app/
  src/
    features/
      github-installations/
      repository-setup/
      provider-setup/
      review-configuration/
      audit-log/
      workspace-members/
    shell/
    shared/

packages/
  ui/
  web-config/
```

Each frontend feature should contain:

```text
components/
hooks/
queries/
forms/
state/
types/
```

Feature-level Zustand stores are allowed only for UI state. Shared stores require explicit review.

Detailed rules:

- [`../architecture/35-dashboard-frontend-architecture.md`](../architecture/35-dashboard-frontend-architecture.md)
- [`../architecture/36-ui-component-wrapper-conventions.md`](../architecture/36-ui-component-wrapper-conventions.md)
- [`../architecture/37-frontend-clean-architecture.md`](../architecture/37-frontend-clean-architecture.md)
- [`../product/08-visual-direction.md`](../product/08-visual-direction.md)

## Consequences

Benefits:

- strong accessibility baseline
- custom brand without fighting a visual framework
- clear separation between server state and UI state
- scalable frontend module boundaries
- easy future replacement of UI primitives through `packages/ui`

Costs:

- we must build and maintain our own visual component layer
- Base UI is newer than Radix, so we need dependency discipline
- Zustand can become a dumping ground if boundaries are not enforced

Mitigations:

- expose Base UI only through `packages/ui`
- keep all API state in TanStack Query
- keep setup state backend-owned
- add lint/import boundaries once app code exists
- document every shared Zustand store and its allowed state shape
