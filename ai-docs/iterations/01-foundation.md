# Iteration 01 - Foundation

## Goal

Create the monorepo and baseline architecture skeleton.

## Scope

- pnpm workspace
- Turborepo
- TypeScript config
- lint/test/format
- apps/web
- apps/api
- apps/worker
- `packages/ui` with Base UI wrapper convention
- dashboard design tokens and Tailwind CSS setup
- Zustand shell UI store skeleton
- packages/platform
- packages/features
- packages/shared
- Prisma/Postgres local dev
- Docker Compose for local Postgres

## Architecture Tasks

- create feature template structure
- create frontend feature template with domain/application/adapters/interface boundaries
- create initial UI tokens and wrapper examples: Button, Card, Dialog, Badge, CodeBlock
- create frontend state ownership examples: TanStack Query server state, Zustand UI state, nuqs URL state
- create dependency boundary lint rules if practical
- create shared `Result`/error utilities
- create logger port and adapter
- create config/env validation
- create API error contract utilities
- create versioned schema convention for action protocol
- create initial data classification helper/checklist
- create database constraint/index conventions

## Tests

- basic unit test setup
- one example feature test
- dependency boundary smoke test
- migration applies to empty and seeded DB
- CI pipeline for lint/typecheck/test/build

## Done When

- local dev starts web/api/worker
- Prisma connects to local Postgres
- test/typecheck pass
- feature structure is documented in repo
