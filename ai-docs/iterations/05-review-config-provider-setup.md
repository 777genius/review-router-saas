# Iteration 05 - Review Config and Provider Setup

## Goal

Add review configuration presets and provider setup guidance without storing secrets.

## Scope

- ReviewConfiguration aggregate
- config versioning
- static vs SaaS runtime config precedence
- action/config schema compatibility rules
- presets: safe default, strict security, minimal
- provider setup state model
- Codex OAuth guidance
- OpenAI/OpenRouter secret guidance
- generated workflow uses selected config
- explicit agentic-context control; invalid boolean form values must be rejected,
  not silently interpreted as disabled

## Important Defaults

- execution in customer GitHub Actions
- Codex OAuth secrets stay in repo/org secrets or runner
- fork PR secret-backed review skipped by default
- no cloud execution

## Tests

- config validation
- config version conflict
- runtime config wins when valid
- invalid/incompatible runtime config falls back or fails safely
- provider setup state transitions
- generated workflow includes selected provider settings

## Done When

- user can configure review behavior before setup PR
- user can save repository-level overrides for provider/model/effort/limits and
  clear them back to workspace inheritance
- config changes are versioned and auditable
- provider setup page clearly explains where secrets live

## Current Implementation Notes

- `features/review-config` owns the config aggregate, validation,
  workspace/repository target keys, runtime env mapping, save/find/clear use
  cases, and Prisma repository adapter.
- The dashboard exposes a workspace default form plus per-repository override
  forms for the synced repository list.
- Repository override clearing deletes the repository target record so runtime
  resolution falls back to workspace default, then safe default.
- Dashboard mutations validate the target repository still belongs to the
  workspace, is selected, is not archived, and belongs to an active GitHub App
  installation before saving or clearing a repository override.
