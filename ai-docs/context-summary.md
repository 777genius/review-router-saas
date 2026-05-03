# Context Summary

## Existing Background

ReviewRouter started from work around `keithah/multi-provider-code-review`, which was useful as an experimental base but had signs of low adoption and broad, potentially fragile feature claims.

The current direction is to evolve ReviewRouter into a more focused, production-oriented product:

- multi-provider AI pull request review
- Codex CLI OAuth support for ChatGPT subscription users
- API-key modes for OpenAI/OpenRouter and later other providers
- GitHub App identity for clean bot comments
- signed human override ledger for `/rr skip`
- agentic Codex review running read-only inside checkout
- deterministic diff seed plus optional agentic context discovery
- deduplication and revalidation to avoid duplicate comments
- strong installer and workflow provisioning

## SaaS Direction

The SaaS should not run review workloads by default. The product is a control plane:

- install one shared GitHub App
- manage workspaces, repositories, policies, and config
- create/update workflow PRs
- show health and audit
- guide secret setup
- keep customer review execution inside customer CI/CD

This addresses two main concerns:

1. Server load stays low because LLM/review execution does not run on our servers.
2. Trust story is stronger because code and Codex OAuth secrets stay in the customer environment.

## Customer Credential Model

Codex OAuth subscription:

- stored only in customer GitHub repo/org secrets or self-hosted runner `CODEX_HOME`
- never sent to ReviewRouter SaaS in v1
- used by ReviewRouter Action inside customer's GitHub Actions

OpenAI/OpenRouter API key:

- v1 default: store in GitHub secrets, not SaaS
- future: optional encrypted BYOK in SaaS for cloud execution or secret orchestration

ReviewRouter cloud managed execution:

- not v1
- optional future product tier
- should use API billing/managed credits, not customer ChatGPT OAuth custody

## Why This Can Be a SaaS

The paid value is not raw compute. The paid value is operational control:

- easy GitHub App install
- one dashboard for many repos
- central policies
- per-repository provider/model/effort overrides with workspace inheritance
- config rollout
- workflow update PRs
- audit logs
- human override ledger UI
- health checks
- provider setup guidance
- team permissions
- future compliance/enterprise controls

## Current Recommended Technical Stack

- TypeScript
- Next.js dashboard
- Base UI for headless accessible primitives
- Tailwind CSS for styling
- Zustand for small reusable client UI state
- TanStack Query through tRPC for server state
- nuqs for URL state
- React Hook Form + Zod for forms
- Fastify backend
- tRPC dashboard API
- plain Fastify webhook routes
- PostgreSQL
- Prisma ORM
- pg-boss jobs
- Postgres lease locks
- Octokit
- Zod
- feature-first DDD/Clean Architecture
- frontend feature-first Clean Architecture with Base UI wrappers, explicit ports/adapters, and Zustand limited to client UI state

## Product Visual Direction

ReviewRouter dashboard should feel like a cyberpunk-future command center:

- dark, high-contrast operational surface
- neon cyan/magenta/lime accents used sparingly
- terminal/code-review clarity, not game UI chaos
- visible status, severity, health, and audit signals
- accessible contrast and keyboard-first interactions

## Main Product Bet

ReviewRouter should position as:

> Privacy-first AI code review routing for teams that want Codex, OpenAI, OpenRouter, and other providers while keeping review execution inside their own CI/CD.

## Latest Implementation State

- Review config is versioned and resolves in order:
  repository override -> workspace default -> safe default.
- Dashboard can save workspace defaults, save repository overrides, and clear a
  repository override back to workspace inheritance.
- Runtime config fetch revalidates the action session against the stored
  repository by immutable GitHub repository id before returning config.
