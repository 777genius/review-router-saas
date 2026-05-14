# Conflict PR Review Runtime v1 Implementation Plan

This plan covers the missing runtime layer required before
`REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK` can be enabled in production.
It builds on the control-plane, webhook, outbox, database, OIDC, and workflow
capability work from the conflict fallback implementation.

The goal is not to make conflict review look like normal merge-result review.
The goal is to safely review the PR head when GitHub cannot produce a merge
commit because the PR has conflicts, then post clearly advisory output without
weakening the normal required review path.

## Current State

Already implemented in the current branch:

- Feature flag for conflict fallback, default off.
- Positive conflict detection from fresh mergeability signals.
- Durable conflict attempt records with dispatch id, nonce hash, base ref, base
  SHA, head SHA, status, and retry state.
- Outbox-driven `repository_dispatch`.
- Base push reconciliation for open PRs.
- Workflow template support for a dedicated `repository_dispatch` conflict job.
- Workflow capability analyzer that rejects unsafe workflow shapes.
- OIDC exchange path for `repository_dispatch` only when it is conflict-specific.
- Replay nonce and rate limit checks before marking an attempt as started.
- Config snapshot binding for conflict mode.
- Rejection of generic normal config exchange from `repository_dispatch`.
- Rejection of generic comment-token issuance for `conflict-head`.
- Explicit workflow conflict fallback fail-closed.
- Required workflow left unchanged.
- GitHub App manifest includes `push` event and keeps existing status permission.

Missing before enabling the feature:

- Runtime v1 support for `conflict-head` execution.
- Exact PR head checkout policy for conflict runs.
- Trusted diff construction against the expected base.
- Model execution isolation for conflict diff content.
- Runtime pre-post PR state validation.
- Runtime posting capability or server-side posting proxy.
- Advisory summary comment and status/check posting.
- Posting checkpoints and duplicate prevention.
- End-to-end GitHub Actions smoke test against a disposable repository.

## Production Enablement Rule

Do not set `REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK=true` in production
until every acceptance gate in this document passes.

Safe deployment states:

| State                                            | Allowed                           | Reason                                                   |
| ------------------------------------------------ | --------------------------------- | -------------------------------------------------------- |
| Code deployed, flag off                          | Yes                               | No conflict dispatch behavior is enabled.                |
| Flag on in disposable/staging repo only          | Yes, after runtime is implemented | Required for OIDC and GitHub side-effect validation.     |
| Flag on in production with runtime missing       | No                                | Dispatch could start without a safe posting path.        |
| Flag on in production with generic comment token | No                                | Token is not scoped to one PR/head/base/context/comment. |

## Architecture Boundary

Keep the existing ownership boundaries:

| Area                              | Owner                                             |
| --------------------------------- | ------------------------------------------------- |
| Conflict attempt lifecycle        | `packages/features/conflict-review`               |
| Async execution                   | existing outbox worker                            |
| Workflow rendering and capability | `packages/features/workflow-provisioning`         |
| OIDC session and runtime config   | `packages/features/action-control-plane`          |
| Runtime execution                 | ReviewRouter reusable workflow runtime            |
| Posting operation enforcement     | control plane posting proxy or posting capability |
| GitHub posting client             | infrastructure adapter behind a narrow port       |

Important boundary rule:

`action-control-plane` may validate identity, issue runtime config, and issue
posting capabilities, but it must not own conflict attempt lifecycle. The
conflict feature owns attempts and decides whether a run is current.

## Chosen Runtime Strategy

Recommended v1 strategy:

Use a server-side posting proxy or one-shot ReviewRouter posting session. The
runtime should never receive a broad GitHub App installation token before model
execution. If a raw App token fallback is ever added, it must be marked as a
degraded mode and remain disabled by default.

Scores:

