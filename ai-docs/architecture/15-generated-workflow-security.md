# Generated Workflow Security

## Default Event Model

Use `pull_request` for review execution.

Do not use `pull_request_target` for default review execution because ReviewRouter checks out and inspects PR code. `pull_request_target` can run with base-repository privileges and is dangerous when combined with untrusted code checkout.

## Recommended Trigger

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

Optional later:

```yaml
workflow_dispatch:
```

Manual dispatch can support trusted maintainer reruns.

## Interaction Workflow Guard

Interaction workflows for `/rr` commands, discussion replies, and memory
commands must fail closed before allocating a runner for comments that cannot
produce useful work.

Required generated job guard:

```yaml
if: ${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}
```

Reason:

- issue comments outside pull requests do not have review context;
- bot comments must not recursively trigger ReviewRouter replies;
- `workflow_dispatch` remains available for trusted manual debugging.

Do not use a broad GitHub Actions `concurrency` group for all interaction
events. GitHub only keeps one running and one pending job per group, so a burst
can cancel older pending jobs and drop legitimate `/rr skip`, `/rr remember`, or
maintenance commands. Prefer runtime-level idempotency, per-thread reply
markers, per-PR/thread caps, and SaaS OIDC rate limits.

AI discussion replies use the same privacy boundary as review execution. The
generated caller workflow passes `CODEX_AUTH_JSON`, `CODEX_CONFIG_TOML`, or
`OPENAI_API_KEY` directly from the customer's GitHub Actions secrets to the
ReviewRouter runtime workflow. Model and reasoning selection are passed as
non-secret workflow variables, so the runtime contract stays explicit without
moving prompts or credentials into SaaS. ReviewRouter SaaS stores only
configuration intent and safe metadata; it must not receive provider
credentials, prompts, raw thread text, model responses, code, or diffs.

## Default Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
```

Rationale:

- `contents: read` for checkout/diff context
- `pull-requests: write` for review comments/status interactions where supported
- `issues: write` because PR comments often use issue comment APIs
- `id-token: write` for SaaS config/health OIDC protocol

Reduce permissions when selected identity/config does not need them.

## Fork Pull Requests

Default behavior:

```text
if pull request is from a fork:
  do not restore provider secrets
  do not run Codex/OpenAI/OpenRouter secret-backed review
  publish clear skipped result if token permissions allow
```

Reason:

- fork PR code is untrusted
- GitHub secrets are not available to fork PRs by default
- trying to bypass this safely requires explicit maintainer action

## Same-Repository PRs

Secret-backed review can run for same-repository PRs when:

- repository is selected in ReviewRouter
- workflow is installed
- provider setup state exists
- configured secrets are available

## App Bot Identity

If using GitHub App bot identity from CI:

- mint installation token only for the current repository
- request only comment/status permissions needed
- never expose token to review provider subprocess environment
- do not persist token in checkout credentials unless required

## Checkout Guidance

Use safe checkout defaults:

```yaml
- uses: actions/checkout@v6
  with:
    persist-credentials: false
```

If a later step needs a token for GitHub API, pass it only to that step.

## Template Input Validation

Generated workflow rendering must validate values before producing YAML:

- `actionRef` must be `owner/repo@ref` with no whitespace or shell/YAML syntax
- `apiUrl` must parse as `https`, or `http` only for localhost development
- `apiUrl` must not include username, password, query, or fragment
- static env keys must match GitHub Actions env-name shape: `^[A-Z_][A-Z0-9_]*$`
- env values, including first-party ReviewRouter values, must be JSON-quoted

This protects the setup PR path from accidentally turning user/config input into
extra YAML steps or permissions.

Dashboard workflow provisioning must also fail closed in production when no
public API URL is configured. Local development may default to
`http://localhost:4000`, but production must require
`REVIEW_ROUTER_PUBLIC_API_URL` or `REVIEW_ROUTER_API_URL` and reject localhost,
plain remote HTTP, credentials, query strings, and fragments before a setup PR
is created.

Workflow provisioning failures stored in DB/audit must be safe summaries, not
raw adapter exception text. GitHub API failures should be reduced to status
categories such as `github_api_error:403`; raw messages can contain request
context and must stay out of dashboard-visible state.

## Manual Trusted Review Later

Future explicit flow:

- maintainer comments `/rr review trusted` or clicks dashboard rerun
- ReviewRouter verifies maintainer/admin permission
- trusted workflow runs with secrets
- run is audited

Do not add this implicitly in v1 unless security is fully designed.

## Tests

- generated workflow never uses `pull_request_target` by default
- fork PR condition skips secret-backed provider steps
- same-repo PR condition runs provider steps
- generated workflow contains `id-token: write` when SaaS config sync is enabled
- generated workflow uses minimal permissions for selected mode
- unsafe action ref, API URL, or static env key is rejected before YAML rendering
