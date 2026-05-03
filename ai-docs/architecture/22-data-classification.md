# Data Classification

## Purpose

ReviewRouter's privacy promise depends on knowing exactly which data classes can enter SaaS systems.

## Data Classes

### Public/Low Sensitivity

Examples:

- public marketing docs
- public release versions
- public GitHub App metadata

Handling:

- normal logs allowed
- no special retention beyond product needs

### Customer Metadata

Examples:

- GitHub user id/login/avatar URL
- GitHub organization login/avatar URL
- repository id/name/visibility/default branch
- installation id
- workflow/action version
- config version
- provider type and setup state

Handling:

- allowed in SaaS v1
- access controlled by workspace membership
- included in audit/support views when needed
- retained according to metadata retention policy

### Potentially Sensitive User Content

Examples:

- pull request title/body
- issue comments
- branch names
- commit messages
- repository descriptions

Handling:

- avoid storing by default
- if needed for a feature, store minimal excerpts or derived metadata only
- define retention before adding
- never log raw payloads casually

### Prohibited Customer Code Data in v1

Examples:

- repository file contents
- pull request diffs
- code snippets
- raw prompts containing code
- raw model responses containing code

Handling:

- must not be stored in SaaS v1
- must not appear in health reports
- must not appear in logs
- support tools must not display it

### Secrets and Credentials

Examples:

- Codex `auth.json`
- Codex `config.toml` if it contains sensitive auth/config
- OpenAI/OpenRouter API keys
- GitHub tokens
- GitHub App private key
- session secrets

Handling:

- never log
- never store customer provider credentials in SaaS v1
- deployment secrets live only in secret manager
- health reports must reject secret-looking payloads

## Webhook Payload Policy

GitHub webhook payloads can contain potentially sensitive user content.

Rules:

- verify signature before parsing side effects
- store delivery id, event type, payload hash, normalized safe event fields, and processing status
- do not store full raw webhook payload by default
- jobs consume normalized internal events, not raw payload blobs
- use fixtures in tests, not production payload retention
- if temporary raw payload capture is needed for debugging, it must be feature-flagged, redacted, time-limited, and disabled by default

## Logging Policy

Logs may include:

```text
workspaceId
installationId
repoId
githubDeliveryId
jobId
actionRunId
error code
safe error summary
```

Logs must not include:

```text
raw webhook payload
PR body
code/diff
secrets/tokens
raw prompt/model output
environment dump
```

## Review Trigger

Any new field entering SaaS must be classified before implementation.
