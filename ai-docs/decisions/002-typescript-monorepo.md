# ADR-002: TypeScript Monorepo

## Status

Accepted.

## Decision

Use TypeScript and a pnpm/Turborepo monorepo for ReviewRouter SaaS.

## Rationale

ReviewRouter Action and installer work are already TypeScript/Node-oriented. The SaaS also needs dashboard UI, GitHub API integration, workflow generation, and shared config schemas. TypeScript reduces context switching and lets us share types safely.

## Planned Monorepo Shape

```text
apps/
  web/
  api/
  worker/

packages/
  platform/
  features/
  shared/
```

## Consequences

Positive:

- one language for UI/API/worker
- easy sharing of config schemas and DTOs
- strong ecosystem for GitHub/Octokit/tRPC/Next
- fast MVP velocity

Negative:

- requires discipline to avoid framework soup
- Node worker concurrency must be explicit
- backend reliability depends on solid architecture and tests

## Reversal Path

If needed later, API/worker can be rewritten in Go because feature application layers depend on ports, not Fastify/Prisma directly.
