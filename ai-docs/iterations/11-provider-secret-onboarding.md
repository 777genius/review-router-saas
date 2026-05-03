# Iteration 11 - Provider Secret Onboarding

## Goal

Make provider setup copy-pasteable while preserving the v1 rule that ReviewRouter SaaS never receives Codex OAuth or API-key secrets.

## Scope

- domain command builder for provider secret setup
- Codex OAuth command guidance for repository secrets
- Codex OAuth command guidance for organization selected-repository secrets
- API-key provider commands without embedding secret values
- dashboard setup panel for the primary selected repository in a workspace

## Architecture

Provider setup guidance is pure domain/application code. It does not depend on React, Prisma, GitHub SDKs, or shell execution.

The dashboard renders generated commands, but does not collect or submit secret values.

## Security Rules

- never render secret values
- never ask users to paste `auth.json` into the SaaS UI
- prefer organization selected-repository secrets for organization repositories
- explain fork PR secret behavior near setup commands

## Tests

- Codex OAuth org command uses selected repo scope
- repo command stores directly in GitHub repository secrets
- generated commands do not embed `CODEX_AUTH_JSON` or API-key values

## Done When

- a user can understand where provider credentials live from the dashboard
- generated commands are deterministic and safe to copy
