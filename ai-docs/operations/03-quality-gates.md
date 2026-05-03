# Quality Gates

## Architecture Gate

Before merging any feature:

- no framework imports in domain/application
- ports defined in application where external capability is needed
- infrastructure implements ports
- no Prisma leakage outside infrastructure
- no GitHub SDK usage in use cases directly

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

## UX Gate

- every failure shown to user has next step
- setup flow explains where credentials are stored
- dashboard shows install health clearly
- no misleading token/cost data for Codex OAuth subscription mode
