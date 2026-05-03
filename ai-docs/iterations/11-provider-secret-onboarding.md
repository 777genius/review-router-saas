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

## Implemented Baseline

- `features-provider-setup` generates provider setup guidance without embedding secret values.
- Dashboard renders provider-specific commands for the primary selected repository.
- Codex OAuth setup uses `scripts/seed-codex-auth.sh` instead of asking users to paste `auth.json` into the SaaS UI.
- The seed script supports:
  - repository Actions secret
  - organization selected-repository Actions secret
  - custom `CODEX_HOME` / auth file paths
  - optional `CODEX_CONFIG_TOML`
  - dry-run mode
- The seed script validates `auth.json` before writing secrets:
  - JSON parses
  - `auth_mode = chatgpt`
  - `tokens.refresh_token` exists
- Shell-level tests use a fake `gh` binary and temporary fake Codex home to verify commands do not leak the auth JSON/token in output.

## Verification

```bash
bash -n scripts/seed-codex-auth.sh
pnpm test -- spikes/github-oidc/tests/seed-codex-auth.test.ts
```