| Strategy                         | Confidence | Reliability | Complexity | Estimated change |
| -------------------------------- | ---------: | ----------: | ---------: | ---------------: |
| Posting proxy/session            |       9/10 |        9/10 |       8/10 |     900-1600 LOC |
| Raw App token late-mint fallback |       6/10 |        6/10 |       6/10 |      500-900 LOC |
| Use normal comment token         |       2/10 |        2/10 |       3/10 |      100-250 LOC |

Reject the normal comment-token approach. It is easier, but it breaks the core
security model because the token is not scoped to one conflict attempt and one
posting contract.

## Runtime Sequence

Good sequence:

```text
repository_dispatch starts trusted workflow
-> workflow masks conflict dispatch nonce
-> runtime requests OIDC token with ReviewRouter runtime-config audience
-> control plane validates OIDC, nonce, attempt, workflow shape, and snapshot
-> runtime receives non-posting config and conflict metadata
-> runtime validates expected PR state before checkout
-> runtime checks out exact expected head SHA without credentials
-> runtime builds bounded diff against expected base
-> runtime runs provider/model subprocess with a strict environment allowlist
-> runtime validates model output schema and strips any control fields
-> runtime refreshes PR state immediately before posting
-> runtime requests posting session with posting purpose
-> control plane validates OIDC/session/attempt/current PR state again
-> runtime posts summary and bounded inline comments through posting proxy
-> runtime repeats stale validation before terminal status/check
-> runtime posts final advisory status/check
-> runtime records completion health without raw secrets or full diff
```

Bad sequence:

```text
repository_dispatch starts workflow
-> checkout untrusted PR head
-> install dependencies or run scripts
-> run model with nonce/GITHUB_TOKEN/posting token in env
-> request broad comment token
-> post comments without revalidating current PR state
```

The bad sequence must never be accepted in review.

## Implementation Phases

### Phase 1: Runtime Mode Contract

Add an explicit `conflict-head` runtime mode to the reusable runtime.

Requirements:

- Accept `review_kind=conflict-head` only for `repository_dispatch`.
- Reject `workflow_dispatch` with `review_kind=conflict-head`.
- Reject `pull_request` and `merge_group` with `review_kind=conflict-head`.
- Require `conflict_dispatch_id`, `conflict_dispatch_nonce`,
  `conflict_head_sha`, `conflict_base_ref`, and `conflict_base_sha`.
- Validate every conflict input with shared validators.
- Reject empty strings after trimming.
- Mask `conflict_dispatch_nonce` before logging anything else.
- Never pass raw nonce to provider/model subprocesses.
- Never echo raw `client_payload` into shell.

Tests:

- Runtime accepts conflict mode from repository dispatch only.
- Runtime rejects missing conflict dispatch id.
- Runtime rejects invalid dispatch id format.
- Runtime rejects branch names with shell-sensitive syntax.
- Runtime rejects head/base SHA mismatch.
- Logs do not include raw nonce.

### Phase 2: OIDC Preflight

The first privileged operation in conflict mode must be OIDC preflight.

Requirements:

- Request OIDC token with a ReviewRouter-specific audience.
- Validate OIDC claims on the server:
  - issuer
  - audience
  - repository id
  - repository owner id
  - repository full name as non-authoritative hint only
  - event name
  - workflow ref
  - workflow SHA
  - job workflow ref
  - job workflow SHA
  - run id
  - run attempt
  - runner environment
- Validate dispatch payload against stored attempt.
- Consume or bind the nonce to the run identity.
- Return only non-posting runtime config.
- Return conflict metadata from the stored attempt, not from raw payload.

Tests:

- Unknown dispatch id is rejected.
- Dispatch id for another repository is rejected.
- Nonce replay from another run is rejected.
- Nonce replay from the same run but wrong purpose is rejected.
- Self-hosted runners are rejected unless a future explicit safe policy exists.
- Snapshot mismatch rejects runtime config.

### Phase 3: Checkout Policy

Conflict runtime must checkout exactly the expected PR head SHA and nothing else.

Requirements:

