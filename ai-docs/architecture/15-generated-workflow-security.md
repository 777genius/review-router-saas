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
