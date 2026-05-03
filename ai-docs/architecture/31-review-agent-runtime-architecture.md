# Review Agent Runtime Architecture

## Current Runtime Baseline

The existing `777genius/review-router` GitHub Action already contains the core review runtime.

Important current pieces:

```text
src/main.ts                         GitHub Action entrypoint
src/core/orchestrator.ts            review orchestration
src/core/batch-orchestrator.ts      file/token-aware batching
src/providers/registry.ts           provider selection
src/providers/codex.ts              Codex CLI adapter
src/github/comment-poster.ts        summary and inline comments
src/github/pr-description.ts        generated PR summary block
src/github/interaction.ts           /rr commands and discussion routing
src/discussion/codex-responder.ts   AI discussion replies
```

The SaaS should not rewrite this from scratch. It should package and configure this runtime through generated workflows.

## Runtime Boundary

```text
SaaS control plane
  -> writes workflow PR and stores config metadata
  -> never runs Codex by default
  -> never sees diff/code/provider secrets

GitHub Actions workflow in customer repo
  -> checks out PR code
  -> restores provider credentials from GitHub Secrets or persistent runner
  -> runs ReviewRouter Action/runtime
  -> posts comments/checks to GitHub
  -> reports metadata-only health to SaaS through OIDC
```

## Existing Codex Execution Model

Current Codex provider already does the important safety work:

```text
codex exec
  --model <model>
  --sandbox read-only
  --ephemeral
  --ignore-user-config
  --ignore-rules
  -c approval_policy=never
  --output-schema <schema file>
  --output-last-message <output file>
```

Config knobs already present:

```text
CODEX_MODEL
default provider from CODEX_MODEL -> codex/<model>
CODEX_REASONING_EFFORT
CODEX_AGENTIC_CONTEXT
CODEX_EVENT_AUDIT
CODEX_HEALTHCHECK_MODE
CODEX_DEPENDENCY_CONTEXT
```

The provider builds a sanitized environment for Codex:

```text
PATH
HOME
CODEX_HOME
TMPDIR/TEMP/TMP
LANG/LC_*
CI
GITHUB_WORKSPACE
OPENAI_API_KEY optional
```

It intentionally does not pass GitHub tokens, OpenRouter tokens, repository secrets, or arbitrary `INPUT_*` env to Codex.

## Agentic Context

Current Codex mode is hybrid:

```text
deterministic PR prompt
  + repository context seed
  + read-only Codex exploration
  + strict JSON findings
```

The prompt instructs Codex to inspect related files with read-only commands and only report bugs on changed lines. This should remain the default for Codex OAuth/API modes.

## Workflow Shape

SaaS-generated workflow should be thin:

```yaml
name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v6
        with:
          node-version: "24"

      - name: Install Codex CLI
        if: env.REVIEW_AUTH_MODE == 'codex-oauth' || env.REVIEW_AUTH_MODE == 'openai-api'
        run: npm install -g @openai/codex@0.125.0

      - name: Restore Codex auth
        if: env.REVIEW_AUTH_MODE == 'codex-oauth'
        run: |
          test -n "$CODEX_AUTH_JSON"
          export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"

      - uses: review-router/review-router@v1
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        env:
          REVIEW_ROUTER_SAAS_ENDPOINT: https://app.reviewrouter.dev
          REVIEW_ROUTER_CONFIG_SOURCE: saas
```

The exact action version and env are generated from SaaS config.

## Runtime Packaging Direction

Current repo has both Action and CLI artifacts. Productized architecture should keep these layers:

```text
Action wrapper
  GitHub event handling, token setup, OIDC config fetch, GitHub posting

Review runtime library/CLI
  diff planning, context, batching, provider orchestration, finding validation

Provider adapters
  Codex CLI, OpenAI API, OpenRouter, Gemini/Claude/OpenCode later
```

First implementation can keep using the existing Action entrypoint. Later, extract `review-runtime` into an internal package when the monorepo scaffold is ready.

## SaaS Config Contract

SaaS returns runtime config, not secrets:

```json
{
  "configVersion": 1,
  "authMode": "codex-oauth",
  "model": "gpt-5.5",
  "reasoningEffort": "medium",
  "providerLimit": 1,
  "codexAgenticContext": true,
  "inlineMaxComments": 5,
  "failOnSeverity": "critical"
}
```

The Action maps this to environment variables expected by the current runtime.

## Provider Secret Sources

Provider credentials come only from customer-controlled locations:

```text
GitHub Actions repo secrets
GitHub Actions org selected-repo secrets
GitHub Actions environment secrets later
trusted self-hosted runner filesystem
```

SaaS can check whether a required secret exists only by safe health metadata from the Action, not by reading the secret.

## Tests Required Before Productizing

- generated workflow maps SaaS config to current runtime env correctly
- fork PR skips secret-backed review
- same-repo PR restores Codex auth only in trusted event context
- Codex provider still excludes GitHub token from subprocess env
- OIDC config fetch failure falls back to static config
- health report never includes diff/code/secrets
- setup PR does not overwrite user-authored workflow unrelated to ReviewRouter