- Use `actions/checkout` or equivalent with:
  - exact `conflict_head_sha`
  - `persist-credentials: false`
  - no submodules
  - no LFS unless explicitly reviewed later
  - no dependency cache
  - no artifact upload of repository content or diff
- Never use `github.sha` as the reviewed commit in conflict mode.
- Never checkout default branch as the reviewed code.
- Never checkout by mutable branch ref for the reviewed content.
- Do not run package scripts, generators, tests, or builds before provider
  isolation is in place.
- Treat checkout failure as degraded runtime failure, not as permission to post
  normal review output.

Tests:

- Generated workflow or runtime script checks out expected head SHA.
- Conflict mode rejects mutable ref checkout.
- Conflict mode does not persist credentials.
- Conflict mode does not use cache keys from branch names or PR numbers.
- Checkout failure records safe health without raw secrets.

### Phase 4: Diff Construction

Conflict review must review the PR head against the expected base, not the
merge result and not the default branch workflow SHA.

Preferred v1 diff source:

- Use GitHub PR files API for changed files and metadata.
- Use local git diff only after exact head/base validation.
- Bound total diff size, file count, and per-file content.

Requirements:

- Validate current PR state before building diff.
- Validate that current head SHA equals expected head SHA.
- Validate that current base ref and best-known base SHA are compatible with the
  stored attempt.
- If base SHA changed and the attempt is no longer current, exit stale before
  model execution.
- Include base ref and base SHA in diff metadata and posting manifest.
- Exclude binary files or represent them as metadata only.
- Cap generated diff size before model execution.
- Record safe truncation metadata without storing full raw diff.

Tests:

- Diff builder refuses stale head SHA.
- Diff builder refuses stale base ref.
- Large diff degrades to bounded summary mode.
- Binary files do not produce raw binary prompt content.
- File path validation prevents shell interpolation risks.

### Phase 5: Model Execution Isolation

Provider/model subprocesses are untrusted with respect to posting control.

Requirements:

- Provider subprocess environment allowlist must exclude:
  - `ACTIONS_ID_TOKEN_REQUEST_URL`
  - `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
  - `GITHUB_TOKEN`
  - GitHub App tokens
  - posting tokens
  - conflict dispatch nonce
  - ledger key unless strictly required and already part of runtime design
  - full unbounded diff outside prompt payload
- Model output must be treated as untrusted content.
- Model output may contain findings and summary text only.
- Model output must not contain posting destinations or control decisions.
- Reject or ignore fields such as:
  - status
  - check conclusion
  - context
  - target URL
  - comment id
  - marker
  - token
  - nonce
  - retry
  - approve
  - request changes
- Bound finding count, file path length, line numbers, title length, and body
  size.
- Sanitize markdown mentions where needed to avoid noisy notifications.

Tests:

- Provider env snapshot does not include OIDC or posting secrets.
- Model output with control fields is rejected or sanitized.
- Oversized model output degrades safely.
- Malformed model JSON does not post anything.
- Prompt injection cannot choose status context or comment id.

### Phase 6: Pre-post Validation

No GitHub write may happen until runtime performs fresh pre-post validation.

Requirements:

- Refresh PR by GitHub repository id or trusted installation identity.
- Treat repository full name as mutable API coordinates, not trust identity.
- Verify:
  - repository id
  - installation id
  - PR number
  - PR is open
  - PR is not draft
  - PR is not merged
  - PR head SHA equals expected head SHA
  - PR base ref equals expected base ref
  - base SHA or mergeability signal still matches current attempt semantics
  - PR is not from an unsupported fork mode
  - repository is still selected and entitlement is active
  - workflow capability still supports conflict fallback
- If stale, exit without comments and without success status.
- If permission or capability is missing, record degraded health.

Tests:

- PR closed during model run produces no comments.
- PR drafted during model run produces no comments.
- PR synchronized during model run produces no comments.
- PR retargeted during model run produces no comments.
- Repository unselected during model run produces no comments.
- Capability removed during model run produces no comments.

### Phase 7: Posting Capability

Add a conflict-specific posting token/session. Do not reuse the normal
`/comment-token` endpoint.

Recommended API shape:

```text
POST /api/action/conflict-review/posting-session
Authorization: Bearer <runtime session token>
Body:
  dispatch_id
  purpose: posting_token
  posting_manifest_hash
