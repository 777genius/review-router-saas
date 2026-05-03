# Implementation Principles

## Keep It Boring Where Possible

Use boring infrastructure first:

- PostgreSQL
- Prisma
- Fastify
- tRPC
- pg-boss
- Octokit

Avoid adding Kafka, Kubernetes, Redis, or cloud review workers until a real constraint appears.

## Domain Where It Matters

Use rich DDD only where invariants exist:

- Workspace
- GitHubInstallation
- RepositoryConnection
- ReviewConfiguration
- WorkflowProvisioning
- ProviderSetup
- Entitlement

Use simple append-only models for audit/logging.

## No Framework Leakage

Fastify, tRPC, Next.js, Prisma, and Octokit are adapters. They are not the product core.

## Idempotency Before Features

For GitHub/SaaS integrations, correctness under retry matters more than feature count.

## User-Facing Errors Must Be Actionable

Every operational failure should answer:

- what failed
- why it likely failed
- what the user should do next
- whether retry is safe

## Follow The Playbook

Implementation agents should use [`../IMPLEMENTATION_PLAYBOOK.md`](../IMPLEMENTATION_PLAYBOOK.md) as the executable build sequence.

Do not implement future phases early just because the architecture mentions them. Each iteration should leave the product in a better tested state without skipping dependency boundaries.
