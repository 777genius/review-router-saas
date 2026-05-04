# ADR-010: Action Control Plane Protocol via GitHub OIDC

## Status

Accepted.

## Decision

ReviewRouter Action should communicate with ReviewRouter SaaS through a narrow metadata-only control plane protocol authenticated by GitHub Actions OIDC.

The workflow grants:

```yaml
permissions:
  id-token: write
```

The action requests a GitHub OIDC token with ReviewRouter as audience, sends it to the SaaS API, and the SaaS verifies token claims before returning repository configuration or accepting health metadata.

## Rationale

Without a runtime protocol, dashboard config changes would require a workflow PR every time. That weakens the SaaS value.

A static workflow should be able to fetch current config safely at runtime without storing a ReviewRouter API token in the customer's repository.

GitHub Actions OIDC provides a short-lived signed identity token for the workflow run. GitHub documents that workflows need `id-token: write` to request this token and that OIDC tokens include claims such as repository, ref, workflow, actor, and run metadata.

References:

- https://docs.github.com/en/actions/reference/security/oidc
- https://docs.github.com/en/actions/reference/openid-connect-reference

## Allowed API Calls

```text
POST /api/action/v1/session/exchange
GET  /api/action/v1/config
POST /api/action/v1/health-report
POST /api/action/review-run-report optional later
```

## Authentication Flow

```text
1. Workflow grants id-token: write.
2. ReviewRouter Action requests OIDC token with audience `review-router`.
3. Action sends token to ReviewRouter SaaS.
4. SaaS verifies GitHub issuer, signature, audience, expiry, repo claims, and installation/repo mapping.
5. SaaS returns a short-lived ReviewRouter action session token.
6. Action uses that token for config/health calls during the same workflow run.
```

## Claims to Validate

Minimum:

```text
iss == https://token.actions.githubusercontent.com
aud == review-router or configured audience
repository / repository_id
repository_owner / repository_owner_id
run_id
run_attempt
workflow / job_workflow_ref where available
event_name
ref / base_ref / head_ref where relevant
repository_visibility
exp / nbf / iat
```

Repository id should be preferred over repository name where possible because names can change.

## Data Boundary

Allowed payloads:

- config version
- config source: runtime OIDC, static fallback, or workflow static
- selected provider metadata
- workflow/action version
- health status
- provider setup state summary
- run id/check id
- error categories and safe summaries
- finding counts by severity
- comment counts
- skipped reason category

Forbidden payloads:

- repository code
- pull request diff
- secrets
- Codex auth contents
- model raw prompts/responses unless explicitly redesigned later

## Fallback

If OIDC is unavailable, the action can run from static workflow configuration only.

Dashboard should show:

```text
Runtime config sync unavailable. Workflow is using static configuration from the installed workflow file.
```

## Consequences

Positive:

- dashboard config can affect future runs without workflow PRs
- no long-lived SaaS token in repo secrets
- metadata-only reporting preserves privacy boundary
- supports multi-instance SaaS and future health dashboard

Negative:

- generated workflow needs `id-token: write`
- SaaS must implement robust JWT validation
- OIDC claim handling must be tested carefully
- some enterprise GitHub environments may customize OIDC claims