```

Server validates:

- Runtime session token is valid.
- Session review kind is `conflict-head`.
- Session dispatch id matches attempt.
- Attempt is started and not terminal.
- Run identity matches nonce-bound run.
- Current PR state passes pre-post validation.
- Config snapshot id matches the attempt.
- Posting manifest is bounded and deterministic.
- Requested operations are within allowed scope.

Posting session scope:

- repository id
- GitHub repository id
- installation id
- PR number
- head SHA
- base ref
- base SHA
- dispatch id
- config snapshot id
- allowed APIs
- one status/check context
- allowed summary comment id or create-summary permission
- inline comment cap
- TTL

Forbidden:

- Posting session must not be usable for normal review.
- Posting session must not be accepted for another PR.
- Posting session must not allow arbitrary status context.
- Posting session must not allow arbitrary target URL.
- Posting session must not allow arbitrary comment id.
- Posting session must not be passed to model/provider subprocesses.

Tests:

- Posting session for one PR cannot post to another PR.
- Posting session for one head SHA cannot post to another head SHA.
- Posting session cannot choose a normal required context.
- Expired posting session is rejected.
- Posting session cannot update a user-authored comment.

### Phase 8: Posting Manifest And Checkpoints

GitHub writes are external side effects. Runtime must be resumable without
duplicate comments or false terminal status.

Posting manifest fields:

- dispatch id
- repository id
- PR number
- head SHA
- base ref
- base SHA
- config snapshot id
- summary body hash
- inline finding fingerprints
- planned advisory status/check conclusion
- status/check context
- run URL

Checkpoint phases:

1. `posting_started`
2. `summary_posted`
3. `inline_comments_posted`
4. `pre_status_validation_passed`
5. `status_posted`
6. `completed`

Requirements:

- Checkpoint before and after each GitHub write phase.
- Store GitHub ids and hashes, not full bodies.
- Summary comment update requires stored comment id or verified marker ownership.
- Inline comment duplicates are suppressed by fingerprint.
- Final advisory status/check is posted only after a fresh validation.
- A retry after summary but before status must reuse/update summary safely.
- A retry after status must not post a duplicate terminal status if the attempt
  is already terminal.

Tests:

- Crash after summary does not create duplicate summary.
- Crash after some inline comments skips already-posted fingerprints.
- Crash after status does not post a second terminal status.
- Retry after stale validation does not post anything new.

### Phase 9: Summary Comment

Conflict review summary must be clearly advisory.

Requirements:

- The visible text must say the PR has conflicts and this is a head-only review.
- Do not claim the merge result was reviewed.
- Do not approve or request changes.
- Include the reviewed head SHA and base ref in human-readable text.
- Include deterministic hidden marker footer with canonical metadata:
  - repository id
  - PR number
  - head SHA
  - base ref
  - base SHA
  - dispatch id
  - config snapshot id
  - marker version
- Marker parser must reject raw branch strings outside canonical encoding.
- Updating an old summary requires:
  - stored comment id, or
  - expected bot/app author identity and matching canonical marker.
- If marker ownership is ambiguous, create a new safe summary and record health.

Tests:

- User-authored comment with copied marker is not updated.
- Bot-authored comment with wrong repo id is not updated.
- Bot-authored comment with wrong head SHA is not updated.
- Marker parser rejects malformed metadata.
- Summary body never includes raw nonce or posting token.

### Phase 10: Inline Comments

Inline comments are useful but must degrade safely.

Requirements:

- Cap inline comments per run.
- Use modern GitHub review comment coordinates where available.
- Do not post inline comments for files or lines without trustworthy mapping.
- If position mapping is stale or rejected, degrade to summary-only.
- If secondary rate limit occurs, stop posting inline comments and report
  partial/degraded result in summary and health.
- Never leave an unsubmitted pending review.
- Prefer individual review comments or submitted `COMMENT` review only if the
  implementation guarantees `event` is always provided.

Tests:

- Invalid line coordinates degrade to summary-only.
- Secondary rate limit stops inline posting.
- Pending review is never left open.
- Finding for deleted/renamed file does not crash posting.

### Phase 11: Advisory Status Or Check

Conflict review output must be visible but must not replace normal required
review.

Recommended v1:

- Use commit status first if existing App profile has `statuses: write`.
- Context: `ReviewRouter conflict review`.
- Post to expected head SHA.
- Keep it advisory and document that it is not a merge gate.

Requirements:

- Do not use the normal required ReviewRouter context.
- Do not post to default branch SHA or `github.sha`.
- Do not post to merge group SHA.
- Status/check state is computed by runtime policy, not model output.
- Target URL points to a safe run or ReviewRouter page.
- If summary succeeds but status fails, record degraded health.
- Do not silently omit PR-visible status/check.

Tests:

- Status posts to expected head SHA.
- Status context cannot be model-controlled.
- Status failure is visible as degraded health.
- Status webhook for conflict context does not enqueue review work.
- Old status on same head SHA does not make a new PR/base attempt current.

### Phase 12: Health And Telemetry

Telemetry must help debug without leaking sensitive data.

Record:

- attempt id
- dispatch id
- run id and run attempt
- safe status
- safe reason code
- phase
- elapsed time
- bounded counts
- GitHub ids
- hashes
- degradation reason

Do not record:

- raw nonce
- OIDC token
- GitHub App token
- posting token
- full diff
- full prompt
- full model output
- raw secret values

Tests:

- Error summaries redact nonce.
- Health route rejects oversized payload.
- Health route rejects control fields from model output.
- Health records stale exit without posting.

## Edge Cases

### PR Conflict Resolves Before Dispatch

Expected behavior:

- Conflict detector may have recorded an attempt.
- Runtime preflight or pre-post validation sees conflict is no longer current.
- Runtime exits stale without comments.
- System may enqueue or suggest normal review recheck if supported.

Risk:

- Posting a conflict summary after conflict resolution confuses users.

Mitigation:

- Validate immediately before posting.

### Base Branch Moves During Review

Expected behavior:

- Attempt remains tied to expected base ref and base SHA semantics.
- If current base no longer matches, runtime exits stale.
- New reconciliation can create a new attempt if conflict still exists.

Risk:

- Reviewing against an old base and posting as current.

Mitigation:

- Include base ref and base SHA in attempt, marker, posting scope, and
  pre-post validation.

### PR Head Moves During Review

Expected behavior:

- Runtime exits stale before posting.
- No summary, inline comments, or success/failure conflict status is posted for
  the old attempt.

Risk:

- Old comments appear as current for a newer commit.

Mitigation:

- Head SHA validation before checkout, before model execution, before summary,
  and before final status/check.

### PR Closes Or Becomes Draft

Expected behavior:

- Runtime exits without comments or terminal success/failure status.
- Health records `pr_not_reviewable`.

Risk:

- Bot posts noise on closed or draft PRs.

Mitigation:

- Pre-post validation must include open, unmerged, non-draft state.

### Fork PR

Expected behavior:

- Current v1 skips unsupported fork PRs.
- Do not use conflict fallback to bypass fork trust policy.

Risk:

- Untrusted fork code gets access to runtime secrets.

Mitigation:

- Keep fork skip in detection and revalidate in runtime.

### Repository Rename Or Transfer

Expected behavior:

- Trust identity remains GitHub repository id and installation id.
- Repository full name is refreshed for API coordinates only.

Risk:

- Posting to wrong repo after rename/transfer.

Mitigation:

- Validate immutable ids before posting.

### Two PRs Share Same Head SHA

Expected behavior:

- Summary comments and attempt records are PR-scoped.
- Advisory status is head-SHA visible and not source of truth.

Risk:

- Status on a shared head SHA is misread as current for another PR/base pair.

Mitigation:

- Product logic never uses status/check alone to infer current conflict review.

### Duplicate Webhooks

Expected behavior:

- Existing attempt idempotency prevents duplicate dispatch for same semantic
  attempt.
- Retries rotate nonce and dispatch id only when safe.

Risk:

- Duplicate comments or duplicate status churn.

Mitigation:

- Posting checkpoints and unique attempt keys.

### Manual Repository Dispatch

Expected behavior:

- Control plane rejects without a valid attempt and nonce.
- No provider-backed config or posting session is returned.

Risk:

- Someone triggers trusted runtime manually.

Mitigation:

- Conflict-specific OIDC path plus nonce-bound attempt record.

### Workflow Shape Drift

Expected behavior:

- Capability analyzer detects unsupported workflow and runtime config is denied.

Risk:

- User edits workflow to add broad permissions or unsafe steps.

Mitigation:

- Capability validation at dispatch time and OIDC/config time.

### Explicit Workflow Users

Expected behavior:

- Conflict fallback remains unsupported until pre-secret validation exists.

Risk:

- Explicit workflows can run arbitrary steps before trusted preflight.

Mitigation:

- Existing fail-closed behavior must remain.

### Secondary Rate Limits

Expected behavior:

- Stop inline comments.
- Preserve summary.
- Post advisory degraded status if safe.

Risk:

- Repeated retries increase rate limiting and duplicate comments.

Mitigation:

- Inline cap, backoff, checkpointed fingerprints, and terminal-state-aware
  retry.

### Provider Runtime Failure

Expected behavior:

- No findings are posted.
- A safe advisory failure/degraded status may be posted only after pre-post
  validation and posting capability issuance.

Risk:

- Failure details leak prompt, diff, or secrets.

Mitigation:

- Safe error summaries only.

## Security Invariants

1. `repository_dispatch.client_payload` is never authority.
2. Conflict mode cannot exchange normal runtime config.
3. Normal review cannot request conflict mode.
4. Runtime cannot post before pre-post validation.
5. Runtime cannot obtain posting capability before model execution.
6. Provider subprocesses cannot see OIDC or posting secrets.
7. Model output cannot control status, context, URL, marker, comment id, retry,
   approval, or request-changes behavior.
8. Summary marker is a selector only, not a trust anchor.
9. App/bot author identity must be verified before updating old comments.
10. Status/check is advisory and not source of truth.
11. Required workflow is unchanged.
12. Explicit workflow support remains disabled for conflict fallback.
13. Self-hosted runner support remains disabled unless a dedicated policy is
    added later.
14. Raw nonce and tokens are never logged or stored.
15. Full diff and full prompt are not persisted.

## Permission Notes

No new permission is required for `repository_dispatch` if the installed App
already has `contents: write`.

For advisory output:

- Commit status requires `statuses: write`.
- Issue summary comments require issue or pull request comment capability used
  by the existing ReviewRouter posting path.
- Check runs would require `checks: write` if chosen later.

Do not confuse GitHub App permissions with operation scope. Even if GitHub can
issue a repository-scoped installation token, ReviewRouter must enforce the
one-PR, one-head-SHA, one-base-ref/SHA, one-context, and one-comment-id limits.

## Local Verification Plan

Local tests can prove most control-plane and runtime policy behavior.

Required local commands:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm architecture:check
pnpm --filter @reviewrouter/platform-db exec prisma validate --config prisma.config.ts
pnpm github-app:manifest:smoke
git diff --check
pnpm build
```

