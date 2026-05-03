# Webhook Normalization

## Problem

GitHub webhook payloads can contain sensitive user content such as pull request titles, bodies, branch names, commit messages, issue comments, and repository descriptions.

ReviewRouter also wants asynchronous processing. If jobs require raw webhook payloads, privacy and retention become harder.

## Decision

After signature verification, convert GitHub webhook payloads into small normalized internal events and store only those normalized events plus payload hash/status metadata.

Do not store full raw webhook payloads by default.

## Flow

```text
1. receive webhook
2. verify signature
3. ignore unsupported event types with `202` and no persistence
4. compute payload hash for supported event types
5. extract safe normalized fields
6. store GitHubWebhookDelivery
7. enqueue job with normalized event id/type
8. discard raw payload
```

## Normalized Event Examples

### installation.created

```json
{
  "type": "github.installation.created",
  "deliveryId": "...",
  "installationId": 123,
  "accountId": 456,
  "accountLogin": "acme",
  "accountType": "Organization"
}
```

### installation_repositories.added

```json
{
  "type": "github.installation_repositories.added",
  "deliveryId": "...",
  "installationId": 123,
  "repositoryIds": [111, 222]
}
```

### pull_request.synchronize

For v1 SaaS, do not store PR body/title/diff.

```json
{
  "type": "github.pull_request.synchronize",
  "deliveryId": "...",
  "installationId": 123,
  "repositoryId": 111,
  "pullRequestNumber": 42,
  "action": "synchronize"
}
```

## Forbidden in Normalized Events by Default

- PR body
- issue/comment body
- commit messages
- file names from diffs unless explicitly classified later
- raw branch names if not needed
- repository description
- code/diff snippets
- secrets/tokens

## When More Data Is Needed

Prefer re-fetching minimal data from GitHub API inside the job using installation token and storing only the derived safe result.

If a feature requires storing user content:

1. classify the field
2. define retention
3. update privacy docs
4. add redaction/logging tests
5. add explicit user-facing reason

## Tests

- raw webhook body is not persisted
- normalized event excludes PR body/comment body
- duplicate delivery id dedupes before enqueueing duplicate job
- unsupported signed event is ignored after signature verification and is not persisted
- payload hash is stored for debugging without storing payload
