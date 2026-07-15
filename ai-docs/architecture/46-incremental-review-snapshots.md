# Incremental review snapshots

## Decision

ReviewRouter persists completed incremental-review snapshots in a provider-neutral
bounded context. Provider runtimes authenticate the request and translate their
runtime identity into a trusted workspace/repository scope; the snapshot domain
never receives OAuth credentials, GitHub tokens, or provider-specific lease data.

The first implementation is connected to the Codex rotating GitHub Action. The
same application use cases can later be exposed through Claude, GitLab, or generic
Action-session adapters without changing the aggregate or persistence schema.

The Action control plane exposes authorization through the dedicated
`CodexRotatingReviewSnapshotAccessPort`. It validates a completed lease and returns
the server-owned workspace and repository scope. Snapshot use cases depend on this
narrow port, not on the rotating-OAuth repository, and clients cannot choose or
override the persistence scope.

## Aggregate

One `ReviewSnapshot` exists per workspace, repository, and pull-request number.
Including the workspace in the identity prevents a stale tenant from restoring a
snapshot after repository ownership or installation scope changes. It contains:

- the reviewed head and base commit SHAs;
- an analysis compatibility key owned by the review runtime;
- the normalized summary and findings needed to carry forward unchanged issues;
- a monotonically increasing version for compare-and-swap commits;
- source run metadata, timestamps, and a seven-day expiry.

Raw diffs, source files, code suggestions, raw evidence, provider authentication,
cookies, API keys, and OAuth payloads are never persisted. Retained prose is
secret-redacted on both runtime and server boundaries. Payloads are schema
validated and limited to 512 KiB.

## Lifecycle

1. The Action obtains its normal repository-scoped Codex lease.
2. Before checkout it restores the snapshot for the current pull request.
3. If the base SHA still matches, checkout fetches the exact previous reviewed SHA
   in addition to the current base/head objects. It never unshallows the repository.
4. The review runtime accepts the snapshot only when its schema, TTL, base SHA, and
   compatibility key match. Otherwise it performs a full review.
5. Incremental review compares the two complete trees and reviews only changed,
   added, renamed, or removed paths. Findings for changed and renamed source paths
   are invalidated; findings for untouched paths are retained. Invalidation paths
   are tracked separately from the current PR file list, so a file reverted fully
   to the base tree cannot retain a stale finding after disappearing from that list.
6. The child runtime writes a candidate snapshot locally. The parent commits it to
   the control plane only after the review process and GitHub publishing complete.
7. Commit uses the restored aggregate version as a compare-and-swap precondition.
   Concurrent stale writers cannot overwrite a newer snapshot. Identical retries
   are idempotent.
8. The worker periodically hard-deletes expired rows in bounded batches. Deletion
   includes the expiry predicate, so a concurrently refreshed snapshot is not
   removed by a stale maintenance read. If pruning removes an expired row between
   restore and commit, the CAS adapter safely recreates the scoped aggregate.

## Control-plane API

The hosted Action uses its existing lease ID and lease token with these endpoints:

- `POST /api/action/v1/codex-oauth/review-snapshot/restore`
- `POST /api/action/v1/codex-oauth/review-snapshot/commit`

Both endpoints have strict schemas and request-size limits. The lease controls the
workspace and repository identity; request bodies contain only pull-request and
snapshot data. Provider credentials and raw authorization payloads are never part
of these contracts. Snapshot access has a dedicated six-hour completed-lease
window for bounded long reviews; this does not extend comment-token or auth
writeback access.

## Invalidation

A full review is required when any of these conditions is true:

- no snapshot exists or it expired;
- the pull request base SHA changed;
- the runtime cache schema changed;
- the effective review configuration changed;
- the prior commit object cannot be fetched or compared;
- the snapshot payload is malformed or exceeds its safety limits.

Force-push does not require ancestry. ReviewRouter compares the previous and current
Git trees directly, which produces the correct net changed-file set even when the
old head is no longer an ancestor.

## Failure behavior

Restore failure is fail-open for review quality: the Action logs a safe warning and
runs a full review. Commit failure does not fail an already-published review; it is
reported as a safe warning and the next run may repeat the full analysis. Snapshot
data is an optimization, never an authorization or correctness prerequisite.

In hosted mode the parent always marks the snapshot bridge as required and passes
an explicit restore envelope, including for missing or failed restores. The child
must disable incremental reuse if that bridge is incomplete. It must never fall
back to repository-controlled `.mpr-cache` data from the pull-request checkout.

Deploy the database migration and updated API/worker before publishing the updated
Action runtime. A new Action connected to an older control plane fails open and
performs a full review; an older Action simply ignores the new endpoints. This
keeps mixed-version rollouts backward compatible.

Batch-level resume is intentionally a separate future aggregate. Provider results
and synthesis state have different retention, size, and compatibility requirements;
mixing partial execution checkpoints into the completed-review snapshot would make
the snapshot transaction ambiguous and retain substantially more repository data.
