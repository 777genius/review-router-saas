# Live review progress rollout

Live progress is an optional projection of canonical Review v2 state. A
progress-publication failure must never change or delay the final review.

## Flags

- `REVIEW_ROUTER_PROGRESS_PROJECTION_CAPTURE=1` materializes durable snapshots.
- `REVIEW_ROUTER_PROGRESS_FILE_COVERAGE=1` includes coverage only when a valid
  assignment manifest exists.
- `REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES=1` enables the publisher.
- `REVIEW_ROUTER_PROGRESS_REPOSITORIES=owner/repo,...` is the required hosted
  write cohort. Empty is fail-closed; `*` is the explicit default-on cutover.

The Action-side CI-only path is independently controlled by
`REVIEW_ROUTER_CI_PROGRESS_WRITES=1`. It uses a PR comment only when the current
job already has a writable token; forks and read-only jobs fall back to the job
summary without permission escalation.

## Safe rollout

1. Apply migration `000067_review_live_progress` before compatible API and
   worker code.
2. Enable projection capture with hosted writes disabled. Verify snapshot
   invariants, monotonic versions, queue depth, and terminal recovery.
3. Add only disposable test repositories to
   `REVIEW_ROUTER_PROGRESS_REPOSITORIES`, then enable hosted writes.
4. Prove restart, supersession, duplicate reconciliation, permission loss,
   rate-limit cooldown, and terminal convergence. Target ordinary updates
   within 90 seconds and terminal updates within 30 seconds when GitHub is
   available.
5. Widen to a small opt-in cohort. Enable file coverage separately after
   validating persisted manifests.
6. Set the cohort to `*` only after the race, rate, and SLO gates pass.

## Rollback

Set `REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES=0`, then restart or redeploy
the worker. The flag is read when the worker runtime is constructed, so do not
assume GitHub mutations have stopped until that restart completes. Durable
snapshots and the final-review flow remain available. Keep projection capture
enabled for diagnosis. If the projection itself is unhealthy, disable capture
separately; the additive schema can remain.