Additional targeted tests:

```bash
pnpm exec vitest run packages/features/action-control-plane/src/tests/action-control-plane.test.ts
pnpm exec vitest run packages/features/conflict-review/src/tests/conflict-review.test.ts
pnpm exec vitest run packages/features/workflow-provisioning/src/tests/workflow-template.test.ts
```

Local verification cannot fully prove:

- GitHub-issued OIDC claim shape for repository dispatch.
- GitHub Actions default-branch workflow behavior.
- Actual status/comment/check side effects.
- Installation permission behavior on real repositories.
- Secondary rate limit behavior.

Those require a disposable GitHub repository smoke test.

## GitHub E2E Smoke Plan

Use a clearly disposable repository. Reuse an existing disposable repository if
available. Do not create many one-off repositories.

Scenario:

1. Install or configure the ReviewRouter App for the disposable repository.
2. Provision the generated reusable workflow with conflict fallback enabled.
3. Create a base branch.
4. Create a PR branch with a conflict against base.
5. Open PR and confirm GitHub reports conflict.
6. Confirm ReviewRouter records a conflict attempt.
7. Confirm outbox dispatches `repository_dispatch`.
8. Confirm workflow starts from default branch.
9. Confirm runtime exchanges OIDC successfully.
10. Confirm exact head SHA is reviewed.
11. Confirm summary says head-only conflict review.
12. Confirm advisory status/check posts to head SHA.
13. Push a new commit while runtime is running and confirm stale exit.
14. Retarget base while runtime is running and confirm stale exit.
15. Close PR while runtime is running and confirm no comments.
16. Re-deliver webhook and confirm no duplicate comments.

