# Telemetry and Tracing Privacy

## Principle

Observability must not undermine the privacy promise.

## Structured Logs

Allowed fields:

```text
requestId
workspaceId
repoId
installationId
githubDeliveryId
jobId
actionRunId
errorCode
safeErrorSummary
```

Forbidden fields:

```text
request bodies by default
response bodies by default
raw webhook payloads
code/diff snippets
prompt/model text
secret values
environment variables
GitHub tokens
```

## Tracing

If using OpenTelemetry or similar:

- disable automatic request/response body capture
- scrub headers
- scrub query strings if they may contain tokens
- avoid span attributes containing repo code/user content
- sample carefully for high-volume endpoints

## Error Reporting

Error reporting tools must redact:

- Authorization headers
- cookies
- GitHub webhook signatures
- OIDC tokens
- action session tokens
- provider API keys
- PEM blocks

Stack traces are allowed only if local variables/env are not captured.

## Metrics

Prefer aggregate metrics:

```text
webhook count
job duration
error code counts
queue depth
config fetch success/failure
health report count
```

Do not put tenant names, repo names, or user logins into high-cardinality metric labels unless explicitly needed and approved.
