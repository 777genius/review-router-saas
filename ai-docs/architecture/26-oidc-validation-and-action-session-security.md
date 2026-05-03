# OIDC Validation and Action Session Security

## Purpose

GitHub Actions OIDC is the trust root for runtime config fetch and health reporting. Validation mistakes can become tenant isolation bugs.

## OIDC Verification Requirements

SaaS must verify:

```text
issuer is GitHub Actions OIDC issuer
audience matches ReviewRouter configured audience
signature validates against GitHub OIDC JWKS
exp/nbf/iat are valid with small clock skew tolerance
repository id/name maps to active selected repository
repository owner maps to active installation/workspace
event name is allowed for requested operation
workflow ref path is an approved ReviewRouter workflow file
run id and run attempt are present
`jti` is present when replay protection is enabled
```

Prefer immutable IDs over names where claims provide them.

## JWKS Handling

- cache JWKS for a bounded TTL
- refresh JWKS on unknown key id
- fail closed if JWKS cannot be fetched and no valid cached key exists
- monitor JWKS fetch failures

## Clock Skew

Allow small skew only:

```text
maxClockSkewSeconds: 60
```

Expired tokens are rejected.

## Replay Resistance

OIDC tokens are short-lived, but exchange endpoint should still reduce replay value.

Controls:

- action session token expires quickly
- action session scoped to repo/run/runAttempt
- rate limit exchange by repo/run/IP
- store exchange audit event
- consume token `jti` as a nonce before issuing a session

Implemented baseline:

- production API composition uses `PrismaActionOidcReplayNonceStore`
- exchange fails closed with `oidc_jti_required` if replay protection is configured and GitHub claims do not include `jti`
- nonce key is scoped as `<issuer>:<jti>` and expires at token `exp`, or the short action-session TTL fallback when `exp` is unavailable
- duplicate nonce returns safe auth error `invalid_action_token`
- replay rejection happens before rate-limit consumption, so retries with the same stolen token do not burn repo quota
- worker prunes expired nonces in bounded batches through:
  - `REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_BATCH_SIZE`
  - `REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_INTERVAL_MS`

## Action Session Token

Session token must be:

- signed by ReviewRouter
- short-lived, e.g. 15 minutes
- scoped to action API only
- scoped to workspace/repo/run/runAttempt
- not usable for dashboard API
- not refreshable by itself

Token claims should include:

```text
workspaceId
repoId
githubRepositoryId
repositoryFullName
githubRunId
githubRunAttempt
protocolVersion
exp
aud: reviewrouter-action-api
```

Config and health endpoints must re-read current repository state by immutable
GitHub repository id before serving or accepting data. A valid short-lived
session is not enough if the repository was unselected, the installation was
removed, or the repository identity no longer matches the session.

## Fork and Unsafe Context

OIDC may be available even when provider secrets are not safe to use. OIDC identity proves the workflow run, not that PR code is trusted.

Config fetch must distinguish:

```text
public metadata config - safe for all selected repos
secret-backed provider enablement - only if event/trust policy allows it
```

Do not return instructions that cause secret-backed provider execution in unsafe fork context.

## Tests

- unknown key id refreshes JWKS then validates
- JWKS unavailable fails closed without cached key
- expired token rejected
- wrong audience rejected
- repo id mismatch rejected
- workflow ref outside `.github/workflows/reviewrouter.yml` rejected
- removed installation rejected
- config/health reject sessions after repository unselection or identity drift
- missing `jti` rejected in production composition
- duplicate `jti` rejected before rate limits/session issuance
- fork context receives no secret-backed provider enablement
- action session cannot call dashboard API
