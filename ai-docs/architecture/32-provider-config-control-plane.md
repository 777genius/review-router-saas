# Provider Config Control Plane

## Goal

Users must be able to manage provider, model, and reasoning effort per repository from the ReviewRouter dashboard while the actual provider credential and review execution stay inside customer CI.

## Config Modes

ReviewRouter uses a hybrid config model from day one:

```text
static snapshot in generated workflow
  + OIDC dynamic config fetch
  + static fallback when SaaS is unavailable
```

This gives reliable first-run behavior and dashboard-managed updates.

## Runtime Flow

```text
GitHub Actions workflow starts
  -> static env snapshot is already present in workflow
  -> Action requests GitHub OIDC token
  -> Action exchanges token for short-lived ReviewRouter action session
  -> Action fetches repository config from SaaS
  -> Action overlays dynamic config onto static snapshot
  -> if SaaS unavailable, Action uses static snapshot
  -> Action runs existing review-router runtime in customer CI
```

## Why Not Pure Static

Pure static config would require a setup/update PR for every dashboard change. That makes the dashboard feel fake for provider/model/effort changes.

Static still matters as fallback:

- first run works immediately after setup PR merge
- customer CI can continue if SaaS is down
- config drift is visible and recoverable

## Config Scope

Config supports inheritance:

```text
workspace default
  -> repository override
  -> workflow static fallback snapshot
```

Repository override wins over workspace default.

## Provider Config Shape

Config stores provider intent, not secret values.

```json
{
  "version": 12,
  "provider": {
    "kind": "codex",
    "authMode": "subscription_oauth",
    "model": "gpt-5.5",
    "reasoningEffort": "medium",
    "agenticContext": true
  },
  "blockingPolicy": {
    "failOnSeverity": "critical"
  },
  "limits": {
    "inlineMaxComments": 5,
    "targetTokensPerBatch": 50000
  }
}
```

Supported v1 auth modes:

```text
codex_subscription_oauth  -> CODEX_AUTH_JSON GitHub secret, Codex CLI auth_mode=chatgpt
codex_openai_api_key      -> OPENAI_API_KEY GitHub secret, Codex CLI API-key mode
openrouter_api_key        -> OPENROUTER_API_KEY GitHub secret
```

Future auth modes:

```text
anthropic_subscription_cli
anthropic_api_key
gemini_oauth_cli
gemini_api_key
custom_openai_compatible_api_key
```

Do not design the domain around only Codex. Codex is the first polished adapter, not the whole product model.

## Mapping to Existing Runtime

The existing `777genius/review-router@v1` runtime consumes env variables.

SaaS config maps to runtime env:

```text
codex_subscription_oauth:
  REVIEW_AUTH_MODE=codex-oauth
  CODEX_MODEL=<model>
  CODEX_REASONING_EFFORT=<effort>
  CODEX_AGENTIC_CONTEXT=<boolean>

codex_openai_api_key:
  REVIEW_AUTH_MODE=openai-api
  CODEX_MODEL=<model>
  CODEX_REASONING_EFFORT=<effort>
  OPENAI_API_KEY from GitHub Secret

openrouter_api_key:
  REVIEW_AUTH_MODE=openrouter-api
  REVIEW_PROVIDERS=<provider list>
  SYNTHESIS_MODEL=<model>
  OPENROUTER_API_KEY from GitHub Secret
```

## Dashboard UX

Per repository settings:

```text
Provider auth mode
Model
Reasoning effort
Agentic context
Inline comment limit
Blocking threshold
Discussion replies
PR summary update
```

Default beta values:

```text
provider: codex_subscription_oauth
model: gpt-5.5
effort: medium
agenticContext: true
failOnSeverity: critical
inlineMaxComments: 5
```

## Secret Readiness

Dashboard can show readiness but cannot read secret values.

Sources:

```text
last Action health report
setup script completion callback later
GitHub API metadata where available, never secret value
```

States:

```text
unknown
missing
configured
stale_or_invalid
unavailable_in_fork_pr
```

## OIDC Config Security

Config fetch must verify:

```text
issuer
audience
signature
expiration
repository_id maps to selected repo
repository full name matches stored repo
workflow path is expected
run id and run attempt are present
event is allowed
```

Config response must not include secrets. It may include secret names and expected source only.

## Fallback Rules

If OIDC fails:

```text
use static workflow snapshot
post safe health warning if possible
never fetch config with a long-lived token
never fail review solely because SaaS config is unavailable when static config is valid
```

If provider secret is missing:

```text
fail clearly for same-repo trusted PRs
skip clearly for fork PRs
```
