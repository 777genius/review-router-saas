# Technical Risk Notes

## Prisma Boundary Risk

Prisma generated types can easily leak into application/domain code.

Controls:

- repositories map Prisma records to domain objects
- domain ids/value objects are explicit
- no Prisma imports in feature domain/application

## tRPC Boundary Risk

tRPC routers can become business logic containers.

Controls:

- tRPC procedures call application command/query handlers only
- no direct Prisma/Octokit calls in routers

## Fastify Plugin Risk

Fastify plugins can become hidden dependency graph.

Controls:

- composition root wires dependencies explicitly
- feature interface modules expose route registration functions

## DDD Ceremony Risk

Too many classes can slow simple features.

Controls:

- use rich aggregates only where invariants exist
- small features may use fewer files
- dependency direction matters more than folder count

## Queue Retry Risk

Retries can duplicate side effects if handlers are not idempotent.

Controls:

- job idempotency keys
- DB state checks before external side effects
- external operation result records
