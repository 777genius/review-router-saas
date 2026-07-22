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
the server-owned workspace, repository, and pull-request scope. For
`pull_request`, the PR number comes from the GitHub-signed OIDC `ref`; for
`pull_request_target`, it is resolved from the signed workflow run and verified
against the run event, attempt, repository, and associated PR. It is never trusted
from the snapshot request. Snapshot use cases depend on this
narrow port, not on the rotating-OAuth repository, and clients cannot choose or
override the persistence scope.

The lease captures that workspace, repository, and PR scope immutably when acquired.
Rebinding a provider later cannot move an already completed run's snapshot access
to another repository.

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
6. The child runtime writes the complete candidate atomically after the review,
   GitHub publishing, and report generation complete. A normal success and an
   expected severity-policy failure can both commit that candidate; the parent
   preserves the policy failure after attempting the commit. Earlier failures do
   not produce a candidate and therefore cannot persist partial review state.
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
- `POST /api/action/v1/codex-oauth/review-snapshot/head-token`
- `POST /api/action/v1/codex-oauth/review-snapshot/commit`

All three endpoints have strict schemas and request-size limits. The lease controls the
workspace and repository identity; request bodies contain only pull-request and
snapshot data. Provider credentials and raw authorization payloads are never part
of these contracts. Snapshot access has a dedicated six-hour completed-lease
window for bounded long reviews; this does not extend comment-token or auth
writeback access. Immediately before commit, the parent requests a fresh,
repository-scoped, read-only head token and verifies that the pull-request head is
still the reviewed SHA. It never reuses an expired comment token for this check.

## Invalidation

A full review is required when any of these conditions is true:

- no snapshot exists or it expired;
- the pull request base SHA changed;
- the runtime cache schema changed;
- the effective review configuration changed;
- the prior commit object cannot be fetched or compared;
- the snapshot payload is malformed or exceeds its safety limits.

Snapshot persistence is all-or-nothing. The runtime never truncates findings or
summary text to force a candidate under the limit because a lossy snapshot could
silently remove findings on untouched files in later incremental runs. Oversized
candidates are skipped and the next run safely falls back to a full review. The
512 KiB payload limit is checked independently from the bounded protocol-envelope
overhead on both restore and commit paths.

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

Release verification must include migration smoke, the local control-plane HTTP
flow, a blocking-review candidate, stale-head and CAS-conflict coverage, and two
consecutive hosted runs in a disposable test repository. The second hosted run
must restore version 1, review only the delta from its reviewed head, and commit
version 2. Production repositories are not used as smoke-test targets.

## Hosted verification evidence

## Snapshot Schema v2

V2 stores one completed projection, bounded lineage/provenance hints and immutable
commit receipts. It advances only after completed coverage and reconciled
successful publication. Lower generations record
`superseded_by_higher_generation` without mutation; equal generation is
idempotent only for the same artifact. V2 treats legacy rows as
`legacy_untrusted`; hints-only restore never returns old findings, placement,
lifecycle or gate state.
The production rollout was verified on 2026-07-16 in the disposable private
repository `777genius/rr-codex-rotating-e2e`, pull request 42:

- run `29486414325` completed a full review of head `a2287808`, then production
  persistence reported snapshot version 1 with that reviewed head and run ID;
- run `29486837234` restored the prior head, logged the exact incremental range
  `a2287808..c323892d`, reviewed one changed file, and completed successfully;
- production persistence then reported snapshot version 2, reviewed head
  `c323892d`, and source run `29486837234` for the same repository and pull
  request scope.

The test used a dedicated repository-scoped OAuth login. No account identity,
credential material, source payload, or snapshot prose is retained in this
evidence.

Batch-level resume is implemented as a separate aggregate; see
[47-durable-large-pr-review-execution.md](./47-durable-large-pr-review-execution.md).
Provider results and partial coverage have different retention, size, and
compatibility requirements and never enter this completed-review snapshot. A
partial or incompletely loaded run may publish honest partial coverage and retain
its execution checkpoint, but it cannot create or advance `ReviewSnapshot`.

After all planned work is server-acknowledged, checkpoint finalization still does
not advance this aggregate. The parent first validates the runtime's strict
server-finalization marker, then verifies the current head and commits the completed
snapshot. A missing, malformed, or mismatched marker prevents snapshot advancement.
The marker explicitly records whether snapshot advancement is required. When it is,
only a successful or idempotent snapshot commit permits the finalized checkpoint to
be cleared. When it is not, a successful runtime clears the checkpoint directly.
Runtime or snapshot failure retains the checkpoint for a safe retry.