E2E pass criteria:

- No normal required context is posted by conflict mode.
- No duplicate summary appears after retry.
- No raw nonce appears in logs, health, or comments.
- Old attempts become stale after head/base changes.
- Feature can be disabled by flag without leaving stuck jobs.

## Rollout Plan

### Stage 0: Code merged, flag off

- Runtime code is present.
- Production behavior unchanged.
- Monitoring dashboards include conflict attempt and degraded health counts.

### Stage 1: Internal disposable repositories

- Enable flag only for internal test environment.
- Run E2E matrix:
  - simple conflict
  - large diff
  - binary file
  - head moves during run
  - base moves during run
  - PR closes during run
  - duplicate webhook delivery
  - model failure
  - status posting failure

### Stage 2: Limited beta

- Enable per workspace or per repository if the config supports it.
- Keep status advisory.
- Track:
  - dispatch count
  - started count
  - stale count
  - posted summary count
  - degraded posting count
  - duplicate suppression count
  - OIDC rejection count
  - capability rejection count

### Stage 3: Production default

Only after:

- No unsafe posting incidents in beta.
- No duplicate comment incidents in beta.
- No unsupported workflow false positives at meaningful scale.
- Runbooks exist for disabling the flag and replaying dead-letter attempts.

## Implementation Checklist

