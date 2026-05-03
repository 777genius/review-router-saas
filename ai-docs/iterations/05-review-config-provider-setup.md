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
- config changes are versioned and auditable
- provider setup page clearly explains where secrets live
