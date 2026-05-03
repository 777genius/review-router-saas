# Frontend Clean Architecture

## Goal

Apply the same engineering discipline to the dashboard that we apply to the backend:

- feature-first boundaries
- Clean Architecture dependency direction
- DDD where business logic exists
- ports/adapters for external dependencies
- SOLID module responsibilities
- DRY without premature abstraction

## Important Constraint

The frontend is not the source of truth for business state.

The backend owns:

- setup state machine
- authorization
- repository eligibility
- provider setup status
- workflow provisioning status
- audit events

The frontend owns:

- presentation
- user interaction
- form validation before submit
- URL state
- client UI state
- view-model mapping

## Standard Feature Structure

For features with meaningful business/UI logic:

```text
apps/web/src/features/<feature>/
  domain/
    entities/
    value-objects/
    policies/
    errors.ts

  application/
    use-cases/
    ports/
    mappers/
    view-models/

  adapters/
    trpc/
    browser-storage/
    telemetry/

  interface/
    components/
    hooks/
    forms/
    state/
    routes/

  tests/
    unit/
    component/
    integration/
```

Small display-only features may collapse folders, but they must not violate dependency direction.

## Dependency Direction

```text
domain <- application <- interface
application -> ports <- adapters
```

Allowed:

- domain imports shared primitives only
- application imports domain, application ports, shared utilities
- adapters import application ports and concrete clients
- interface imports application use cases, adapters, hooks, UI wrappers

Forbidden:

- domain importing React
- domain importing tRPC/TanStack Query
- application importing React components
- application importing Next.js routing
- application importing Zustand stores
- application importing Base UI
- adapters importing React components
- `packages/ui` importing product features

## Example: Repository Setup

```text
features/repository-setup/
  domain/
    setup-step.ts
    setup-status.ts
    setup-policy.ts
  application/
    ports/
      repository-setup-gateway.ts
      clipboard-port.ts
    use-cases/
      build-setup-command.ts
      select-next-setup-step.ts
    mappers/
      to-setup-view-model.ts
  adapters/
    trpc/
      trpc-repository-setup-gateway.ts
    browser/
      browser-clipboard-adapter.ts
  interface/
    components/
      RepositorySetupPage.tsx
      SetupStepCard.tsx
      SetupCommandBlock.tsx
    hooks/
      useRepositorySetupScreen.ts
    state/
      repositorySetupUiStore.ts
```

## Ports

Frontend ports are useful when logic needs external capabilities.

Examples:

```ts
export interface ClipboardPort {
  copy(text: string): Promise<void>;
}

export interface RepositorySetupGateway {
  getSetupStatus(repoId: string): Promise<RepositorySetupStatus>;
  createSetupPullRequest(repoId: string): Promise<SetupPullRequestResult>;
}
```

Do not create ports for everything. Create them when they improve testability or isolate a framework/API.

## SOLID Mapping

Single Responsibility:

- components render one concept
- mappers map transport data to view models
- stores hold UI state only
- gateways call remote APIs only

Open/Closed:

- provider setup screens use provider descriptors, not switch statements scattered through components
- new provider UI should add a descriptor/adapter, not rewrite the setup page

Liskov Substitution:

- fake ports in tests must behave like real adapters
- all provider descriptors must satisfy the same UI contract

Interface Segregation:

- split ports by use case
- do not create `DashboardGateway` with every method

Dependency Inversion:

- application depends on ports
- adapters implement ports
- components compose the concrete wiring

## Zustand Placement

Zustand stores live under:

```text
interface/state/
```

They may store:

- drawer open/closed
- selected local panel
- dismissed local hints
- command palette state
- temporary UI preferences

They may not store:

- API response source of truth
- auth/session
- permissions
- setup completion
- workflow status
- provider secret health

Zustand actions should be synchronous unless there is a strong reason. Async business flows belong in application use cases or TanStack Query mutations.

## DRY Rule

Use this order:

1. duplicate once when the abstraction is not clear
2. extract within the feature after the second real use
3. move to shared/product UI after two features use it
4. move to `packages/ui` only when it is product-agnostic

This avoids both copy-paste drift and premature shared abstractions.

## Testing Strategy

Unit tests:

- domain policies
- application use cases
- view-model mappers
- Zustand store reducers/actions

Component tests:

- setup screen rendering
- form validation
- disabled/error states
- accessibility-critical flows

Integration tests:

- feature screen with mocked tRPC adapters
- onboarding happy path

E2E:

- connect GitHub App mock/staging path
- create setup PR path
- provider setup command copy path
- health status refresh path

## Review Checklist

Before merging frontend code:

- Does the component import Base UI directly? If yes, should it move to `packages/ui`?
- Is server state stored in Zustand? If yes, fix it.
- Is a route doing business logic? If yes, move it to feature application/interface hooks.
- Does application code import React/Next/tRPC? If yes, dependency direction is wrong.
- Is a shared component product-specific? If yes, keep it out of `packages/ui`.
