# Testing Strategy

## Test Pyramid

```text
Unit tests - domain and application use cases
Integration tests - Prisma repositories, locks, jobs, GitHub adapters with mocks
Contract tests - workflow YAML, OIDC claims, webhook payload fixtures
E2E smoke - real GitHub test repo when explicitly enabled
```

## Unit Tests

Must cover:

- domain invariants
- config validation
- authorization policies
- workflow provisioning state machine
- provider setup state transitions
- entitlement decisions

No network or database.

## Integration Tests

Use test Postgres for:

- Prisma repositories
- transactions
- optimistic config versioning
- lease locks
- webhook delivery idempotency
- webhook normalization excludes PR/comment bodies
- outbox processing
- pg-boss jobs

## GitHub API Tests

Use fixtures and HTTP mocks for most tests.

Required fixtures:

```text
installation.created
installation.deleted
installation_repositories.added
pull_request.opened
repository.renamed
workflow provisioning branch exists
permission denied
rate limit
```

## OIDC Contract Tests

Must cover:

- valid GitHub OIDC claims accepted
- wrong audience rejected
- expired token rejected
- repository mismatch rejected
- unselected repo rejected
- fork/unsafe context handled according to policy

Use local JWT signing fixtures for unit/contract tests and one gated real OIDC test later.

## E2E Smoke Tests

Gated by env vars, never required for normal unit CI:

```text
RUN_GITHUB_E2E=1
GITHUB_TEST_ORG
GITHUB_TEST_REPO
REVIEWROUTER_TEST_APP_ID
```

Scenarios:

- install app to test repo
- sync repo
- create setup PR
- merge or inspect generated workflow
- trigger PR workflow manually or via test PR
- verify dashboard health metadata if OIDC protocol enabled

## Regression Tests for Critical Bugs

Every production incident must add at least one test around:

- duplicate side effects
- authorization bypass
- secret/log leakage
- workflow generation error
- GitHub permission/rate-limit handling
