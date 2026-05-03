# Quality Gates

## Architecture Gate

Before merging any feature:

- no framework imports in domain/application
- ports defined in application where external capability is needed
- infrastructure implements ports
- no Prisma leakage outside infrastructure
- no GitHub SDK usage in use cases directly

Automated guardrail:

```bash
pnpm test -- packages/shared/src/tests/architecture-boundaries.test.ts
```

This test scans `packages/features/*/src/domain` and `packages/features/*/src/application` so adapter/framework imports fail before review. If a legitimate new adapter is added, put it under `infrastructure` or `interface` and expose it through an application port.

## CI Gate

Every pull request and `main` push must run:

- Prisma migrations against CI dev/test databases
- fresh migration smoke on a temporary database
- local readiness checks
- unit tests
- GitHub/OIDC contract tests that do not require real secrets
- lint
- format check
- typecheck
- production build
- `git diff --check`

The default CI workflow must not require GitHub App private keys, Codex OAuth files, provider API keys, ngrok, or real customer repositories. Real GitHub E2E remains a local/staging smoke step because it depends on a disposable GitHub App installation and selected test repository.

## Security Gate

- no secrets in logs
- no request/response body capture for telemetry by default
- no raw webhook payload capture by default
- no code/diff storage unless explicitly approved by design
- webhook signature verified
- permissions explained if changed
- fork PR secret safety preserved in generated workflow

## Reliability Gate

- webhook/job side effects are idempotent
- concurrent provisioning cannot create duplicate PRs
- external failures persist actionable error summary
- tests cover retry or duplicate scenario for critical jobs
- outbox dead-letter retry and stale processing recovery have DB-backed smoke coverage

## UX Gate

- every failure shown to user has next step
- setup flow explains where credentials are stored
- dashboard shows install health clearly
- no misleading token/cost data for Codex OAuth subscription mode
