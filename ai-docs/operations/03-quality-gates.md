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
- local DB smoke for repository config override -> clear -> workspace fallback
- local DB smoke for support diagnostics access audit and safe metadata summary
- lint
- format check
- typecheck
- production build
- `git diff --check`

The default CI workflow must not require GitHub App private keys, Codex OAuth files, provider API keys, ngrok, or real customer repositories. Real GitHub E2E remains a local/staging smoke step because it depends on a disposable GitHub App installation and selected test repository.

## Local Beta Gate

Before handing the MVP to a trusted tester, run:

```bash
pnpm beta:check
```

Include local DB/protocol smoke:

```bash
REVIEW_ROUTER_BETA_CHECK_DB_E2E=1 pnpm beta:check
```

Then run at least one real GitHub smoke:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=setup pnpm beta:check
```

Before public demo or Reddit launch, run the full review smoke:

```bash
REVIEW_ROUTER_BETA_CHECK_REAL_GITHUB=review pnpm beta:check
```

Passing setup-only smoke proves GitHub App installation, repository sync,
workflow provisioning PR creation/merge, and workflow health probing. Passing
full-review smoke proves Codex OAuth seeding, customer-CI execution, action
runtime config, blocking status, and inline comments.

Do not mark the MVP as showable if the latest full-review smoke is older than
the latest action runtime or workflow provisioning change.

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
- runbooks explain how to recover from failed setup PR, missing workflow,
  missing provider secret, and absent inline comments
