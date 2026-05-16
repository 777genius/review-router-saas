# ADR-019: Balanced Memory Bounded Context

## Status

Accepted.

## Decision

Balanced Memory lives in `@reviewrouter/features-memory` as a feature-first
bounded context with domain, application, ports, infrastructure, interface and
tests. Domain and application code must not import Prisma, Fastify, Next.js,
React, GitHub SDKs, OpenAI SDKs or vector database SDKs.

## Rationale

Memory policy combines privacy, authorization, retention, search, audit and UI.
Keeping these rules inside a bounded context prevents dashboard routes, action
routes or Prisma adapters from becoming the source of truth.

## Dependency Direction

```text
domain <- application <- interface
application -> ports <- infrastructure
```

## Rules

- Business rules live in domain/application use cases.
- External systems are accessed through application ports.
- Prisma adapters are infrastructure only.
- Next.js, Fastify and workflow code compose adapters, but do not own memory
  rules.
- Architecture boundary checks must include memory domain/application files.

## Consequences

Positive:

- vector store, embedding provider or database adapter can change later
- tests can cover policy without real GitHub or Postgres
- privacy-sensitive rules are easier to audit

Negative:

- more explicit ports and DTOs
- small UI/API changes sometimes need application-level changes first
