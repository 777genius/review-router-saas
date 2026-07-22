# API Contracts and Versioning

## API Categories

### Dashboard API

- implemented with tRPC
- internal to ReviewRouter web app
- can evolve faster
- still requires authorization and input validation

### GitHub Webhook API

- plain Fastify route
- versionless from GitHub perspective
- must support current GitHub payloads and fixtures
- signature verification required before parsing side effects

### Action Control Plane API

- public protocol used by ReviewRouter Action in customer CI
- must be versioned and backwards compatible
- cannot change casually

## Action API Versioning

Use explicit protocol version:

```text
/api/action/v1/session/exchange
/api/action/v1/config
/api/action/v1/health-report
```

Local beta compatibility:

```text
/api/action/exchange-token
/api/action/config
/api/action/health-report
```

Legacy aliases must stay backward compatible until the Action runtime has moved to v1 endpoints and a release deprecation window has passed.

The action should send:

```text
x-reviewrouter-action-version
x-reviewrouter-protocol-version
```

Responses should include:

```text
protocolVersion
configSchemaVersion
minimumSupportedActionVersion optional
upgradeRecommended boolean optional
```

## Schema Policy

Use Zod schemas for:

- request validation
- response construction
- persisted config JSON validation
- health report payload validation

Do not accept freeform JSON blobs from CI without strict size and schema limits.

## Backward Compatibility

Allowed changes:

- add optional fields
- add new enum values only when old action handles unknown safely
- add new endpoints

Breaking changes:

- remove required field
- change field meaning
- change auth behavior
- make optional field required

Breaking changes require new protocol version.

## Size Limits

Set explicit request limits:

```text
OIDC exchange: small
config fetch: small
health report: small, metadata-only
webhook payload: GitHub-sized but not logged raw
```

Reject oversized action reports to preserve no-code/no-diff boundary.

## Error Format

## V2 Operation Matrix

Each v2 operation has a generated caller authority, natural idempotency preimage,
timeout, retry class and exhaustive typed result/error registry. Mutable retries
reuse the exact key and body hash; a reused key with another body is HTTP 409.
Stale revision/generation/permit/watermark is 412, bounds are 413, expired or
revoked capability is 410, and ambiguous mutation failures retry only the same
request or enter reconciliation. Unknown enums and statuses fail closed.
Action API errors should be structured:

```json
{
  "error": {
    "code": "OIDC_REPOSITORY_NOT_SELECTED",
    "message": "Repository is not selected in ReviewRouter.",
    "retryable": false
  }
}
```

No stack traces or sensitive internals in API responses.

Legacy `/api/action/*` aliases may keep `{ "error": "safe_code" }` while the existing Action runtime migrates. New `/api/action/v1/*` clients must use the structured format.
