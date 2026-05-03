# Control Plane Protocol

## Problem

ReviewRouter SaaS manages config, but ReviewRouter Action runs in customer CI/CD. The action needs current config and may need to report safe health metadata back to SaaS.

We need this without:

- storing SaaS API tokens in customer repos
- sending repository code or diffs to SaaS
- requiring workflow PRs for every config edit

## Solution

Use GitHub Actions OIDC to authenticate the workflow run to ReviewRouter SaaS.

The generated workflow grants:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
```

The action exchanges a GitHub OIDC token for a short-lived ReviewRouter action session token.

## Runtime Flow

```text
GitHub Actions job
  -> ReviewRouter Action requests GitHub OIDC JWT
  -> ReviewRouter SaaS verifies JWT
  -> SaaS returns action session token
  -> Action fetches config metadata
  -> Action runs review locally in CI
  -> Action optionally reports health metadata
```

## Config Fetch

Endpoint:

```text
GET /api/action/config
```

Response should include:

```json
{
  "configVersion": 12,
  "providers": ["codex/gpt-5.5"],
  "modelEffort": "medium",
  "preset": "safe-default",
  "blockingPolicy": {
    "failOnCritical": true,
    "failOnMajor": false
  },
  "limits": {
    "inlineMaxComments": 5,
    "maxDiffBytes": 200000
  }
}
```

Do not include secrets.

## Health Report

Endpoint:

```text
POST /api/action/health-report
```

Allowed fields:

```text
workspace/repo identity from verified token
run id
workflow name
action version
config version used
provider setup state
safe error category
safe error summary
startedAt/finishedAt
```

The route must enforce the health report request size limit before application
logic runs. Error responses must return stable safe error codes, not raw thrown
exception messages, provider output, prompts, code, diffs, or secret values.

Forbidden fields:

```text
code snippets
diff hunks
raw prompts
raw model output
secret names with values
environment variables
```

## Token Verification

SaaS must validate:

- issuer
- signature via GitHub OIDC JWKS
- audience
- expiration and not-before
- repository id/name matches installed repository
- repository owner matches active installation/workspace
- installation is active and repository is selected
- event type is allowed
- workflow run is not from an unsafe fork context if requesting secret-backed config

## Session Token

The ReviewRouter action session token should be:

- short-lived
- scoped to repo/run/config fetch/report only
- not capable of dashboard actions
- not stored by the action after job

## Failure Modes

If OIDC exchange fails:

- action falls back to static workflow config if available
- health report may be skipped
- PR review can still run if static config and secrets exist
- dashboard shows runtime sync unavailable after observing no report

## Why This Matters

This is the main bridge that makes ReviewRouter a real SaaS control plane while preserving the privacy claim that review execution and code stay in the customer's CI/CD.
