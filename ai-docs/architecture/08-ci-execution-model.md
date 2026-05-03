# CI Execution Model

## Default Execution

ReviewRouter review execution runs in the customer's CI/CD.

```text
pull_request event
  -> GitHub Actions workflow in customer repo
      -> checkout code
      -> restore provider auth from repo/org secrets or runner env
      -> run ReviewRouter Action
      -> run provider CLI/API
      -> post comments/status to PR
```

## Why CI Execution

- keeps private code in customer environment
- keeps Codex OAuth outside SaaS
- shifts heavy LLM/runtime load away from ReviewRouter servers
- aligns with enterprise privacy needs
- gives customers control over runners/network/policies

## Codex OAuth Mode

Workflow restores:

```text
CODEX_AUTH_JSON
CODEX_CONFIG_TOML optional
CODEX_HOME optional
```

The action should validate auth early and fail with a clear message when refresh/login is needed.

For self-hosted runners, persistent `CODEX_HOME` can allow the CLI to refresh and keep auth state across jobs if the runner is trusted and configured correctly.

## API Key Modes

OpenAI/OpenRouter API keys are simpler for CI:

```text
OPENAI_API_KEY
OPENROUTER_API_KEY
```

These can be repo/org secrets and used only in trusted workflows.

## Fork PR Safety

Secret-backed review should skip untrusted fork PRs by default.

Expected user-visible behavior:

```text
ReviewRouter skipped secret-backed review because this pull request comes from a fork and secrets are unavailable by default.
```

Maintainer can use a trusted rerun/manual flow later if needed.

## Reporting Back to SaaS

v1 should support metadata-only reporting through GitHub Actions OIDC, but review execution must still work from static workflow config if OIDC is unavailable.

Allowed reporting:

- workflow run id
- review status
- provider health summary
- installed action version
- config version used
- no code/diff/secrets

This enables dashboard health without compromising privacy.