Runtime contract:

- [ ] Add explicit `conflict-head` runtime mode.
- [ ] Reject conflict mode from non-`repository_dispatch` events.
- [ ] Validate all conflict inputs.
- [ ] Mask nonce before any logs.
- [ ] Return conflict metadata from server state, not raw payload.

OIDC and config:

- [ ] Use ReviewRouter-specific OIDC audience.
- [ ] Validate run identity and workflow refs.
- [ ] Bind nonce to run identity.
- [ ] Keep config exchange and posting exchange as separate purposes.
- [ ] Reject self-hosted runners in v1.

Checkout and diff:

- [ ] Checkout exact expected head SHA.
- [ ] Disable persisted credentials.
- [ ] Disable caches/artifacts for conflict data.
- [ ] Validate PR state before checkout.
- [ ] Build bounded diff against expected base.
- [ ] Exit stale if base/head changed.

Model isolation:

- [ ] Add provider env allowlist.
- [ ] Exclude OIDC, GitHub, nonce, and posting secrets.
- [ ] Validate model output schema.
- [ ] Strip or reject model control fields.
- [ ] Bound findings and summary sizes.

Posting:

- [ ] Add conflict posting session/proxy.
- [ ] Scope posting to repository, PR, head SHA, base ref, base SHA, context, and
      comment id.
