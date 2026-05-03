# ADR-003: Fastify + tRPC + Next.js

## Status

Accepted.

## Decision

Use:

- Next.js for dashboard UI
- Fastify for backend HTTP server
- tRPC for internal dashboard API
- plain Fastify routes for GitHub webhooks and public endpoints

## Rationale

NestJS was considered but rejected for v1 because it adds ceremony and risks pushing business logic into framework services. Hono was considered but Fastify is a better fit for a long-running Node SaaS backend with plugins, webhooks, jobs, and observability.

Fastify + tRPC gives structure without forcing a heavy framework into domain/application.

## Boundaries

Allowed:

- Fastify in `interface/http`
- tRPC in `interface/trpc`
- Next.js in `apps/web`

Forbidden:

- Fastify/tRPC/Next imports in `domain` or `application`

## Consequences

Positive:

- type-safe dashboard API
- mature Node HTTP backend
- clean separation of public webhooks from dashboard RPC
- future migration path remains open

Negative:

- more moving parts than Next-only
- must maintain app/api and app/web integration
- tRPC is not ideal for public external APIs, so public endpoints must stay plain HTTP
