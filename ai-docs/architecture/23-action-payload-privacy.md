# Action Payload Privacy

## Goal

Action-to-SaaS communication must preserve the v1 boundary: no code, no diffs, no secrets.

## Allowed Health Report Fields

```text
protocolVersion
actionVersion
configVersion
configSource
repo identity from verified OIDC token
run id and attempt
workflow name
status: started | succeeded | failed | skipped
provider types, not credentials
provider health categories
finding counts by severity
comment counts
skipped reason categories
safe error code
safe error summary
startedAt / finishedAt
```

## Forbidden Fields

```text
file paths if customer config disables them later
file contents
code snippets
diff hunks
raw prompts
raw model responses
secret values
environment variables
full command output
stack traces containing env/code
```

Default v1 can include file counts and categories, not file contents.

## Size Limits

Initial maximums:

```text
OIDC exchange request: 16 KB
config response: 64 KB
health report request: 64 KB
single error summary: 2 KB
provider summary JSON: 16 KB
```

Reject oversized payloads with structured error.
For health reports, enforce the 64 KB limit at the HTTP route/body parser layer
and again inside domain validation. The domain check protects direct use-case
calls and tests; the route limit prevents wasteful oversized JSON parsing.

## Redaction

Before sending any health report, action should apply local redaction:

- known token/key patterns
- `CODEX_AUTH_JSON`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- GitHub tokens
- PEM blocks
- environment variable dumps

SaaS should also validate and reject obvious secret-looking strings. Do not rely only on client-side redaction.

## Error Categories

Prefer categories over raw errors:

```text
codex_auth_missing
codex_auth_stale
provider_command_failed
github_comment_permission_denied
fork_pr_skipped
config_fetch_failed
runtime_config_incompatible
rate_limited
unknown
```

## Tests

- health report with code-like diff is rejected
- health report with PEM/API-key-like string is rejected
- oversized report is rejected
- oversized report is rejected by route-level body limit before persistence
- safe summary is accepted
- action redacts known secret patterns before send
