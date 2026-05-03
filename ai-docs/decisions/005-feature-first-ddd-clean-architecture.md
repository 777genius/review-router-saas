# ADR-005: Feature-First DDD and Clean Architecture

## Status

Accepted.

## Decision

Use feature-first bounded contexts. Each feature owns its own domain/application/ports/infrastructure/interface layers.

## Rationale

A global `domain/`, `application/`, `adapters/` layout becomes hard to navigate as the product grows. Feature-first keeps bounded contexts isolated and makes ownership clearer.

## Standard Feature Layout

```text
features/<feature>/
  domain/
    entities/
    value-objects/
    aggregates/
    domain-events/
    services/
    errors.ts

  application/
    commands/
    queries/
    handlers/
    ports/
    policies/

  infrastructure/
    prisma/
    github/
    queue/
    locks/

  interface/
    http/
    trpc/
    jobs/

  tests/
```

Small features may collapse files, but not dependency direction.

## Ports Placement

Ports generally belong to `application/ports`, not `domain`.

Reason: use cases define what external capabilities they need. Infrastructure implements those capabilities.

Exception: if a repository is part of a domain invariant and needs to be expressed as a domain concept, it may live in domain, but default is application ports.

## Dependency Rule

```text
domain <- application <- interface
application -> ports <- infrastructure
```

## Consequences

Positive:

- bounded contexts remain isolated
- easier testing
- easier future extraction
- framework replacement remains possible

Negative:

- more folders
- requires discipline and code review
- may feel heavy for tiny features
