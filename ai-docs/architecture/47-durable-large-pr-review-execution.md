# Durable large-PR review execution

## Decision

Large pull-request reviews use a durable, provider-neutral execution checkpoint
and a deadline-aware planner. A checkpoint records server-accepted batch results
for one exact review plan. It is resumable work-in-progress, not proof that the
pull request received complete coverage.

The completed incremental snapshot remains a separate aggregate. Partial review
results may be published with explicit partial coverage, but a partial run never
creates or advances that snapshot.

## Bounded contexts

The boundaries are strict:

- **Review planning and execution** owns GitHub inventory normalization, risk
  scoring, deterministic batching, scheduling, retry admission, coverage, and
  synthesis. These are runtime policies, not persistence policies.
- **Review execution checkpoints** owns the checkpoint aggregate, compatibility
  decisions, compare-and-swap transitions, idempotency, validation, retention,
  and pruning. It has no Codex, GitHub, OAuth, lease, or HTTP dependency.
- **Incremental review snapshots** owns only completed cross-head review state,
  as defined in [46-incremental-review-snapshots.md](./46-incremental-review-snapshots.md).
- **Action control plane** authenticates the lease, derives the immutable
  workspace/repository/PR/run scope, and adapts the checkpoint use cases to HTTP.
  GitHub loading and publishing remain Action/runtime adapters.

The planner depends on a checkpoint port. The hosted Action implements that port
through `restore`, `start`, `batch-result`, `finalize`, and `clear` endpoints.
Neither the checkpoint domain nor its Prisma adapter decides what to review next.

## Aggregate and compatibility

One `ReviewExecutionCheckpoint` exists per server-owned workspace, repository,
and pull-request number. It contains an active or finalized root and ordered batch
results keyed by unique deterministic work keys. The ordered work-key list is
immutable for that checkpoint plan.

Resume requires an exact compatibility tuple:

`(scope, schemaVersion, baseSha, headSha, compatibilityKey, planHash)`

The server derives `scope`; the client cannot rebind it. For `pull_request`, the
PR number is parsed from the GitHub-signed OIDC `ref`. For
`pull_request_target`, the control plane resolves the signed `run_id` through the
repository-scoped GitHub Actions API and verifies the event, run attempt,
repository ID, and single associated PR. The resolved number is persisted on the
lease. A lease for one PR cannot address another PR in the same repository. The
compatibility key covers runtime/configuration semantics, while the plan hash
identifies the exact ordered plan. Any expiry or tuple mismatch disables reuse.
Replanning starts or replaces an active checkpoint through CAS; it never
interprets old results under a new plan.

Every mutation carries `expectedVersion`. Start/replace, each accepted batch, and
finalization advance the monotonic version atomically. A batch is resumable only
after the server acknowledges it. Repeating the same work key and payload hash is
idempotent; a different payload for that key, stale version, changed head/plan,
unplanned work, expiry, or finalized state is a conflict. Head, plan, version,
state, accepted bytes, and expiry are repeated in the atomic persistence predicate,
so a preflight read cannot authorize a stale write. Clients restore and reconcile
instead of overwriting concurrent progress.

## Execution invariants

1. The planner builds a stable risk-first order so the highest-risk known files
   run before lower-risk work. Restored server-accepted keys are removed without
   changing the remaining order.
2. Scheduling concurrency is adaptive but clamped to `1..3`. It responds to
   observed completion time, failures, and remaining deadline budget; it never
   expands without bound to compensate for a large pull request.
3. The parent supplies one absolute execution deadline aligned with its child
   process timeout. New attempts and retries are admitted only when their expected
   execution, backoff, result commit, synthesis, and publishing reserve fit.
   Deadline-suppressed retries are recorded as unattempted coverage, not failures
   that can loop until the process is killed. Health checks, discovery, checkpoint
   fetches, and response-body reads use bounded timeouts inside the same deadline.
4. A batch result is durable only after its checkpoint commit is acknowledged.
   Process-local completion followed by a failed acknowledgement is retried safely
   and is never assumed complete on resume.
5. If any batch fails, times out, is suppressed by the deadline, or cannot be
   acknowledged, the runtime may publish findings from accepted successful
   batches. The publication must state partial coverage and identify completed,
   failed, skipped, and unknown coverage counts. The checkpoint remains resumable,
   but the completed snapshot does not advance.
