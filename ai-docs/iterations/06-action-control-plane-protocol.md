# Iteration 06 - Action Control Plane Protocol

## Goal

Allow ReviewRouter Action running in customer CI to fetch current SaaS-managed config and report safe health metadata without storing a SaaS token or sending code/diff.

## Scope

- action-control-plane bounded context
- GitHub Actions OIDC token exchange endpoint
- OIDC JWT verification with JWKS cache, clock skew tolerance, and fail-closed behavior
- short-lived action-session token scoping
- short-lived action session token
- versioned config fetch endpoint
- versioned health report endpoint with strict payload size/schema limits
- server-side code/diff/secret-looking payload rejection
- generated workflow includes `id-token: write`
- static config fallback when OIDC/SaaS unavailable

## Security Boundary

Allowed:

- repo/run/workflow metadata
- config version used
- provider health category
- safe error summaries

Forbidden:

- repository code
- PR diff
- raw prompts
- raw model responses
- secrets or env values

## Tests

- valid OIDC token accepted
- JWKS unavailable fails closed without valid cached key
- expired token and replay-sensitive cases handled
- wrong audience rejected
- expired token rejected
- repo mismatch rejected
- unselected repo rejected
- health report rejects code/diff-like and secret-looking payloads
- oversized health report rejected
- action can fall back to static config when OIDC/SaaS unavailable

## Done When

- generated workflow can run with runtime config fetch
- dashboard config can affect future runs without workflow PR
- health metadata appears in dashboard without violating privacy boundary