- [ ] Add pre-post validation before session issuance.
- [ ] Add pre-status validation before final advisory status.
- [ ] Add summary marker parser and ownership checks.
- [ ] Add inline comment cap and summary-only degradation.
- [ ] Add advisory status/check posting.
- [ ] Add posting checkpoints.

Webhook loop prevention:

- [ ] Ignore conflict advisory status/check webhook as review trigger.
- [ ] Ignore ReviewRouter-authored conflict summary comment as interaction
      trigger.
- [ ] Ignore repository_dispatch webhook as review trigger.

Tests:

- [ ] Unit tests for all runtime mode validation.
- [ ] Unit tests for posting session scope.
- [ ] Unit tests for pre-post stale exits.
- [ ] Unit tests for marker ownership.
- [ ] Unit tests for duplicate suppression.
- [ ] Integration tests for action-control-plane conflict posting exchange.
- [ ] Workflow template tests for no broad write permissions.
- [ ] E2E disposable repository smoke.

Docs and operations:

- [ ] Add runbook for disabling conflict fallback.
- [ ] Add health reason code list.
- [ ] Add dashboard or logs for degraded posting.
- [ ] Document advisory status semantics.

## Acceptance Gates

The feature is production-enableable only when all gates are true:

1. Runtime performs conflict OIDC preflight before checkout.
2. Runtime never exposes posting capability to provider/model subprocesses.
3. Runtime reviews exact expected head SHA.
4. Runtime exits stale before posting when head/base/PR state changes.
5. Runtime posts only advisory output.
6. Runtime never posts normal required ReviewRouter context.
7. Runtime never uses generic normal comment token.
8. Posting session is scoped to one attempt and one allowed operation set.
9. Summary update verifies stored id or trusted app/bot author identity.
10. Duplicate webhook delivery does not duplicate comments.
11. Crash/retry after partial posting resumes safely.
12. Raw nonce and tokens do not appear in logs, comments, health, or database
    safe summaries.
13. Full local test suite passes.
14. Disposable GitHub E2E smoke passes.
15. Feature flag rollback is tested.

## Most Dangerous Areas

| Area                                 | Severity | Bug likelihood | Mitigation                                                     |
| ------------------------------------ | -------: | -------------: | -------------------------------------------------------------- |
| Posting token too broad              |    10/10 |           6/10 | Use scoped posting proxy/session, never generic comment token. |
| Stale PR state before posting        |     9/10 |           7/10 | Validate before summary and before status.                     |
| Model controls posting behavior      |     9/10 |           5/10 | Strict output schema and runtime-owned policy.                 |
| Unsafe checkout target               |     9/10 |           5/10 | Exact head SHA, no mutable refs, no credentials.               |
| OIDC allowlist too broad             |     9/10 |           4/10 | Conflict-specific repository_dispatch validation.              |
| Duplicate comments after retry       |     8/10 |           7/10 | Posting checkpoints and fingerprints.                          |
| User marker spoofing                 |     8/10 |           5/10 | Verify stored id or app/bot author identity.                   |
| Workflow shape drift                 |     8/10 |           5/10 | Capability validation at dispatch and config exchange.         |
| Fork PR secret exposure              |    10/10 |           3/10 | Keep fork skip and runtime revalidation.                       |
| Status/check interpreted as required |     7/10 |           5/10 | Separate context and product source-of-truth rule.             |

## Recommended Next Work Item

Implement the runtime contract and OIDC preflight first. Do not start with
posting. Posting is the most dangerous layer, and it should depend on a runtime
session that already proves the run identity, dispatch attempt, workflow shape,
and config snapshot.

Suggested first PR after the control-plane branch:

1. Add `conflict-head` runtime mode parser.
2. Add runtime OIDC preflight call before checkout.
3. Add exact conflict input validation and nonce masking.
4. Add tests proving conflict mode cannot run from normal events.
5. Add tests proving no checkout/model step runs before preflight.

Only after that should the posting proxy/session be implemented.