6. Finalization is allowed only when every planned work key is server-accepted.
   This freezes the accepted execution before snapshot handoff but does not advance
   the completed snapshot. The runtime writes a strict finalization marker only
   after the server acknowledges finalization. The parent validates that marker,
   then verifies the current head and commits
   the completed snapshot; only a successful or idempotent snapshot commit permits
   CAS-clearing the finalized checkpoint. A snapshot failure retains the finalized
   checkpoint for a safe retry.

## Incomplete GitHub input

GitHub's pull-request files API exposes at most 3,000 files. The runtime compares
the PR's reported changed-file count with the unique files actually loaded and
also tracks pagination, diff, and content-load failures. A cap, count mismatch,
failed page, or failed required load makes the inventory explicitly incomplete.

Known loadable files may still be reviewed in risk order, but output must not
claim complete coverage. Unknown or unloaded files are included in the coverage
gap. The runtime withholds checkpoint finalization even if every known batch was
accepted, and no completed snapshot is emitted. The 3,000-file ceiling is never
treated as an exhaustive list merely because the final available page was
consumed.

## Retention and safety

Checkpoint TTL is seven days and is refreshed by accepted batch commits and
finalization. The worker prunes expired roots and cascading batch rows in bounded
batches (default 500 every five minutes, hard limit 10,000) with the expiry
predicate repeated at deletion time.

Limits are enforced at HTTP, domain, and persistence boundaries: at most 200 work
keys, 128 KiB per batch payload, 2 MiB accepted payload per aggregate, and 1,000
findings. A batch may contain at most 200 file paths and 50 provider results.
Over-budget data is rejected; it is not silently truncated into a false success.

Persisted data is limited to normalized paths, findings, provider outcome facts,
bounded token-usage counters needed for resumed budget accounting, lifecycle
evidence, hashes, versions, and run metadata. Text is length-bounded and
secret-redacted before persistence. Raw source, diffs, prompts, responses,
credentials, tokens, cookies, authorization headers, and OAuth payloads are
forbidden. Logs use bounded safe summaries rather than persisted prose.

The Action and control plane use the same bounded wire limits. Lifecycle IDs are
at most 500 characters, file paths and assigned lifecycle targets are unique per
payload, and provider-reported `totalTokens` is retained independently because
some providers include token categories not represented by prompt/completion
counters.

## Observability

Structured telemetry must make correctness auditable without content leakage:

- inventory: reported, loaded, unloadable, and unknown file counts plus a bounded
  incompleteness reason;
- planner: plan hash, risk buckets, total/restored/pending batches, adaptive cap
  changes, deadline remaining, and retry-suppression reason;
- checkpoint: operation/status, expected/current version, batch index, accepted
  bytes/findings, idempotency, conflict, latency, finalization, clear, and prune;
- outcome: complete versus partial coverage, successful/failed/skipped batches
  and files, publication result, snapshot commit result, and checkpoint retained.

Alert on checkpoint API errors, CAS conflict spikes, budget rejection, repeated
partial coverage, deadline suppression, finalized checkpoints that are not
cleared, snapshot non-advancement, and prune failures. Compatibility misses are
diagnostic dimensions, not automatically incidents.

## Deploy and rollback

Deploy the additive database migration first, then API and worker support, then
the planner/Action runtime. A new runtime against an old control plane must fail
open to a non-resumable review and must not claim checkpoint durability. Older
runtimes ignore the additive tables and endpoints.

Rollback the planner/Action first. The API, worker, and schema can remain deployed
while in-flight checkpoints expire. Roll back control-plane code only after no
new runtime uses the protocol; do not drop tables until at least one TTL window
has passed and retained rows are drained. A rollback must never convert an active
checkpoint into a completed snapshot.

## Hosted verification

Release verification uses only a disposable hosted repository. It must cover a
multi-batch run interrupted after at least one server acknowledgement, an identical
rerun that skips only acknowledged work, honest partial publication with no
snapshot advancement, complete finalization followed by snapshot commit and clear,
snapshot-commit failure retaining the finalized checkpoint, and deadline retry
suppression. A disposable 3,000-plus-file fixture verifies the GitHub ceiling and
partial-coverage claim; deterministic adapter tests cover page/load failures.

Evidence records run IDs, head/base SHAs, safe plan/work hashes, checkpoint
versions, coverage counts, and snapshot versions. It does not retain credentials,
source, findings prose, prompts, or provider responses. Production repositories
are never smoke-test targets.
