# Secret and Trust Model

## Trust Boundary

ReviewRouter has three trust zones:

```text
SaaS control plane - metadata/config only
Customer CI - review execution and provider credentials
Pull request code - potentially untrusted input
```

The dangerous boundary is where PR code runs in CI that has access to secrets.

## Fork PRs

Fork PRs are untrusted by default.

Generated workflow behavior:

- no provider secrets
- no Codex OAuth
- no OpenAI/OpenRouter API keys
- no GitHub App token with write access beyond safe skipped notification if allowed
- clear skipped message

## Same-Repository PRs

Same-repository PRs are not automatically safe. A developer with write access may be able to modify workflow files or code that executes in CI.

Recommended customer protections:

- protect default branch
- require review for workflow changes
- use CODEOWNERS for `.github/workflows/*` and `.reviewrouter/*`
- restrict who can push branches in the main repository
- prefer org selected-repo secrets for intended repositories only
- use environments or trusted runners for highly sensitive credentials

## Generated Workflow Hardening

Generated workflow should:

- use `pull_request`, not `pull_request_target`
- set minimal permissions
- use `actions/checkout` with `persist-credentials: false`
- pass GitHub tokens only to steps that need them
- sanitize provider subprocess environment where possible
- avoid printing env and command traces

## Secret Names and Secret Values

Secret values are always forbidden in SaaS payloads, logs, and health reports.

Secret names are less sensitive but still reveal provider setup. Treat them as configuration metadata.

Allowed in SaaS config:

```text
fixed expected environment variable names, e.g. CODEX_AUTH_JSON or OPENAI_API_KEY
provider type
setup source
configured state
```

Avoid returning actual GitHub secret names unless the action needs them. Prefer fixed environment variable names in generated workflow.

## Self-Hosted Runners

Self-hosted runners with persistent `CODEX_HOME` are powerful but sensitive.

Docs must warn:

- runner must be trusted
- do not use persistent Codex auth runners for untrusted fork PRs
- isolate runner by repository/org where possible
- keep runner OS patched
- avoid sharing runner between unrelated tenants

## GitHub App Token in Workflow

If workflow mints a GitHub App token for bot identity:

- scope token to current repository
- do not export token globally
- do not pass token into Codex/provider subprocess env
- expire token naturally
- never print token

## Action Trust Decision

The action must decide whether provider secrets can be used before restoring or invoking providers.

Inputs:

- GitHub event name
- repository owner/name and repository id
- pull request head repository full name/id
- pull request base repository full name/id
- fork flag from event payload where available
- configured policy from static/SaaS config

Rules:

```text
fork PR -> no secret-backed review by default
same-repository PR -> allowed only if policy permits and workflow file is trusted
manual trusted rerun -> future explicit flow only
unknown event shape -> fail closed for secret-backed providers
```

Do not rely only on branch names or user-controlled environment variables for trust decisions.

## Tests

- generated workflow has fork guard before secret/provider steps
- provider env does not contain GitHub token unless explicitly needed
- checkout uses `persist-credentials: false`
- health reports reject secret-looking values
- docs show same-repo PR caveat
- action trust decision fails closed for unknown event payload
