# Conflict Pull Request Review Fallback

## Problem

GitHub does not create normal `pull_request` workflow runs for pull requests
that cannot be merged because of conflicts. That means ReviewRouter can miss
exactly the pull requests where an early review is still useful.

The goal is not to replace normal pull request review. The goal is to add a
narrow fallback that reviews the PR changes when GitHub cannot build the merged
tree yet.

Important distinction:

```text
Normal PR review
  Reviews the pull request in the regular GitHub pull_request workflow context.

Conflict PR review
  Reviews PR head changes against the base branch.
  It does not claim to review the final resolved merge result.
```

The final resolved merge result only exists after a human resolves the conflict.
Until then, ReviewRouter can still review changed code and point out bugs, but it
must label the result honestly.

## Recommended Design

Use `repository_dispatch` as a controlled conflict fallback:

```text
GitHub pull_request webhook
  -> SaaS conflict detector
  -> SaaS idempotency record
  -> repository_dispatch: reviewrouter_conflict_review
  -> trusted generated caller workflow on default branch
  -> ReviewRouter runtime in conflict-head mode
  -> separate commit status/check and summary
```

Overall score:

```text
🎯 9   🛡️ 9   🧠 8
```

Estimated implementation size:

```text
800-1,300 changed lines with tests
```

Why this is the best fit:

- It keeps the current security model: customer code, diffs, prompts, and
  provider secrets stay in customer GitHub Actions.
- It avoids `pull_request_target`.
- It avoids a new GitHub App `Actions: write` permission request.
- It uses the existing GitHub App `Contents: write` permission for
  `repository_dispatch`.
- It lets SaaS orchestrate without running model review itself.
- It can be made idempotent and observable.

## Review Corrections After Threat Modeling

These points are not optional implementation polish. They are the guardrails that
keep the feature from creating production bugs:

```text
1. Conflict review must never use the normal ReviewRouter check/status context.
2. Provider-backed conflict review must require a valid SaaS fallback record and nonce.
3. The workflow must have an explicit token path for posting status/check output.
4. Diff source should prefer GitHub PR files/diff data, not a naive local compare.
5. Raw repository_dispatch payload must never be interpolated into shell scripts.
6. Fallback support must be capability-gated before dispatch.
7. A dispatched run must mark itself started through OIDC, not rely only on API polling.
8. v1 fallback must not be enabled for explicit workflows until a pre-secret
   validation path exists.
9. `reviewrouter-required.yml` must not receive a `repository_dispatch` trigger.
10. GitHub dispatch and retry work must use the existing outbox/idempotency
    pattern, not long database transactions around external calls.
11. Incoming `repository_dispatch` webhooks must not become review triggers.
12. Adding `repository_dispatch` to OIDC validation must not open generic normal
    runtime config exchange.
13. `workflow_dispatch` manual runs must stay normal-review only unless a future
    design adds a separate trusted rerun path.
14. Base-branch pushes must be considered, because a PR can become conflicted
    without a PR head update.
15. Commit statuses are append-only. Conflict status posting must avoid status
    churn and must switch to checks if richer lifecycle updates are needed.
16. Conflict mode must not read ReviewRouter policy/config from the PR head.
17. Pre-post validation must re-check full PR state, not only head/base ref/SHA.
18. Repository identity must be based on immutable GitHub repository id to handle
    rename or transfer races.
19. Checkout must explicitly disable PR-controlled submodules, LFS, hooks, and
    dependency caches.
20. GitHub tokens, dispatch nonce, prompts, diffs, provider output, and model
    output must not leak through subprocess environment, logs, caches, artifacts,
    or health reports.
21. Conflict workflow steps must be minimal and action refs must be
    policy-compatible. Prefer full-length commit SHA pins in generated workflow
    output; examples may show major tags only for readability.
22. Write-capable `GITHUB_TOKEN` scopes must not be globally available to
    checkout, model execution, provider subprocesses, or arbitrary `uses:` steps.
    Prefer an OIDC-issued scoped posting token after runtime validation.
23. Idempotency must include `base_ref` and `base_sha`, not only `head_sha`,
    because the same PR head can need a new conflict review after the base branch
    or target branch changes.
24. Dispatch nonce is runner-visible once the workflow starts. Treat it as a
    replay/correlation guard, not as the primary secret. OIDC claims, trusted
    workflow identity, run identity, and exchange ordering must carry the trust.
25. Conflict detection must use a positive conflict signal. Do not treat every
    non-mergeable or blocked PR as a merge-conflict PR.
26. Hidden comment markers are selectors, not trust anchors. Verify comment
    author/app identity and stored comment ids before updating any old comment.
27. Conflict review must not submit an approving GitHub review or an unintended
    `REQUEST_CHANGES` review decision. Use advisory comments plus the separate
    conflict status/check.
28. Idempotency and stale checks must include `base_ref` as well as `base_sha`.
    Retargeting a PR to a different base branch with the same SHA can still
    change policy and product semantics.
29. Merge queue and `merge_group` checks are separate normal-review semantics.
    Conflict fallback must never post to a merge-group SHA or reuse a required
    check/job name in a way that creates ambiguous required status checks.
30. A raw GitHub App installation token is not PR-scoped. GitHub can narrow it
    by repository and permissions, but ReviewRouter must enforce PR, head SHA,
    base ref/SHA, context, and comment-id scope in the control plane or posting
    proxy.
31. Workflow concurrency must not use `client_payload`, PR numbers, branch names,
    or public marker/attempt ids as cancellation keys. GitHub evaluates
    concurrency before runtime validation.
32. PR-visible status/check output is not the source of truth for fallback
    identity. GitHub commit statuses are SHA/context-scoped, so ReviewRouter
    must keep PR/base identity in its own attempt record and must not let the
    conflict context become a required merge gate.
33. Model/provider output is untrusted review data, not control data. It must
    never choose status state, status context, target URL, comment id, hidden
    marker, posting token, retry behavior, or whether a run is current.
34. Runtime config, provider routing, prompt policy, and blocking policy must be
    an immutable snapshot per attempt. Do not let config changes mid-run change
    posting decisions for already-generated findings.
35. GitHub posting must be crash-safe and checkpointed. A runner crash after
    summary, inline comments, review submission, or status/check posting must
    resume without duplicate comments, unsubmitted pending reviews, or false
    terminal status.
36. Conflict resolution without a new PR head commit must not be silently treated
    as normally reviewed. If the base branch update makes the PR mergeable, the
    system must surface or enqueue a normal-review recovery path, not reuse
    conflict-head review.
```

If any of these cannot be implemented cleanly, the feature should stay disabled.

## Non-Goals

- Do not make conflict review a replacement for the normal required review.
- Do not execute code from the PR branch.
- Do not review fork PRs with secret-backed providers in the first release.
- Do not silently dispatch into repositories whose workflow does not support the
  fallback.
- Do not trust `repository_dispatch.client_payload` as authority.
- Do not claim that the final merge result was reviewed.
- Do not allow a random/manual `repository_dispatch` to obtain provider-backed
  runtime config.
- Do not interpolate untrusted PR titles, branch names, labels, or dispatch
  payload fields directly into shell commands.
- Do not add conflict fallback to `reviewrouter-required.yml`.
- Do not enable conflict fallback for explicit generated workflows until their
  secret setup and runtime validation order is separately redesigned.
- Do not allow `repository_dispatch` to fetch normal runtime config without a
  conflict fallback record.
- Do not use `workflow_dispatch` as a manual conflict-review bypass in v1.
- Do not resolve ReviewRouter provider policy, limits, or trusted workflow
  capability from files checked out from the PR head.
- Do not upload conflict-mode artifacts containing code, diffs, prompts, model
  output, provider output, tokens, or nonce values.
- Do not pass `GITHUB_TOKEN`, app tokens, or dispatch nonce to model/provider
  subprocesses.
- Do not add arbitrary third-party actions, PR-head local actions, or composite
  actions from the checked-out PR workspace to the conflict workflow.
- Do not generate top-level write permissions for the whole workflow.
- Do not expose write-capable `GITHUB_TOKEN` scopes to model/provider execution
  when a narrower ReviewRouter OIDC posting capability can post
  comments/statuses.
- Do not describe a raw GitHub App installation token as scoped to a single PR,
  SHA, status context, or comment id. If that granularity is needed, enforce it
  in ReviewRouter's posting service.
- Do not treat `client_payload.nonce` as secret after the workflow starts. It is
  readable from the event payload by any step in the job.
- Do not use `client_payload`, PR numbers, branch names, or marker/attempt ids in
  `cancel-in-progress` workflow concurrency groups.
- Do not run checkout, package managers, provider/model subprocesses, local
  actions, or nonessential external actions before the trusted ReviewRouter
  OIDC preflight/config exchange.
- Do not edit comments based only on a hidden marker string found in PR
  comments.
- Do not use GitHub review approval state as the conflict-mode result.
- Do not emit both a commit status and a check run with the same conflict
  context/name.
- Do not create GitHub pull request reviews in `PENDING` state in v1. If review
  APIs are used, set `event=COMMENT` explicitly and record the returned review
  id.
- Do not make `ReviewRouter conflict review` a required branch-protection check.
  It is advisory and SHA-visible, not PR/base-ref scoped.
- Do not let model/provider output or PR-controlled markdown/HTML create,
  modify, duplicate, or hide ReviewRouter control markers.
- Do not let model/provider output choose posting destinations, status/check
  state, status/check context, target URL, comment ids, or retry decisions.
- Do not mix config snapshots in one fallback attempt. The model run, finding
  validation, summary rendering, status/check conclusion, and posting token
  exchange must agree on the same trusted config snapshot id/hash.
- Do not let `resolved_before_review` become a quiet terminal success. It means
  conflict fallback is no longer applicable and normal review still needs to be
  considered.
- Do not let self-authored conflict summary comments trigger interaction
  workflows or slash-command processing.

## Architecture Fit and Ownership

The implementation should follow the existing feature-first architecture rather
than adding a cross-cutting helper that knows about everything.

Recommended ownership:

| Area                              | Owner module or package                            | Responsibility                                                               |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Webhook ingestion                 | `apps/api/src/github` + GitHub installation code   | Verify delivery, normalize PR events, enqueue work only                      |
| Conflict fallback orchestration   | new bounded context, for example `conflict-review` | Mergeability polling, idempotency, dispatch records, rate limits             |
| Durable async execution           | existing outbox worker                             | Process detection and dispatch jobs, retry safely                            |
| Workflow rendering and capability | `packages/features/workflow-provisioning`          | Render trigger/inputs/permissions and expose trusted capability version/hash |
| Runtime config exchange           | `packages/features/action-control-plane`           | OIDC validation, nonce validation, runtime config, safe health metadata      |
| Provider/config policy            | existing review config and provider setup modules  | Reuse provider limits and secret setup state, do not duplicate policy        |
| GitHub API calls                  | infrastructure ports inside the owning feature     | PR fetch, PR files, dispatch event, statuses                                 |
| Review runtime                    | ReviewRouter action/reusable workflow runtime      | Conflict-head validation, diff building, posting, model process isolation    |

No-duplication rules:

- Do not put mergeability polling inside workflow provisioning. Workflow
  provisioning only describes whether a repository can run the fallback.
- Do not put dispatch records inside action-control-plane. Action-control-plane
  verifies runtime identity and nonce, but the conflict fallback feature owns the
  attempt lifecycle.
- Do not teach repo-health that conflict success means normal review success.
  Conflict health is separate metadata.
- Do not duplicate provider budget checks. Reuse the existing entitlement,
  provider limit, and rate-limit ports.
- Do not dispatch directly from the webhook HTTP request. Enqueue an outbox job.
- Do not keep a database transaction open while calling GitHub.

Outbox sequence:

```text
1. webhook handler records delivery and enqueues conflict-detection job
2. worker fetches fresh PR mergeability
3. transaction records fallback attempt and dispatch intent
4. transaction commits
5. worker calls GitHub repository_dispatch
6. transaction records dispatched or dispatch_failed
7. runtime OIDC config exchange marks started
8. runtime health/status report marks terminal state
```

This matches ADR-007 and avoids a common production bug: a GitHub API timeout
rolling back the same database row that should have made the retry idempotent.

## Permission Decision Matrix

| Need                              | Recommended mechanism                           | New GitHub App permission?                                                      |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Start fallback workflow           | `repository_dispatch` with installation token   | No, if `Contents: write` is already granted                                     |
| App-invoked workflow alternative  | `workflow_dispatch` REST API                    | Yes, requires `Actions: write`                                                  |
| User-clicked manual workflow run  | GitHub UI `workflow_dispatch`                   | No app permission, but it must stay normal-review only                          |
| Detect base-push conflicts        | `push` webhook or scheduled open-PR scan        | No repository permission, but app event subscription changes                    |
| PR-visible conflict status        | preferred: ReviewRouter OIDC posting capability | No, if current App profile already has `statuses: write`                        |
| PR-visible conflict check run     | preferred: ReviewRouter OIDC posting capability | No, if current App profile already has `checks: write`                          |
| SaaS/App posts status itself      | GitHub App installation token                   | No if current standard profile already has statuses/checks write; otherwise yes |
| Existing summary/comment identity | existing ReviewRouter comment token path        | No new app permission if current comment flow already works                     |

Recommended v1 permission answer:

```text
No new GitHub App permission for conflict fallback itself.
Use repository_dispatch through existing Contents: write.
Prefer posting PR-visible conflict output through the existing OIDC/control-plane
path, extended to a narrow ReviewRouter posting capability if needed.
Only use workflow GITHUB_TOKEN posting as an explicit fallback with job-level
write permissions and trusted/pinned actions.
If near-real-time base-push conflict detection is required, add a GitHub App
push event subscription. That is not a new repository permission, but it is a
visible app configuration rollout.
```

Only request a new app permission if the product deliberately chooses SaaS-side
status/check posting later and the installed App profile does not already include
the needed status/check permission.

## Event and Permission Choice

### Option 1: `repository_dispatch`

```text
🎯 9   🛡️ 9   🧠 7
Estimated change: 800-1,300 lines
```

This is the recommended path.

GitHub App permission:

```text
Contents: write
```

The app manifest already requests `contents: write`, so this should not require
a new permission approval for existing installations that already granted it.

Workflow trigger:

```yaml
on:
  repository_dispatch:
    types: [reviewrouter_conflict_review]
```

Pros:

- Trusted workflow comes from the default branch.
- No `pull_request_target`.
- No `Actions: write` permission.
- Fits the current SaaS orchestration model.
- Can be gated by SaaS records and OIDC.

Cons:

- The GitHub Actions run itself is not naturally attached to the PR in the same
  way as a `pull_request` run.
- ReviewRouter should create a separate status/check on the PR head SHA for UX.
- Existing customer workflows need an update before this works.
- The workflow runs from the default branch context. This is good for trust, but
  it means all PR identity must be passed as untrusted input and revalidated.
- Posting a PR-visible status/check needs either a ReviewRouter OIDC posting
  capability or explicit job-level `statuses: write` / `checks: write` workflow
  permissions. Prefer the ReviewRouter capability path to avoid exposing write
  `GITHUB_TOKEN` to the review job.

### Option 2: `workflow_dispatch`

```text
🎯 7   🛡️ 8   🧠 6
Estimated change: 350-650 lines
```

GitHub App permission:

```text
Actions: write
```

Pros:

- Directly invokes the review workflow.
- Inputs are familiar.

Cons:

- Requires a new permission approval.
- Adds higher-friction onboarding and migration.
- Gives the GitHub App more authority than this feature needs.

This option is not recommended unless `repository_dispatch` proves inadequate.

### Option 3: `pull_request_target`

```text
🎯 6   🛡️ 5   🧠 5
Estimated change: 150-300 lines
```

Pros:

- It runs even when the PR has conflicts.
- It is simpler to wire up.

Cons:

- It expands the trusted execution surface.
- It is easy for future changes to accidentally execute untrusted PR code with
  secrets or write tokens available.
- It conflicts with the current ReviewRouter setup copy and tests that emphasize
  `pull_request`, not `pull_request_target`.

This option is not recommended for the default product path.

## Required Product Semantics

Conflict review must be visibly different from normal review.

Recommended status/check context:

```text
ReviewRouter conflict review
```

Recommended summary text:

```text
Reviewed the PR changes against the base branch.
The final resolved merge result should be reviewed again after conflicts are fixed.
```

Do not use the normal `ReviewRouter` context for this fallback. The normal context
should stay reserved for regular PR review.

The practical behavior should be:

```text
Conflict PR opened/updated
  -> conflict fallback may run
  -> posts useful review comments
  -> separate advisory conflict status/check appears on the head SHA

Conflict resolved
  -> normal pull_request workflow runs when GitHub emits a normal PR event
     or when ReviewRouter later adds an explicit normal-review rerun path
  -> regular ReviewRouter review runs
  -> normal required check is evaluated
```

Do not assume that conflict resolution always creates a new normal PR workflow
run. If the conflict disappears because the base branch changed, the PR head may
not change and GitHub may not create a new `pull_request` run. That is a separate
normal-review rerun problem and must not be hidden by the conflict fallback.

The conflict status/check is a visibility surface, not a merge gate. Its latest
state must never replace ReviewRouter's stored PR/base fallback attempt when
deciding whether the current PR state was reviewed.

## Risk Register

| Risk                                                    | Impact | Likelihood | Score | Required control                                                          |
| ------------------------------------------------------- | -----: | ---------: | ----: | ------------------------------------------------------------------------- |
| False green under normal ReviewRouter context           |     10 |          6 |    10 | Separate `ReviewRouter conflict review` context only                      |
| PR-controlled code executes with secrets available      |     10 |          4 |    10 | Read-only checkout, no package scripts, trusted runtime only              |
| Manual or spoofed dispatch obtains config               |      9 |          5 |     9 | SaaS fallback record + nonce + OIDC validation                            |
| `repository_dispatch` opens normal config exchange      |     10 |          4 |     9 | Context-specific OIDC validation, dispatch only for conflict-head         |
| Dispatch nonce leaks through logs/health metadata       |      8 |          4 |     8 | Mask nonce, never log it, short TTL, run-bound exchange                   |
| Stale run comments after a new commit or retarget       |      8 |          7 |     9 | Head/base ref/SHA validation before review and before posting             |
| PR closes or becomes draft before posting               |      7 |          5 |     8 | Full PR state validation immediately before comments/status               |
| PR head controls ReviewRouter config/policy             |      9 |          4 |     9 | Resolve config from SaaS/default branch/trusted workflow only             |
| Duplicate summaries/inline comments                     |      7 |          7 |     8 | DB idempotency + markers + fingerprints + stale guards                    |
| Status/check cannot be posted to PR head                |      7 |          5 |     8 | Explicit status/check token path and fallback behavior                    |
| Wrong/noisy diff from base/head comparison              |      7 |          5 |     8 | Prefer PR files/diff API, validate changed-line mapping                   |
| PR files API pagination/truncation hides changes        |      7 |          5 |     8 | Fetch all pages, detect limits, degrade clearly                           |
| Base branch push creates conflict with no PR webhook    |      8 |          6 |     9 | Default-branch push reconciliation or scheduled open-PR scan              |
| Workflow trigger missing in existing repo               |      6 |          7 |     8 | Capability detection before dispatch                                      |
| Reusable workflow blocked by org Actions policy         |      7 |          4 |     8 | Capability/health state, no_run_observed, remediation copy                |
| OIDC allowlist too broad                                |      9 |          3 |     8 | Add only `repository_dispatch`, keep workflow refs narrow                 |
| Payload or PR metadata causes shell injection           |      9 |          3 |     8 | Pass through env/JSON, validate in Node/runtime, no inline interpolation  |
| Fork PR gets secret-backed review                       |      9 |          2 |     8 | Same-repo only in v1                                                      |
| Old repository_dispatch rerun reuses stale nonce        |      8 |          5 |     8 | Bind nonce to dispatch record and GitHub run identity                     |
| Conflict mode accepted from interaction workflow        |      8 |          4 |     8 | Conflict config exchange allows review workflow only                      |
| Conflict status creates webhook feedback loops          |      7 |          5 |     8 | Treat conflict status/check contexts as terminal metadata, not triggers   |
| Conflict status pollutes normal repo health             |      7 |          5 |     8 | Store conflict health separately from normal ReviewRouter health          |
| Arbitrary workflow at allowed path fetches config       |      9 |          3 |     8 | Require known-good reusable workflow shape and trusted job_workflow_ref   |
| Trusted reusable workflow ref drifts after probe        |      8 |          4 |     8 | Validate `job_workflow_sha` against capability manifest at exchange time  |
| Explicit workflow runs secret setup before validation   |      9 |          4 |     8 | v1 enable only trusted reusable caller or add pre-secret preflight first  |
| Required workflow receives conflict trigger             |      8 |          3 |     8 | Never add `repository_dispatch` to `reviewrouter-required.yml`            |
| Manual workflow_dispatch bypasses conflict guards       |      8 |          4 |     8 | workflow_dispatch remains normal-review only in v1                        |
| `repository_dispatch` webhook re-enters pipeline        |      7 |          4 |     7 | Ignore as trigger, accept only safe telemetry if needed                   |
| GitHub dispatch call is inside DB transaction           |      7 |          4 |     7 | Outbox intent first, external call after commit                           |
| Failed attempt retry duplicates comments                |      7 |          4 |     7 | Retry taxonomy + same marker/fingerprint/stale guards                     |
| Crash between posting steps duplicates or loses state   |      8 |          5 |     9 | Posting manifest, per-artifact checkpoints, resume-safe writes            |
| Pending GitHub review is left unsubmitted               |      7 |          3 |     7 | Never omit review `event`; v1 uses issue comments or submitted COMMENT    |
| Inline comment burst hits secondary rate limits         |      6 |          5 |     7 | Cap inline comments, backoff, summary-only degradation                    |
| Self-hosted runner keeps PR workspace state             |      8 |          3 |     7 | GitHub-hosted default, clean workspace requirement for self-hosted        |
| Branch protection waits on wrong status forever         |      7 |          4 |     7 | Do not auto-require conflict context, publish clear status semantics      |
| Commit status context hits GitHub per-SHA limit         |      5 |          4 |     6 | Stable single context, update checks when needed, avoid status spam       |
| Append-only statuses create misleading lifecycle        |      6 |          5 |     7 | One terminal status per attempt, use checks for mutable lifecycle         |
| Repository rename/transfer races dispatch/runtime       |      7 |          4 |     7 | Use repository id as authority, refresh full name before GitHub calls     |
| PR-controlled submodule/LFS/cache content is fetched    |      8 |          3 |     7 | Explicit checkout options, no submodules/LFS, no dependency caches        |
| Token or prompt leaks via logs/artifacts/subprocesses   |      9 |          3 |     8 | Narrow env, no artifact upload, redaction, process isolation              |
| Model output controls posting behavior                  |      9 |          4 |     9 | Strict output schema, runtime-computed status/marker/comment ids          |
| Model echoes hidden marker or PR HTML into summary      |      7 |          5 |     8 | Runtime owns marker footer, reject/escape marker namespace collisions     |
| Model/PR text triggers noisy mentions or huge comment   |      5 |          6 |     6 | Sanitize mentions, bound lengths, split or truncate safely                |
| Config changes mid-run alter blocking/posting result    |      8 |          5 |     9 | Bind attempt to immutable config/prompt/provider snapshot                 |
| Retry uses different policy under same markers          |      7 |          4 |     8 | Same attempt reuses snapshot; new snapshot requires new attempt semantics |
| Workflow action ref is mutable or blocked by policy     |      8 |          4 |     8 | Minimal trusted actions, full SHA pins or documented policy fallback      |
| Write `GITHUB_TOKEN` visible to review/model steps      |      9 |          4 |     9 | Job-level permissions or ReviewRouter posting capability after validation |
| Raw App token treated as PR-scoped capability           |      9 |          4 |     9 | Server-side posting proxy or operation-level control-plane enforcement    |
| Same head SHA with new base is incorrectly suppressed   |      8 |          6 |     9 | Idempotency and fingerprints include `base_ref` + `base_sha`              |
| Nonce/OIDC stolen before validation step                |      9 |          3 |     9 | First privileged step is trusted OIDC exchange, nonce is not sole auth    |
| Non-conflict PR incorrectly gets conflict fallback      |      7 |          5 |     8 | Positive conflict signal only, inconclusive otherwise                     |
| User-spoofed marker causes bot to edit wrong comment    |      7 |          4 |     8 | Verify author/app identity and stored comment ids                         |
| Branch/ref text breaks hidden marker parsing            |      6 |          5 |     7 | Encode marker metadata canonically, never raw branch names                |
| Public dispatch/marker id cancels legitimate run        |      7 |          4 |     8 | Do not use payload or public ids for `cancel-in-progress` concurrency     |
| Conflict review changes GitHub review decision          |      8 |          3 |     8 | Use advisory comments/status, never approval in conflict mode             |
| PR retarget to same-SHA base suppresses needed review   |      7 |          4 |     8 | Include `base_ref` in idempotency, markers, and validation                |
| Conflict status collides with merge queue checks        |      8 |          3 |     8 | Separate contexts/job names, never post conflict status to merge groups   |
| Status and check share same required check name         |      7 |          4 |     8 | Choose one object type per context, no dual emission with same name       |
| Old head-SHA status appears current after retarget      |      8 |          4 |     8 | Treat status/check as advisory, source of truth is attempt record         |
| Two PRs share a head SHA but different base semantics   |      7 |          3 |     7 | Summary/attempts are PR-scoped, status/check copy is explicitly advisory  |
| Conflict resolved by base push but normal review absent |      9 |          5 |     9 | `normal_review_recheck_needed`, safe rerun path or explicit remediation   |
| Provider cost abuse through repeated conflicts          |      6 |          6 |     7 | Rate limit, budget guard, per-repo feature flag                           |
| Inline comments fail due stale positions                |      5 |          6 |     6 | Summary-only degradation                                                  |

Scoring:

```text
Impact: 1-10
Likelihood: 1-10
Score: practical priority, 1-10
```

## Main Safety Invariants

### Invariant 1: No False Green

Conflict review must not satisfy the normal required review gate.

Risk:

```text
🔥 Severity: 10/10
```

Bad behavior:

```text
Conflict fallback reviews head changes.
It reports success under the normal "ReviewRouter" context.
Branch protection sees green.
The final conflict resolution was never reviewed.
```

Required controls:

- Use a separate context: `ReviewRouter conflict review`.
- Label the summary as conflict/head review.
- Never post a normal success status from this mode.
- Do not automatically add `ReviewRouter conflict review` to required branch
  protection checks.
- If the user manually requires this context, document that it is only a
  conflict-time advisory gate and still does not replace the normal review.
- After conflicts are resolved, require the normal `pull_request` run.

### Invariant 2: Do Not Execute PR Code

The fallback may read PR files and diffs. It must not execute PR-controlled code.

Risk:

```text
🔥 Severity: 10/10
```

Forbidden in conflict fallback:

- `npm install`
- `pnpm install`
- `yarn install`
- `npm test`
- `pnpm test`
- package scripts
- repository-local GitHub Actions from the PR branch
- build scripts
- hooks
- generated scripts from PR content
- binaries from the PR workspace

Allowed:

- checkout exact `head_sha` with `persist-credentials: false`
- read files
- compute diff
- run trusted ReviewRouter runtime from trusted ref
- run trusted Codex CLI installed from npm in the workflow
- run trusted provider CLIs installed by the trusted workflow
- run read-only shell commands for inspection

The runtime checkout must be:

```text
777genius/review-router at trusted runtime_ref
```

not code from the target PR branch.

Provider CLIs must not receive GitHub tokens. Model subprocesses should receive
only the minimum provider credential required for that provider, and only after
the runtime has validated the conflict fallback record.

### Invariant 3: Do Not Trust Dispatch Payload

`client_payload` is a routing hint, not authority.

Risk:

```text
🔥 Severity: 10/10
```

The runtime must fetch current PR state through GitHub API and validate:

- repository id
- repository full name
- PR number
- PR state is open
- PR is not draft unless explicitly allowed
- current `head.sha`
- expected `head.sha`
- current `base.sha`
- expected `base.sha` if provided
- head repository full name
- fork policy
- mergeable state still indicates conflict or the mode is stale-safe

If validation fails, exit without comments.

### Invariant 4: Stale Runs Must Not Comment

Webhook and dispatch events can race with user pushes.

Risk:

```text
⚠️ Severity: 9/10
```

Required controls:

- Runtime validates current PR `head.sha` at startup.
- Runtime validates current PR `base.ref` and `base.sha` at startup when an
  expected base ref/SHA was dispatched.
- Runtime validates current PR `head.sha` again before posting comments.
- Runtime validates current PR `base.ref` and `base.sha` again before posting
  comments when an expected base ref/SHA was dispatched.
- If the head SHA changed, exit stale with a neutral internal conclusion and do
  not post a new commit status/check. Commit statuses do not have a neutral
  state.
- Do not update summary.
- Do not post inline comments.

### Invariant 5: Duplicate Events Must Not Duplicate Reviews

GitHub can send repeated webhooks. SaaS retries can happen. Users can edit PRs.

Risk:

```text
⚠️ Severity: 9/10
```

Required controls:

- SaaS DB unique key:

```text
repositoryId + prNumber + headSha + baseRef + baseSha + fallbackVersion
```

- Workflow concurrency:

```yaml
concurrency:
  group: reviewrouter-conflict-${{ github.repository }}-${{ github.workflow }}-${{ github.run_id }}
  cancel-in-progress: false
```

- Runtime comment marker:

```html
<!-- reviewrouter:conflict-review v=1 data=<base64url-json-metadata> -->
```

The marker is not authority. It is only a selector. When updating an existing
summary, also require:

- comment id matches the stored fallback attempt or latest known ReviewRouter
  conflict summary for the same repo/pr/head/base
- comment author is the expected GitHub App or bot identity
- comment body marker metadata matches the current repo id, PR number, head SHA,
  base ref, base SHA, and fallback version
- comment body marker metadata matches the review config snapshot id/hash and
  output schema version used by the attempt
- comment was not authored by a user, even if it contains a copied marker
- marker metadata is encoded canonically, for example base64url JSON or strict
  URL encoding. Do not put raw branch names, titles, labels, or other
  user-controlled text into an HTML comment marker.
- public marker metadata never contains the dispatch nonce and is never used as
  a workflow cancellation key or authorization secret.

- Inline finding fingerprint:

```text
repoId/prNumber/headSha/baseRef/baseSha/configSnapshotId/outputSchemaVersion/file/line/bodyHash/providerRoutingHash
```

Do not rely on workflow concurrency for correctness. GitHub applies concurrency
before runtime validation, so using raw `client_payload.pr_number`,
`client_payload.dispatch_id`, branch names, or marker attempt ids can let a
manual dispatch from a write-capable actor cancel a legitimate run before
ReviewRouter validates OIDC and nonce. Correctness must come from DB
idempotency, summary markers, finding fingerprints, and stale guards.

If product UX requires cancelling older runs for a newer head/base ref/SHA pair,
implement it through a trusted SaaS-side record and Actions API only after the
run has authenticated through OIDC. Otherwise, let older runs exit stale.

### Invariant 6: Fork PRs Stay Skipped in v1

Fork PRs are a separate threat model.

Risk:

```text
⚠️ Severity: 8/10
```

First release policy:

```text
same-repo PR only
fork PR -> skip with explicit safe reason
```

Fork-safe conflict review can be added later as a separate diff-only mode with
no secret-backed providers and tighter API permissions.

### Invariant 7: OIDC Must Stay Narrow

The control plane should accept OIDC claims only from allowed workflows and
events.

Risk:

```text
⚠️ Severity: 8/10
```

Required changes:

- Add `repository_dispatch` to allowed action events.
- Keep allowed workflow paths narrow:

```text
.github/workflows/reviewrouter.yml
.github/workflows/reviewrouter-interaction.yml
```

- Do not allow arbitrary workflow refs.
- Validate `workflow_ref` and `job_workflow_ref` as today.
- Validate OIDC `iss` and require a ReviewRouter-specific `aud` value. Do not
  accept GitHub's default owner URL audience for conflict runtime config.
- Validate immutable identity claims where available: `repository_id`,
  `repository_owner_id`, `workflow_ref`, `workflow_sha`, `job_workflow_ref`,
  `job_workflow_sha`, `event_name`, `run_id`, `run_attempt`, and
  `runner_environment`.
- Prefer `job_workflow_sha` or a known template hash over path-only trust. A
  trusted path at a mutable branch ref is not enough by itself.
- Record a hash of the OIDC `jti` for successful privileged exchanges if the
  implementation can do it cheaply, and reject exact replay within token TTL.
- For conflict-head config exchange, allow only the review workflow path:

```text
.github/workflows/reviewrouter.yml
```

- Do not allow conflict-head execution from
  `.github/workflows/reviewrouter-interaction.yml`.
- Add tests proving unrelated workflow refs are rejected.
- Add `repository_dispatch` through a conflict-specific validation path. Do not
  make it a generic allowed event for normal runtime config exchange.

Bad change:

```text
allowedActionEvents.push("repository_dispatch")
generic session exchange accepts it
runtime mode defaults to normal
random/manual dispatch can fetch normal provider config
```

Required shape:

```text
event_name == repository_dispatch
  -> require review_kind == conflict-head
  -> require dispatch_event_type == reviewrouter_conflict_review
  -> require dispatch_id + nonce
  -> require fallback attempt record
  -> only then return runtime config

event_name != repository_dispatch
  -> use existing normal/interaction validation
```

If the code keeps one shared OIDC schema enum, the context-specific use case must
still reject `repository_dispatch` before config is returned unless all
conflict-head requirements pass.

### Invariant 8: Existing Repositories Need Capability Detection

Old installed workflows do not have the `repository_dispatch` trigger.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Probe installed workflow content and stored setup version.
- Require a known-good compact reusable caller shape for v1 conflict fallback.
- Treat explicit generated workflows as unsupported for conflict fallback in v1
  unless they first get a separate pre-secret validation job.
- Require `job_workflow_ref` to match trusted ReviewRouter reusable workflow
  refs during conflict-head config exchange.
- Detect known org/repo Actions policy incompatibility where GitHub exposes it,
  and otherwise rely on no-run-observed reconciliation.
- If fallback is unsupported, do not dispatch.
- Surface a health state:

```text
conflict_fallback_workflow_update_required
```

- Generate a setup/update PR that adds the trigger.

Do not treat "workflow file exists and mentions repository_dispatch" as enough.
The workflow must match a ReviewRouter-managed capability version or a validated
template hash. Otherwise, mark:

```text
conflict_fallback_workflow_shape_untrusted
```

### Invariant 9: Inline Comments May Fail on Conflict Diffs

GitHub inline review comments can fail when line positions are invalid or stale.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Treat inline comment failures as partial failures.
- Fall back to summary-only findings.
- Record safe health metadata.
- Do not fail the whole review only because one inline position is invalid.

### Invariant 10: Model Context Must Not Follow Repository Instructions Blindly

The PR can contain adversarial instructions in code or docs.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Keep Codex sandbox read-only.
- Keep `--ignore-user-config` and `--ignore-rules`.
- Do not pass GitHub tokens or provider secrets to the model process.
- Use prompt instructions that repository content is untrusted input.
- Keep output schema strict.
- Validate findings target changed lines.
- Runtime, not the model, computes status/check state, status/check context,
  target URL, summary marker, comment id selection, retry behavior, and terminal
  attempt state.
- Treat model output as data that must pass a versioned schema with an allowlist
  of fields such as file path, line range, severity, confidence, and review
  message.
- Reject unknown control-like fields from model output, including `status`,
  `context`, `target_url`, `comment_id`, `marker`, `dispatch_id`, `nonce`,
  `token`, `retry`, `approve`, and `request_changes`.
- Validate and normalize file paths so findings cannot target paths outside the
  PR file list, hidden marker metadata, workflow files used as control plane, or
  synthetic paths.
- Bound model output sizes per finding and per summary. If output is too large,
  truncate review text with a clear partial-review note or fail safely as
  `provider_runtime_failed`, but do not post an oversized GitHub comment.
- Sanitize model/PR-controlled markdown before posting:
  - escape or remove ReviewRouter marker namespace strings such as
    `<!-- reviewrouter:`
  - disarm user/team mentions where they are not required, for example `@` to
    `@\u200b`
  - avoid raw HTML blocks from model output
  - keep the runtime-owned marker as a single deterministic footer outside model
    text
- The summary marker parser should accept only the deterministic runtime footer.
  If a bot-authored summary contains extra ReviewRouter marker namespace strings
  outside the footer, treat the marker as invalid and create a new safe summary
  rather than updating the ambiguous comment.

### Invariant 11: Provider-Backed Runs Require a SaaS Dispatch Record

A `repository_dispatch` event can be created by any token that has enough
repository permission. The workflow cannot treat the event as proof that SaaS
approved the review.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- SaaS creates a fallback attempt record before dispatch.
- SaaS stores only a hash of the dispatch nonce.
- The runtime sends `dispatch_id`, nonce, repo id, PR number, head SHA, base ref,
  base SHA, and OIDC claims to the config exchange endpoint.
- Treat OIDC `actor` and repository dispatch `sender` as audit metadata only.
  Do not use actor identity as the authorization proof for provider-backed
  config.
- SaaS verifies the record exists, is unexpired, belongs to the same repository,
  and matches the PR/head/base ref/base SHA.
- SaaS validates the OIDC audience, issuer, repository id, workflow identity,
  reusable workflow identity, run id, run attempt, event name, runner
  environment, and current base ref/SHA before returning runtime config.
- SaaS marks the record `started` with `run_id` and `run_attempt`.
- No provider-backed runtime config is returned without a valid record.

Nonce consumption should be run-bound, not just a blind single-use flag:

```text
first valid exchange:
  bind dispatch_id + nonce_hash to github_run_id, run_attempt, base_ref, and base_sha

same run retry:
  allow idempotent exchange only for the same github_run_id while the attempt is nonterminal

GitHub "rerun jobs":
  allow only if github_run_id matches and run_attempt increases within TTL

different run_id:
  reject as nonce_reused_or_spoofed
```

If that rerun policy is too complex for v1, disable GitHub UI reruns for this
mode operationally and require a fresh SaaS-triggered conflict fallback attempt.

For static config mode, where SaaS cannot enforce a nonce in config exchange,
the default should be stricter:

```text
repository_dispatch conflict fallback disabled unless explicitly allowed
```

If static mode enables it, it must still require same-repo PR, current head SHA,
and trusted workflow execution.

### Invariant 12: PR Status Attachment Needs an Explicit Token Contract

`repository_dispatch` runs are attached to the default branch workflow context,
not naturally to the PR like `pull_request` runs. The PR-visible result must be
posted to the PR head SHA deliberately.

Risk:

```text
⚠️ Severity: 8/10
```

Choose one PR-visible object before implementation:

```text
Option A: Commit status
  Context: ReviewRouter conflict review

Option B: Check run
  Name: ReviewRouter conflict review
```

Choose one token mechanism separately:

```text
Option 1: ReviewRouter OIDC posting capability
  🎯 9   🛡️ 10   🧠 7
  Estimated change: 120-220 lines
  Runtime receives a short-lived ReviewRouter posting capability only after
  OIDC, nonce, workflow ref, repository id, PR state, and head SHA validation.

Option 2: workflow GITHUB_TOKEN with job-level write permissions
  🎯 8   🛡️ 8   🧠 5
  Estimated change: 60-120 lines
  Acceptable only if external actions are pinned/trusted and model/provider
  execution cannot access the token through environment or inputs.

Option 3: top-level workflow write permissions
  🎯 5   🛡️ 4   🧠 3
  Estimated change: 20-40 lines
  Not recommended. It makes write scopes available to every job/action and is
  too easy to misuse later.
```

Recommended v1:

```text
Use advisory commit status first.
Use check runs later only if ReviewRouter needs richer output or annotations.
Use ReviewRouter OIDC posting capability first if the existing App profile
already has the needed pull request, issue, and status/check permissions.
Do not make the conflict status/check required, because the GitHub object is
head-SHA visible and not ReviewRouter PR/base scoped.
```

Important token boundary:

```text
GitHub App installation tokens can be narrowed by repository and permission set,
but they are not natively scoped to one PR, one head SHA, one base ref/SHA, one
status/check context, or one comment id.

Therefore "OIDC-scoped posting token" means a ReviewRouter-issued posting capability, not a GitHub-native PR-scoped token. The safest implementation is a server-side posting proxy or a one-shot signed posting session that enforces every allowed operation before it touches GitHub.

Returning a raw GitHub App installation token to the runner is a fallback, not
the target design. If it is used, keep it isolated to a final posting step, do
not expose it to model/provider execution, and still make the control plane
validate the exact operation scope before minting it.
```

Reason:

```text
ReviewRouter already posts review content through PR comments.
A single commit status is enough to attach conflict review state to the PR head SHA.
Checks add another object lifecycle and webhook surface area.
```

Current normal ReviewRouter OIDC runtime/comment tokens are repository-scoped
and include `contents: read`, `pull_requests: write`, and `issues: write`.
`contents: read` is required because the stable action runtime uses the same
token to fetch private PR raw diffs before posting with the App identity.
For conflict fallback, extend that contract deliberately to include the single
allowed status/check context. If that is not available in v1, workflow
`GITHUB_TOKEN` posting is an acceptable fallback only with job-level write
permissions and pinned/trusted actions.

Failure behavior:

- If summary comments succeed but status/check posting fails, report a degraded
  conflict review.
- Do not silently omit the PR-visible status/check.
- Do not fall back to the normal `ReviewRouter` context.
- The status/check target URL should point to the GitHub Actions run or safe PR
  summary, never to a SaaS URL containing bearer tokens or secret-bearing query
  parameters.
- Status posting should use one stable context per mode. Do not include model,
  provider, run id, or attempt number in the status context.

### Invariant 13: Workflow Expressions and Shell Must Treat Payload as Untrusted

Branch names, PR titles, labels, and dispatch payload values can contain
characters that are dangerous in shell or YAML contexts.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Do not echo raw payload values into shell scripts.
- Pass raw values through environment variables or JSON files.
- Validate SHAs with `^[a-fA-F0-9]{40}$`.
- Validate PR numbers as positive integers.
- Validate dispatch ids as UUIDs.
- Validate event type exactly equals `reviewrouter_conflict_review`.
- Keep `client_payload` top-level keys at or below GitHub's documented limit.
- Use a Node/runtime preflight for validation instead of complex shell logic.

### Invariant 14: Diff Source Must Match GitHub PR Semantics

A naive local `base_sha...head_sha` diff can become noisy or subtly wrong,
especially for branches that are far behind the base branch.

Risk:

```text
⚠️ Severity: 8/10
```

Preferred diff source order:

```text
1. GitHub PR files endpoint and PR diff data.
2. GitHub PR diff URL/media type for the pull request.
3. Local git diff only as fallback, using the PR merge base, not just current base SHA.
```

Required controls:

- Use GitHub's PR changed-file list for changed file boundaries.
- Fetch all PR files pages up to GitHub's documented API limit.
- Detect and report when GitHub truncates file lists or omits patch data.
- Use PR changed-line coordinates where available for inline comments. For new
  GitHub review comments, prefer `line`/`side` and optional
  `start_line`/`start_side`; do not build new code around `position`.
- Validate every finding against changed lines before posting inline.
- If changed-line mapping cannot be trusted, degrade to summary-only.
- If file coverage is incomplete, mark the conflict review as partial in the
  summary and status/check description.
- Keep existing diff compaction and batching limits.

### Invariant 15: Dispatch Run Observation Must Be Runtime-Led

After `repository_dispatch`, finding the created run by polling Actions can be
racy because the run is on the default branch and run creation is asynchronous.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Runtime calls SaaS during config exchange with `dispatch_id`.
- SaaS records `run_id`, `run_attempt`, event name, and workflow ref from OIDC
  claims.
- A background reconciler can mark records `no_run_observed` only after a TTL.
- Do not rely on immediate Actions API polling as the only source of run state.

### Invariant 16: Runner State Must Be Ephemeral or Cleaned

The generated workflow currently targets GitHub-hosted runners. That is the
right default for conflict fallback. A self-hosted runner can retain workspaces,
caches, tools, and files between jobs, which expands the risk of reading or
executing attacker-controlled state.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Keep generated conflict fallback on `ubuntu-latest` for v1.
- If self-hosted runners are later supported, require an explicit repository
  setting and documented runner hygiene.
- Clean workspace before checkout.
- Disable dependency caches for conflict fallback unless cache keys are trusted
  and do not include PR-controlled content.
- Do not restore build artifacts from previous PR runs.

### Invariant 17: Provider Cost and Abuse Must Be Bounded

A malicious same-repo actor or compromised maintainer token could repeatedly
push conflict-inducing commits and force expensive provider runs.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Rate-limit fallback dispatch per repository, PR, and actor.
- Respect existing provider budget guards.
- Add a lower default provider limit for conflict fallback if needed.
- Stop retrying after repeated provider auth/runtime failures for the same
  head/base ref/SHA pair.
- Emit metadata-only abuse/rate-limit health states.

### Invariant 18: Mode Naming Must Not Collide With Interaction Mode

The runtime already uses mode-like values for review and interaction flows.
Conflict review should not accidentally route through `/rr` interaction logic.

Risk:

```text
⚠️ Severity: 6/10
```

Recommended shape:

```text
REVIEW_ROUTER_MODE=review
REVIEW_ROUTER_REVIEW_KIND=conflict-head
```

or an equivalent dedicated input. Avoid overloading
`REVIEW_ROUTER_MODE=conflict-head` if the runtime switch already expects only
`review`, `interaction-preflight`, and `interaction`.

### Invariant 19: GitHub Webhook Feedback Must Not Trigger More Work

ReviewRouter's GitHub App already receives status, check, workflow, and comment
webhooks for health, setup visibility, and interaction features. Creating a
conflict status/check/summary can therefore create additional inbound webhooks.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Treat `ReviewRouter conflict review` status/check events as terminal
  metadata, not as triggers for another review.
- Do not enqueue conflict detection from `status`, `check_run`, `workflow_run`,
  `issue_comment`, or `pull_request_review_comment` webhooks created by
  ReviewRouter conflict fallback.
- Do not route self-authored conflict summaries through `/rr` slash-command or
  interaction processing.
- Store conflict fallback health separately from normal ReviewRouter action
  health.
- Do not mark the normal review workflow as healthy/successful based only on a
  conflict fallback status.
- Use stable status context names to avoid creating many contexts on the same
  SHA.
- Remember GitHub's commit status limit per SHA/context; avoid status spam and
  prefer updating a check run if richer state churn is needed later.

### Invariant 20: Conflict Fallback Requires a Known-Good Caller

The OIDC allowlist currently trusts workflow identity by path and trusted reusable
workflow refs. For conflict fallback, path alone is too weak because the feature
uses a sensitive `repository_dispatch` entry point and provider-backed execution.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- v1 conflict fallback supports only the compact reusable caller.
- The customer workflow must call the trusted reusable workflow:

```text
777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1
```

or another explicitly trusted runtime ref.

- OIDC config exchange must validate `job_workflow_ref` for conflict-head mode.
- `job_workflow_ref` is not enough when the trusted ref is mutable, for example
  `@v1`. The config exchange must also validate `job_workflow_sha` against the
  ReviewRouter release/capability manifest captured by the workflow capability
  probe.
- If `job_workflow_sha` is missing, unknown, or no longer allowed for that
  capability version, reject config exchange with
  `job_workflow_sha_untrusted`.
- Capability probe should compare a stored setup version or normalized template
  hash, not just search for `repository_dispatch`.
- If the workflow has local steps before runtime execution, conflict fallback is
  unsupported until separately reviewed.
- Manual customer edits to the workflow should trigger
  `workflow_shape_untrusted` rather than silently enabling fallback.

Important architecture consequence:

```text
explicit workflow + repository_dispatch + existing secret setup order = unsupported in v1
```

The current explicit workflow installs provider tooling and restores provider
auth before the ReviewRouter action can perform conflict nonce validation. That
does not necessarily leak secrets, because the workflow file is default-branch
trusted, but it weakens the "validate before provider-backed execution" invariant
and increases cost/abuse risk. Keep v1 conflict fallback on the trusted reusable
caller, where the central runtime can enforce pre-provider validation in one
place.

### Invariant 21: Required Workflow Must Stay Separate

`reviewrouter-required.yml` exists to satisfy branch protection and merge queue
semantics. Conflict fallback is advisory and must not be wired into that
required workflow.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- Do not add `repository_dispatch` to `reviewrouter-required.yml`.
- Do not post `ReviewRouter Required` from conflict-head mode.
- Do not mark required-workflow health successful from a conflict fallback run.
- Add tests proving required workflow rendering is unchanged.

If the product later adds a required conflict-time gate, it must be a separate
opt-in branch protection context with copy that says it does not replace normal
merge-result review.

### Invariant 22: Dispatch Webhooks Must Not Re-enter Review Scheduling

The `repository_dispatch` API can trigger both a workflow and GitHub App
webhooks. Since ReviewRouter owns the GitHub App, the SaaS webhook pipeline can
see events caused by its own fallback.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Webhook normalization may record `repository_dispatch` as safe metadata.
- It must not enqueue conflict detection from `repository_dispatch`.
- It must not enqueue normal review from `repository_dispatch`.
- It must not mark repository setup healthy only because a dispatch webhook was
  observed.
- Add tests for self-generated dispatch events.

### Invariant 23: Retry Policy Must Be Terminal-State Aware

The unique key prevents duplicate dispatch for the same head/base ref/SHA pair,
but it can also hide legitimate retries if the first attempt fails before any
workflow run starts.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Retry `dispatch_failed` only when no runtime has started and no comments were
  posted.
- Retry `no_run_observed` only with a new dispatch nonce and a new dispatch id.
- Do not auto-retry provider failures for the same head/base ref/SHA pair unless
  the user asks or a safe transient category is explicitly allowlisted.
- Do not retry terminal `completed`, `stale`, `skipped`, or
  `resolved_before_review` attempts.
- Reuse the same summary marker and finding fingerprints across retry attempts.
- Keep a retry count and dead-letter state.

Suggested retry taxonomy:

```text
safe automatic retry:
  dispatch_failed before run start
  GitHub 5xx/rate-limit after backoff

manual or operator retry only:
  provider_auth_missing
  provider_runtime_failed
  status_post_failed after summary was posted

never retry automatically:
  stale_head
  stale_base
  fork_pr
  workflow_shape_untrusted
  nonce_invalid
```

### Invariant 24: Runtime Must Not Confuse Default-Branch SHA With PR Head SHA

For `repository_dispatch`, GitHub sets the workflow ref/SHA to the default branch
workflow context. That is not the PR head.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Never use `github.sha` as the reviewed commit in conflict-head mode.
- Require `expected_head_sha` from the SaaS dispatch record and validate it
  against a fresh PR fetch.
- Checkout exactly `expected_head_sha`.
- Post the commit status/check to `expected_head_sha`, not to the default branch
  SHA.
- Label logs and health reports with both `workflow_sha` and `review_head_sha`
  to prevent debugging confusion.

### Invariant 25: Manual Workflow Dispatch Is Not a Conflict Bypass

The generated review workflow already supports `workflow_dispatch` for manual
normal review runs. That manual path must not become a way to run conflict-head
review without the SaaS detector, dispatch record, and nonce.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- `workflow_dispatch` maps to `review_kind=normal` in v1.
- It may accept `pr_number` for normal reruns only.
- It must not accept `review_kind`, `expected_head_sha`, `dispatch_id`, or
  `dispatch_nonce` as user-editable inputs.
- The runtime rejects `review_kind=conflict-head` unless
  `event_name=repository_dispatch`.
- The runtime rejects `repository_dispatch` unless the dispatch event type is
  exactly `reviewrouter_conflict_review`.

If a manual conflict rerun is needed later, make it a SaaS action that creates a
fresh fallback attempt and repository dispatch, not a free-form GitHub UI input.

### Invariant 26: Dispatch Payload Schema Must Be Tiny and Versioned

GitHub limits `repository_dispatch.client_payload` and the payload is untrusted.
A growing payload is a bug magnet because it tempts future code to trust stale
metadata instead of fetching current PR state.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Keep top-level `client_payload` properties at or below 10.
- Keep the total payload below 65,535 characters.
- Include only routing metadata:
  `protocol_version`, `dispatch_id`, `nonce`, `repository_id`, `pr_number`,
  `head_sha`, `base_ref`, `base_sha`, `fallback_version`.
- Validate schema strictly in the reusable runtime before config exchange.
- Treat unknown payload fields as invalid in conflict mode.
- Add a payload-size and payload-key-count unit test.

### Invariant 27: Base-Branch Pushes Must Be Covered Deliberately

A PR can become conflicted when the base branch changes, even if the PR head
does not change. A detector that only listens to `pull_request` opened,
synchronize, reopened, and ready-for-review events will miss some conflict PRs.

Risk:

```text
⚠️ Severity: 9/10
```

Recommended v1:

```text
default/base branch push
  -> enqueue bounded open-PR reconciliation for that repository/base ref
  -> fetch open same-repo PRs targeting that base
  -> run the same conflict detector and idempotency path
```

Controls:

- Subscribe the GitHub App to `push` only if the product wants near-real-time
  base-push detection.
- If `push` is not added, document the gap and add a scheduled reconciliation
  job for selected repositories with open PRs.
- On `push`, process only selected repositories and only default/base refs that
  can affect selected PRs.
- Do not store commit messages or file lists from push payloads unless a future
  feature needs them.
- Rate-limit reconciliation per repository and base ref.
- For PRs that were previously conflict-reviewed and become mergeable because
  of the base push, do not mark conflict fallback successful. Record
  `normal_review_recheck_needed` unless a normal review for the current
  head/base identity is already observed.
- If a safe normal-review rerun path exists, enqueue that path through its own
  normal-review idempotency and permissions. Do not invoke it through
  conflict-head mode.
- Use the same unique key:

```text
repositoryId + prNumber + headSha + baseRef + baseSha + fallbackVersion
```

- If a base push both resolves and creates conflicts across PRs, each PR is
  evaluated independently from a fresh GitHub PR fetch.

Important:

```text
Adding the push event is not a new GitHub App repository permission, but it is a
GitHub App event-subscription/product-config change. Treat it as rollout-visible.
```

### Invariant 28: Commit Statuses Are Append-Only

GitHub commit statuses are not updated in place. The combined status uses the
latest status for a context, and GitHub enforces a per-SHA/context limit.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Use one stable context:

```text
ReviewRouter conflict review
```

- Prefer one terminal status per fallback attempt.
- Avoid posting `pending` unless product UX needs it.
- Do not post a new status for stale/no-op exits unless the PR UI would
  otherwise be misleading.
- Do not include attempt, provider, model, or run id in the status context.
- If ReviewRouter needs mutable lifecycle details, use a check run instead of
  many commit statuses.
- Add a guard that suppresses duplicate terminal status creation for the same
  `repositoryId + prNumber + headSha + baseRef + baseSha + fallbackVersion +
conclusion`.

### Invariant 29: Reusable Workflow Access Can Be Blocked by Org Policy

Some organizations restrict which actions and reusable workflows can run. Since
v1 conflict fallback is intentionally limited to the trusted reusable caller,
org policy can block execution before the runtime ever starts.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Treat this as unsupported until the workflow is updated or org policy allows
  the trusted reusable workflow ref.
- Capability checks should detect known setup style and trusted ref, but they
  may not detect every org policy block before the run.
- If dispatch succeeds and no runtime OIDC exchange appears before TTL, mark:

```text
reusable_workflow_policy_blocked_or_no_run_observed
```

- Dashboard remediation should tell the user to allow
  `777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1` or
  keep conflict fallback disabled.
- Do not fall back to explicit workflow automatically, because explicit workflow
  has a different secret-validation order.

### Invariant 30: Review Policy and Runtime Config Must Come From Trusted Sources

In conflict mode, the PR head is the review target. It must not control
ReviewRouter's provider policy, model selection, limits, trusted workflow refs,
prompt policy, or status/check behavior.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- Resolve provider policy from SaaS runtime config, trusted static workflow
  config, or default-branch configuration only.
- Do not load ReviewRouter control config from the checked-out PR head.
- Treat files such as `.reviewrouter*`, `.github/reviewrouter*`,
  `AGENTS.md`, `.cursorrules`, or provider-specific instruction files in the PR
  as untrusted repository content.
- If repository-level instructions are included for model context, wrap them as
  untrusted input and keep system/developer policy above them.
- Validate output against changed lines and configured policy after model
  execution.
- At runtime config exchange, return an immutable
  `review_config_snapshot_id` plus a nonsecret `review_config_hash` that covers:
  provider routing, model selection, prompt policy, severity/blocking policy,
  skip policy, output schema version, and posting policy.
- Store that snapshot id/hash on the fallback attempt when the run starts.
- Model execution, finding validation, summary rendering, status/check
  conclusion, and posting-token exchange must all use the same snapshot id/hash.
- If trusted config changes while the model is running, the current attempt
  continues with its original snapshot. A new config snapshot affects only a new
  attempt or an explicit operator/SaaS retry designed to create a new attempt.
- If posting-token exchange sees a different config snapshot than the one used
  for model execution, fail closed with `config_snapshot_mismatch` and do not
  post comments or status/check output.
- Include `review_config_hash`, `prompt_policy_version`, `output_schema_version`,
  and provider routing version in finding fingerprints and summary marker
  metadata. Do not include provider secrets or full prompt text.

Allowed:

```text
Read PR files to review code.
Read PR docs as review input.
Use trusted SaaS/default-branch/static config for ReviewRouter behavior.
```

Forbidden:

```text
PR head changes ReviewRouter provider credentials.
PR head changes provider limit or fail-on-severity policy.
PR head changes trusted reusable workflow ref.
PR head disables status/check posting.
PR head changes prompt instructions as trusted policy.
Runtime uses config snapshot A for model output but config snapshot B for
blocking/status decision.
```

### Invariant 31: Pre-Post Validation Must Re-check Full PR State

Startup validation is not enough. A PR can be closed, converted to draft, forked
through repository transfer edge cases, or have its base/head changed while the
model is running.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

Immediately before posting summary comments, inline comments, or statuses,
runtime must refetch and validate:

- PR state is still open
- PR is not draft
- PR is not merged
- PR is still same-repo
- head repository id still matches base repository id
- head SHA still equals `expected_head_sha`
- base ref still equals `expected_base_ref` when provided
- base SHA still equals `expected_base_sha` when provided
- repository id still matches the OIDC/session repository id
- fallback attempt is still nonterminal and not superseded

If any check fails:

```text
exit stale/no-op
do not post comments
do not create a terminal success/failure conflict status
record safe health metadata only
```

### Invariant 32: Repository Identity Must Survive Rename and Transfer Races

GitHub REST calls require owner/name, but owner/name can change. Runtime and
SaaS records must use immutable GitHub repository id as authority.

Risk:

```text
⚠️ Severity: 7/10
```

Required controls:

- Store `github_repository_id` on fallback attempts.
- Refresh repository full name before creating `repository_dispatch`.
- If dispatch returns `404`, refresh installation repositories once before
  deciding the repository is unavailable.
- Runtime validates OIDC `repository_id`, not just `repository`.
- Runtime validates fetched PR repository id against the fallback record.
- Treat repository transfer to an installation ReviewRouter no longer controls
  as `repository_not_selected` or `installation_not_active`.
- Do not create a new fallback attempt under the new name without matching the
  same GitHub repository id.

### Invariant 33: Checkout Must Stay Read-Only and Boring

Conflict review needs file content and diffs. It does not need submodules, LFS
objects, package caches, generated artifacts, or repository hooks.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Checkout exact `expected_head_sha`.
- Set `persist-credentials: false`.
- Set `submodules: false`.
- Set `lfs: false`.
- Keep `fetch-depth: 1` unless a local diff fallback explicitly needs more
  history.
- Clean the workspace before checkout.
- Do not restore package-manager caches in conflict mode.
- Do not run repository hooks.
- Do not run `git submodule update`, package installs, generators, tests, or
  build commands.

If local merge-base diff fallback needs history:

```text
fetch only the minimum base/head refs needed
do not fetch tags
do not fetch submodules
do not execute repository scripts
```

### Invariant 34: Sensitive Runtime Data Must Not Leak Through Logs or Artifacts

The SaaS privacy boundary says code, full diffs, prompts, provider output, model
output, provider secrets, GitHub tokens, and nonce values do not leave the
customer CI/runtime boundary as persisted operational data.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- Keep `GITHUB_TOKEN` and App/comment tokens inside the GitHub posting client
  layer only.
- Do not pass GitHub tokens or dispatch nonce to model/provider subprocesses.
- Run provider/model subprocesses with a curated environment allowlist.
- Mask dispatch nonce and any temporary GitHub/App tokens before diagnostic
  output.
- Do not upload artifacts containing code, full diffs, prompts, provider output,
  model output, tokens, or nonce values.
- Do not cache files from the PR workspace in conflict mode.
- Health reports may include counts, categories, timings, and safe run ids only.
- If debug logging is enabled, it must still redact nonce, tokens, prompts,
  diffs, provider output, and model output.

### Invariant 35: Workflow Action Surface Must Stay Minimal

GitHub documents that an action can access `github.token` even if the workflow
does not explicitly pass `GITHUB_TOKEN` as an input. That makes every `uses:`
step in the conflict workflow part of the trusted computing base.

Risk:

```text
🔥 Severity: 8/10
```

Required controls:

- The generated conflict-capable caller workflow should use the minimum number
  of external actions.
- Prefer full-length commit SHA pins for external actions in generated workflow
  output. If customer policy or maintainability keeps major tags, the workflow
  capability probe must record that policy choice and health should flag it.
- Validate that pinned action SHAs belong to the expected upstream repository,
  not a fork.
- Do not run local actions from the checked-out PR workspace in conflict mode.
- Do not run composite actions or reusable workflows selected by PR-head config.
- Keep the ReviewRouter reusable workflow reference on a trusted default-branch
  or release-controlled ref.
- If organization policy requires full SHA pins and the generated workflow does
  not satisfy it, report `workflow_action_policy_blocked` or
  `no_run_observed`. Do not fall back to explicit workflow execution.

Implementation note:

```text
The plan examples use actions/checkout@v6 for readability.
As of 2026-05-14, gh reported actions/checkout latest release v6.0.2.
Production generation should support SHA-pinned rendering for repositories that
require or choose immutable action references.
```

### Invariant 36: Write Token Blast Radius Must Be Narrow

GitHub documents that workflow permissions can be set at workflow or job level,
and that unspecified permissions become `none` when `permissions` is specified.
Use that deliberately. A conflict fallback workflow should not give every job
and every action write access just because the final posting step needs it.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- Prefer `permissions: {}` at workflow level and explicit `jobs.<job_id>.permissions`.
- The review/model job should not have `statuses: write`, `checks: write`,
  `pull-requests: write`, or `issues: write` if posting can use an
  ReviewRouter OIDC posting capability.
- The OIDC token exchange must return posting capability only after validating:
  repository id, workflow ref, event name, review kind, dispatch id, nonce, PR
  number, head SHA, base ref, base SHA, same-repo state, and nonterminal
  fallback attempt.
- The posting capability must be scoped to:
  - one repository id
  - one PR number
  - one head SHA
  - one base ref
  - one base SHA
  - one status/check context
  - comment/update APIs needed by ReviewRouter
  - short TTL
- This operation-level scope must be enforced by ReviewRouter. Do not assume a
  raw GitHub App installation token can express PR/head/context/comment-id
  limits, because GitHub exposes repository and permission scoping for that
  token class.
- Preferred implementation: the runner receives a ReviewRouter posting session
  token that can call only ReviewRouter's posting proxy. The proxy validates the
  stored attempt, OIDC-bound run identity, current PR state, exact head/base
  refs/SHAs, status/check context, and comment ownership before each GitHub
  write.
- Fallback implementation: the control plane mints a GitHub App installation
  token with the minimum repository and permission set, returns it only to the
  final posting step, and records `raw_app_token_scope_degraded` because
  operation enforcement after minting is weaker than proxy mode.
- Mint posting capability as late as possible, immediately before posting and
  after the full pre-post PR validation, not before checkout or model execution.
- If workflow `GITHUB_TOKEN` posting is used, write scopes must be job-level,
  not workflow-level, and tests must prove the generated conflict workflow does
  not use `write-all`, `read-all`, or top-level write permissions.
- Do not pass the posting token to provider/model subprocesses, package
  managers, git commands, checkout, local actions, composite actions, or
  artifacts.
- A missing posting capability is degraded health, not a reason to use the
  normal ReviewRouter context or skip PR-visible output silently.

Implementation note:

```text
This does not necessarily require a new GitHub App permission.
If the installed standard App profile already has pull request, issue, and
status/check write permissions, the change is a token-contract change, not an
app-permission expansion.
The permission question and the operation-scope question are separate: GitHub
can issue a repository/permission-limited installation token, but ReviewRouter
must still enforce the one PR, one head SHA, one base ref/SHA, one context, and
one comment-id limits in its own posting capability contract.
```

### Invariant 37: OIDC Exchange Must Happen Before Runner Exposure

`client_payload.nonce` is stored in the workflow event payload. After the job
starts, it is runner-readable. A job with `id-token: write` can also request an
OIDC token. The design must therefore treat nonce + OIDC as a tightly scoped
exchange protocol, not as two secrets that are safe anywhere inside the job.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- The first privileged runtime operation is the trusted ReviewRouter
  OIDC/config preflight.
- Do not run `actions/checkout`, package managers, provider/model subprocesses,
  local actions, composite actions, generated scripts, or nonessential external
  actions before the preflight succeeds.
- The preflight uses a ReviewRouter-specific OIDC audience, for example
  `reviewrouter-runtime-config`. Reject default or unexpected audiences.
- The control plane validates OIDC `iss`, `aud`, `repository_id`,
  `repository_owner_id`, `event_name`, `workflow_ref`, `workflow_sha`,
  `job_workflow_ref`, `job_workflow_sha`, `run_id`, `run_attempt`,
  `runner_environment`, and the fallback attempt record.
- The nonce is consumed or bound on the first valid exchange. Later exchanges
  must require the same run identity and a stage-specific purpose.
- Config exchange and posting-token exchange should be separate purposes:
  `runtime_config` and `posting_token`.
- Posting token should be minted at posting time after pre-post PR validation,
  not at startup before checkout/model execution.
- Provider/model subprocess environment allowlist must exclude
  `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`,
  `GITHUB_TOKEN`, App tokens, posting tokens, dispatch nonce, prompts, and full
  diffs.
- If any required OIDC claim is missing or unsupported, conflict fallback is
  skipped/degraded for that repository until the workflow shape is upgraded.

Good order:

```text
repository_dispatch starts trusted workflow
-> mask dispatch nonce
-> trusted ReviewRouter runtime requests OIDC token with expected audience
-> control plane validates OIDC + nonce + fallback record + head/base
-> runtime receives non-posting config/session
-> checkout/diff/model run without posting token
-> pre-post PR validation
-> runtime requests posting token with posting purpose
-> control plane validates state again and returns narrow posting capability
-> comments/status/check are posted
```

Bad order:

```text
repository_dispatch starts workflow
-> checkout PR head
-> restore caches or run package scripts
-> run model/provider subprocess with inherited env
-> request config/posting token afterward
```

### Invariant 38: Conflict Signal Must Be Positive and Specific

The fallback exists because GitHub will not run `pull_request` workflows when
the PR has merge conflicts. It should not run for every PR that is blocked,
behind, unstable, waiting on checks, or temporarily unknown.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Prefer GraphQL `mergeable=CONFLICTING` or `mergeStateStatus=DIRTY` as the
  positive conflict signal.
- REST `mergeable=false` alone is not enough unless paired with a
  conflict-equivalent state from the same fresh PR fetch.
- Treat REST `mergeable=null`, GraphQL `UNKNOWN`, API timeout, and stale cached
  values as inconclusive, not conflicting.
- Do not dispatch for `BLOCKED`, `BEHIND`, `UNSTABLE`, `DRAFT`, or missing
  mergeability state.
- Record the exact signal source in the fallback attempt:
  `graphql_mergeable`, `graphql_merge_state_status`, `rest_mergeable`, and
  `rest_mergeable_state` when available.
- If GitHub changes or omits a mergeability state, fail closed and mark
  `conflict_signal_inconclusive`.
- Runtime must re-check the conflict signal before review. If the state is no
  longer positively conflicting, exit `resolved_before_review` or stale.

Decision rule:

```text
CONFLICTING or DIRTY from fresh API data -> may dispatch
UNKNOWN/null/timeout -> retry then inconclusive
BLOCKED/BEHIND/UNSTABLE/DRAFT/CLEAN -> do not dispatch
REST mergeable=false without conflict-equivalent detail -> inconclusive
```

### Invariant 39: Conflict Review Must Not Become a GitHub Approval

Conflict review is advisory. It reviews the PR head against the base, not the
final resolved merge result. It must not alter GitHub's human review decision in
ways that look like an approval of the merge result.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Do not submit `APPROVE` from conflict mode.
- Do not submit `REQUEST_CHANGES` from conflict mode unless the product
  explicitly designs a separate opt-in branch-protection contract for it.
- Prefer issue comments plus inline review comments with a neutral/comment-only
  review event.
- Use the separate `ReviewRouter conflict review` status/check for blocking or
  passing conflict-mode findings.
- Summary copy must say the final resolved merge result still needs normal
  review.
- Tests must assert conflict mode cannot affect normal review approval state.

### Invariant 40: Merge Queue and Required Checks Must Stay Separate

The normal ReviewRouter workflow includes `merge_group` because merge queues
need checks on the temporary merge group branch/SHA. Conflict fallback is
different: it reviews the PR head while the merge result cannot be created.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- `merge_group` always stays normal-review mode, never conflict-head mode.
- Conflict fallback posts only to `expected_head_sha`, never to
  `github.sha`, merge group SHA, or `gh-readonly-queue/*` refs.
- Conflict status/check context must be distinct from any required normal
  ReviewRouter or merge queue job name.
- Do not emit both a commit status and a check run with the same
  `ReviewRouter conflict review` name. GitHub can require both if a check and a
  status share a required check name.
- If migrating from commit status to check run later, use an explicit migration
  plan: feature flag, separate name or no overlap window, and branch protection
  guidance.
- Do not mark required-workflow or merge-queue health successful from conflict
  fallback.
- Tests must assert conflict fallback does not affect merge queue required
  checks and does not post to merge group SHAs.

### Invariant 41: Base Retargeting Is a New Review Identity

ReviewRouter policy, required checks, and review copy can depend on the target
branch. A PR can be retargeted to a different base branch that currently points
to the same commit SHA. `base_sha` alone is therefore not a complete review
identity.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- Include `base_ref` in fallback unique keys, nonce scope, comment markers,
  inline fingerprints, status duplicate suppression, and posting-token scope.
- Validate current PR `base.ref` at startup and immediately before posting.
- Treat base ref changes as stale, even if `base_sha` is unchanged.
- Base ref must be validated as data and compared exactly with GitHub API
  `pull_request.base.ref`; never interpolate it into shell commands,
  concurrency groups, cache keys, artifact names, or refspecs.
- If a fetch/checkout needs the base side, use `base_sha` or a structured
  GitHub API request, not a string-built `refs/heads/${base_ref}` expression.
- Reject base refs containing control characters, NUL, CR/LF, leading `refs/`,
  `..`, `@{`, path traversal-like segments, or names above the accepted length
  limit chosen for ReviewRouter's schema. Also reject `gh-readonly-queue/*` as
  a conflict fallback target.
- If base ref changes while the same head/base SHA pair remains, create a new
  head/base ref/SHA attempt after conflict detection confirms the conflict.
- Tests must include same `head_sha` + same `base_sha` + different `base_ref`.

### Invariant 42: PR-Visible Status Is Advisory and SHA-Scoped

GitHub commit statuses are created for a commit SHA and context. They are useful
for PR visibility, but they cannot encode ReviewRouter's full conflict fallback
identity: repository id, PR number, head SHA, base ref, base SHA, and fallback
version.

Risk:

```text
⚠️ Severity: 8/10
```

Required controls:

- The durable fallback attempt record is the source of truth for current
  PR/base identity, not the latest status/check visible on the head SHA.
- The `ReviewRouter conflict review` context is advisory and must not be
  automatically added to branch protection or required rulesets.
- Dashboard health should warn if ReviewRouter can detect that the conflict
  context is required. If branch-protection/ruleset reads are unavailable, show
  setup copy that says not to require it.
- Status/check description must include conflict-only wording and should point
  to the PR-specific summary, not generic "review passed" copy.
- On base retarget or base SHA changes with the same head SHA, create a new
  fallback attempt and post a new status/check only after the new attempt passes
  validation. Until then, UI status may be stale and must not drive product
  decisions.
- If multiple open PRs share the same head SHA, PR-specific comments and
  attempt records stay authoritative. The status/check is only a head-SHA
  visibility hint.
- If the product later needs a required conflict-time gate, build a separate
  always-on required workflow that evaluates the current PR state, not an
  append-only conflict fallback status.

### Invariant 43: Posting Writes Must Be Checkpointed and Crash-Safe

GitHub writes are external side effects. Summary comments, inline review
comments, pull request review submissions, and commit statuses cannot be rolled
back with the ReviewRouter attempt record. The runtime must therefore treat
posting as a small state machine with explicit checkpoints.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- Compute a posting manifest before the first GitHub write. It should contain
  only safe metadata and hashes: attempt id, repository id, PR number, head SHA,
  base ref/SHA, config snapshot hash, summary body hash, planned status/check
  conclusion, inline finding fingerprints, and chosen GitHub write mode.
- Persist safe posting checkpoints on the attempt or runtime callback:
  `posting_started`, `summary_comment_id`, `summary_body_hash`,
  `inline_fingerprints_posted`, `inline_failures_count`,
  `review_id_if_any`, `status_context`, `status_state`, `status_sha`, and
  `posting_completed`.
- Do not store source code, full diffs, prompts, full model output, or full
  comment bodies in SaaS. Store hashes and GitHub ids only.
- Preferred v1 write order:
  1. pre-post validation
  2. create or update summary comment with runtime-owned marker
  3. post bounded inline comments where coordinates are trusted
  4. repeat pre-post validation
  5. post final advisory status/check
  6. mark posting completed
- If the run crashes after summary or inline comments but before status/check,
  retry resumes from checkpoints and does not create duplicate comments.
- If the run crashes after status/check, retry must observe the terminal
  checkpoint or duplicate-status suppression before writing again.
- Do not create pending GitHub pull request reviews in v1. If the review API is
  used, explicitly set `event=COMMENT`, set `commit_id=expected_head_sha`, and
  record the returned `review_id`.
- If a future implementation uses pending review drafts, it must include
  cleanup/recovery for unsubmitted drafts before enabling conflict fallback.
- Prefer issue summary comments plus individual review comments in v1 unless a
  single submitted `COMMENT` review is proven idempotent for the existing
  ReviewRouter posting layer.
- Cap inline comment count and body size. On secondary rate limit, invalid
  coordinates, or partial GitHub write failure, degrade remaining findings to
  summary-only and mark the attempt partial/degraded.
- Use modern PR review comment coordinates where possible: `line`, `side`,
  `start_line`, and `start_side`. Do not build new code around deprecated
  `position` coordinates.

### Invariant 44: Conflict Resolution Must Re-enter Normal Review Deliberately

GitHub `pull_request` workflows normally run when PR activity happens, including
when the head branch is updated. A base-branch push can also make a conflicted PR
mergeable without changing the PR head. In that case, conflict fallback is no
longer applicable, but the normal merged-result review may still be missing.

Risk:

```text
🔥 Severity: 9/10
```

Required controls:

- `resolved_before_review` is not success. It means conflict fallback exited
  because the PR is no longer positively conflicted.
- When a conflict fallback run exits `resolved_before_review`, record
  `normal_review_recheck_needed` unless a fresh normal ReviewRouter run for the
  same repository id, PR number, head SHA, base ref, and base SHA is already
  observed.
- Do not set the normal `ReviewRouter` context from conflict mode.
- Do not mark repo/review health green based only on conflict fallback resolving.
- If ReviewRouter already has a safe normal-review rerun mechanism, enqueue that
  mechanism from SaaS after fresh PR validation. It must review normal
  pull_request semantics, not conflict-head semantics.
- If no safe normal-review rerun mechanism exists in v1, surface remediation in
  PR summary/dashboard: conflict is gone, but normal review still needs a new
  PR event or explicit normal-review rerun.
- Normal-review recovery must use its own idempotency key and context. It must
  not reuse conflict fallback nonce, config exchange purpose, summary marker,
  status/check context, or posting checkpoints.
- Base-push reconciliation should classify each affected PR into:
  `still_conflicted`, `newly_conflicted`, `resolved_needs_normal_review`,
  `clean_already_normally_reviewed`, or `inconclusive`.
- Tests must cover base push resolving a conflict without a PR head update.

## Detailed Flow

### 1. Review-Relevant Event Arrives

Trigger actions:

- `opened`
- `synchronize`
- `reopened`
- `ready_for_review`

The webhook handler should enqueue conflict detection rather than immediately
dispatching. GitHub mergeability fields can lag behind PR creation/update.

Additional trigger for base-branch changes:

```text
push to default/base branch
  -> enqueue open-PR reconciliation for that base ref
```

If ReviewRouter does not subscribe to `push`, add a scheduled reconciliation
backstop and document that conflict fallback is not fully real-time for conflicts
introduced only by base branch updates.

### 2. Conflict Detector Fetches PR Fresh

Fetch the PR through GitHub API using the installation token.

Read:

- PR number
- state
- draft
- merged flag
- base ref
- base SHA
- head ref
- head SHA
- head repo full name
- GraphQL `mergeable`
- GraphQL `mergeStateStatus`
- REST `mergeable`
- REST `mergeable_state`, if available
- author type
- default branch workflow capability
- workflow style
- trigger source: pull_request, base_push, scheduled_reconciliation

If mergeability is `UNKNOWN`, `null`, missing, or API-inconclusive, retry with
backoff:

```text
attempt 1: after 5 seconds
attempt 2: after 20 seconds
attempt 3: after 60 seconds
```

If still unknown, record:

```text
conflict_detection_inconclusive
```

and do not dispatch.

Dispatch only on a positive conflict signal. Do not guess.

Recommended decision table:

| PR state                                               | Fallback action                      |
| ------------------------------------------------------ | ------------------------------------ |
| GraphQL `mergeable: CONFLICTING`                       | Dispatch if every other guard passes |
| GraphQL `mergeStateStatus: DIRTY`                      | Dispatch if every other guard passes |
| REST `mergeable: false` plus conflict-equivalent state | Dispatch if every other guard passes |
| `CLEAN`, `UNSTABLE`, `BLOCKED`, `BEHIND`               | Do not dispatch                      |
| `draft`, `closed`, `merged`                            | Do not dispatch                      |
| `UNKNOWN`, `null`, missing detail, API timeout         | Retry, then mark inconclusive        |

The detector should prefer immutable repository ids over repository names when
writing records.

### 3. Decide Whether Fallback Is Needed

Dispatch only when:

- repository is selected
- installation is active
- feature flag enabled
- workflow capability is present
- workflow capability version supports conflict fallback
- workflow shape is trusted for conflict fallback
- workflow style is allowed for conflict fallback
- PR is open
- PR is not draft
- PR is same-repo
- PR mergeability has a positive conflict signal
- no fallback record exists for this `head_sha`, `base_ref`, and `base_sha`
- repository has not exceeded conflict fallback rate limits
- provider-backed mode can be gated by a SaaS nonce
- repository Actions and target workflow are enabled

Do nothing when:

- PR is clean
- PR is behind but mergeable
- PR has checks blocked by branch protection but is mergeable
- PR is non-mergeable without a positive conflict signal
- PR is draft
- PR is closed
- PR is forked
- repository workflow is outdated
- repository workflow shape is untrusted
- repository workflow style is explicit and lacks pre-secret validation support
- repository is configured only through the required workflow
- the current installation token cannot create `repository_dispatch`
- a previous fallback for the same head/base ref/base SHA already completed
- repository Actions are disabled or the workflow is disabled

### 4. Create Fallback Record

Suggested table:

```text
review_conflict_fallback_attempts
```

Suggested columns:

```text
id
repository_id
github_repository_id
installation_id
pull_request_number
head_sha
base_ref
base_sha
head_repository_full_name
base_repository_full_name
event_type
fallback_version
status
dispatch_id
nonce_hash
nonce_expires_at
detected_graphql_mergeable
detected_graphql_merge_state_status
detected_rest_mergeable
detected_rest_mergeable_state
detected_conflict_signal_source
dispatch_run_id
dispatch_run_attempt
dispatch_workflow_ref
dispatch_job_workflow_ref
summary_comment_id
workflow_capability_version
workflow_template_hash
review_config_snapshot_id
review_config_hash
prompt_policy_version
output_schema_version
provider_routing_version
posting_manifest_hash
posting_phase
summary_body_hash
inline_fingerprints_posted
inline_failures_count
review_id
status_context
status_state
status_sha
github_actor
github_run_conclusion
created_at
updated_at
dispatched_at
started_at
completed_at
last_error_category
last_error_summary
retry_count
dead_lettered_at
```

Suggested unique index:

```text
unique(repository_id, pull_request_number, head_sha, base_ref, base_sha, fallback_version)
```

Suggested statuses:

```text
detected
dispatching
dispatched
started
completed
stale
skipped
failed
no_run_observed
cancelled
dead_letter
```

Nonce requirements:

```text
minimum entropy: 128 bits
storage: hash only
ttl: 15-30 minutes
scope: repository_id + pr_number + head_sha + base_ref + base_sha + dispatch_id
reuse: reject after first successful config exchange
rerun: allow only for same github_run_id according to rerun policy
```

Nonce handling rules:

- Treat the dispatch nonce as a temporary credential.
- Treat it as runner-visible after the workflow starts. It is not sufficient
  without valid OIDC claims, trusted workflow identity, run identity, and a
  matching fallback record.
- Add it to GitHub log masking before any step can print inputs or environment.
- Never include the raw nonce in logs, health reports, audit metadata, status
  descriptions, summary comments, or error messages.
- Store only a hash server-side.
- Keep TTL short because `client_payload` is not a GitHub Secret.

### 5. Dispatch Event

Use `repository_dispatch`:

```json
{
  "event_type": "reviewrouter_conflict_review",
  "client_payload": {
    "protocol_version": 1,
    "dispatch_id": "uuid",
    "nonce": "opaque one-time token",
    "repository_id": "123456",
    "pr_number": 107,
    "head_sha": "557764c9f3adb3b64c27174476b8cf48e8b468a0",
    "base_ref": "main",
    "base_sha": "3f3569e1ae69121c66a669ec6b660747b1a0b1bc",
    "fallback_version": 1
  }
}
```

Even with this payload, the workflow and runtime must re-fetch and validate PR
state.

GitHub constraints to keep in the implementation:

- `event_type` must stay short and exact: `reviewrouter_conflict_review`.
- `event_type` must stay below GitHub's 100-character limit.
- `client_payload` has a documented top-level property limit of 10, so keep it
  small.
- `client_payload` must stay below GitHub's 65,535-character payload limit.
- The workflow that receives the event must already exist on the default branch.
- Do not include code, diffs, prompts, provider output, or secrets in the
  payload.

### 6. Workflow Trigger

V1 generated reusable caller should include:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
  repository_dispatch:
    types: [reviewrouter_conflict_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Pull request number for manual reruns"
        required: false
        type: string
```

Generated caller permissions should be minimal at workflow level:

```yaml
permissions: {}
```

The trusted reusable workflow job should request only the job-level permissions
needed by the selected token mode.

Preferred conflict mode:

```yaml
permissions:
  contents: read
  id-token: write
```

The runtime then obtains a narrow posting capability through the validated OIDC
config exchange.

Workflow-token fallback mode:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
  id-token: write
```

If the implementation chooses Checks API instead of commit statuses, use
job-level `checks: write` instead of or in addition to `statuses: write`.

Job condition:

```yaml
if: >-
  ${{
    github.event_name == 'merge_group' ||
    github.event_name == 'repository_dispatch' ||
    github.event_name == 'workflow_dispatch' ||
    (
      github.event_name == 'pull_request' &&
      github.event.pull_request.draft == false
    )
  }}
```

Concurrency policy:

```yaml
concurrency:
  group: reviewrouter-conflict-${{ github.repository }}-${{ github.workflow }}-${{ github.run_id }}
  cancel-in-progress: false
```

Do not put `github.event.client_payload.*`, PR numbers, branch names, or public
marker/attempt ids into `concurrency.group`. A manual or stale
`repository_dispatch` can be evaluated by GitHub before ReviewRouter gets a
chance to reject it. Newer PR state is handled by stale validation, not by
pre-validation workflow cancellation.

Reusable workflow inputs:

```yaml
with:
  pr_number: ${{ github.event.pull_request.number || github.event.client_payload.pr_number || inputs.pr_number }}
  review_kind: ${{ github.event_name == 'repository_dispatch' && 'conflict-head' || 'normal' }}
  dispatch_event_type: ${{ github.event.action || '' }}
  expected_head_sha: ${{ github.event.client_payload.head_sha || '' }}
  expected_base_ref: ${{ github.event.client_payload.base_ref || '' }}
  expected_base_sha: ${{ github.event.client_payload.base_sha || '' }}
  dispatch_id: ${{ github.event.client_payload.dispatch_id || '' }}
  dispatch_nonce: ${{ github.event.client_payload.nonce || '' }}
```

The called reusable workflow should define these as explicit `workflow_call`
inputs with string types and should apply runtime validation before using them.
Do not rely on implicit type coercion from `client_payload`.

The first reusable workflow step in conflict mode should mask
`dispatch_nonce` with GitHub workflow commands before any diagnostic output.

The next privileged step should be the trusted ReviewRouter OIDC/config
preflight. Do not checkout repository content, restore caches, run local actions,
or start provider/model subprocesses before this preflight succeeds.

The workflow should pass these values as inputs only. Validation belongs in the
trusted reusable workflow/runtime, not in shell snippets in the customer caller.

Do not expose `review_kind`, `expected_head_sha`, `expected_base_ref`,
`expected_base_sha`, `dispatch_id`, or `dispatch_nonce` as `workflow_dispatch`
inputs. Manual workflow dispatch remains normal-review only in v1.

Do not add `repository_dispatch` to `reviewrouter-required.yml`.

Do not enable `repository_dispatch` on the explicit generated workflow until the
explicit path has a separate validation step that runs before provider CLI
install, provider auth restore, runtime config fetch, or provider execution.

### 7. Runtime Validation

The runtime must reject conflict mode unless:

- event name is `repository_dispatch`
- review kind is `conflict-head`
- dispatch event type is exactly `reviewrouter_conflict_review`
- OIDC audience is exactly the expected ReviewRouter runtime audience
- OIDC issuer is GitHub Actions
- `pr_number` is present
- `expected_head_sha` is a 40-char SHA
- `expected_base_ref` is present, passes the base-ref data validation rules, and
  is treated only as an exact string to compare with GitHub API data
- `expected_base_sha` is present and is a 40-char SHA for conflict fallback
- SaaS fallback nonce is valid before any provider-backed execution
- PR fetched from GitHub is open
- PR head SHA equals expected head SHA
- PR base ref equals expected base ref
- PR base SHA equals expected base SHA if provided
- PR is same-repo
- PR is not draft
- repository id matches OIDC/session repository
- OIDC `workflow_sha` and `job_workflow_sha` match trusted workflow capability
  metadata where those claims are available
- OIDC `runner_environment` is `github-hosted` unless an explicit self-hosted
  policy exists
- workflow ref is one of the approved ReviewRouter workflow paths
- reusable job workflow ref is trusted when present
- current mergeability still has a positive conflict signal, or the runtime
  exits stale before posting
- reviewed commit SHA is `expected_head_sha`, not `github.sha`
- runtime config source is SaaS/default-branch/static trusted config, not PR
  head files
- `review_config_snapshot_id` and `review_config_hash` match the snapshot used
  for model execution
- posting token mode is allowed for the repository/workflow capability
- if using ReviewRouter OIDC posting capability, the capability is issued only
  after all runtime validation above succeeds
- if using workflow `GITHUB_TOKEN`, job-level permissions are the expected
  minimal write scopes and no top-level workflow write permissions are present

If mergeability no longer has a positive conflict signal:

```text
If PR head SHA is unchanged but the PR is no longer conflicted:
  exit resolved-before-review/stale and do not post conflict findings.
```

This avoids a conflict fallback racing after the conflict was already fixed.
Do not set the normal ReviewRouter context from this path. A later explicit
normal-review dispatch can be designed separately, but it must validate and
review the actual merge result, not conflict-head semantics.

The runtime must repeat the full PR state validation immediately before posting.
Do not rely only on startup validation.

### 8. Checkout Strategy

For conflict mode:

```yaml
- name: Checkout pull request head
  uses: actions/checkout@v6
  with:
    ref: ${{ inputs.expected_head_sha }}
    fetch-depth: 1
    persist-credentials: false
    submodules: false
    lfs: false
    clean: true
```

Also fetch base metadata through GitHub API. Only fetch git history if the
runtime cannot build enough context from PR files and the checked-out head.

Do not rely on the default `actions/checkout` behavior in conflict mode. On
`repository_dispatch`, the default checkout target is the default branch workflow
context, not the PR head.

Do not attempt to checkout `refs/pull/<n>/merge` because it does not exist for
conflicted PRs.

Do not upload the checked-out workspace, diff batches, prompts, provider output,
or model output as GitHub Actions artifacts from conflict mode.

### 9. Diff Strategy

Preferred source of truth:

```text
GitHub PR files endpoint and PR diff data
```

Fallback:

```text
GitHub compare API
local git diff from PR merge base to head SHA
```

The runtime should label the diff as:

```text
PR head changes against base
```

not:

```text
merged PR result
```

### 10. Posting Strategy

Posting is not atomic across GitHub APIs. Treat it as a checkpointed sequence,
not one implicit operation.

Post:

- separate advisory commit status/check on `head_sha`
- summary comment with conflict marker
- inline comments where GitHub accepts them
- summary-only fallback for invalid inline positions

Do not:

- update the normal review summary marker
- set the normal ReviewRouter check context
- claim merge readiness
- submit an `APPROVE` review
- submit `REQUEST_CHANGES` unless a future opt-in branch-protection contract is
  explicitly designed
- update any existing comment unless its stored comment id, author/app identity,
  and marker metadata match the current head/base ref/SHA attempt
- treat the latest head-SHA status/check as proof that the current PR/base pair
  was reviewed
- leave a GitHub pull request review in `PENDING` state

Preferred write order:

```text
pre-post validation
-> compute posting manifest and safe hashes
-> create/update summary comment
-> post bounded inline comments or degrade to summary-only
-> repeat pre-post validation
-> post final advisory status/check
-> mark posting completed
```

Recovery rules:

```text
summary posted, status missing -> retry resumes from stored summary_comment_id
some inline comments posted -> retry skips stored inline fingerprints
status/check posted -> duplicate-status suppression runs before any new write
pending review found -> do not submit it automatically; mark degraded and require operator cleanup unless a future cleanup design exists
```

Inline comment mode:

- Prefer `line`/`side` coordinates over `position` for new GitHub review
  comments.
- If using the pull request review API, explicitly set `event=COMMENT` and
  `commit_id=expected_head_sha`.
- Cap inline comments per run. If GitHub returns secondary rate limiting,
  degrade remaining findings to summary-only and mark partial/degraded.

Recommended commit status states:

```text
success  -> conflict review completed and no blocking findings under conflict policy
failure  -> blocking findings under conflict policy
error    -> runtime/provider failure
pending  -> optional, only if status is created at run start
```

Even `success` means only:

```text
Conflict-head review completed for the PR/base identity recorded in the
ReviewRouter attempt.
```

It must not mean:

```text
The PR is merge-ready.
```

Status/check description should include `conflict-only` or equivalent copy and
must not be reused as a required normal-review gate.

## Rollout Plan

### Phase 0: Design Lock

```text
🎯 10   🛡️ 10   🧠 3
Estimated change: docs only
```

Tasks:

- Agree on the separate `conflict-head` semantics.
- Agree that it does not satisfy the normal required check.
- Agree same-repo only for v1.
- Agree v1 conflict fallback runs only through the trusted reusable caller.
- Agree explicit generated workflows are skipped until they have pre-secret
  validation.
- Agree `reviewrouter-required.yml` is out of scope for conflict fallback.
- Agree whether v1 adds a `push` event subscription for base-branch
  reconciliation or starts with scheduled reconciliation only.
- Agree that nonce/OIDC validation is part of MVP for provider-backed runs, not
  a later hardening item.
- Agree whether generated workflow examples may show major action tags while
  production rendering supports full-SHA pins for stricter org policies.
- Agree on posting token mode. Preferred: ReviewRouter OIDC posting capability
  after runtime validation. Fallback: workflow `GITHUB_TOKEN` with job-level
  write scopes only.

Stop gate:

```text
No provider-backed conflict fallback may be enabled before the nonce/OIDC gate,
status/check token path, write-token isolation, and stale-post guard are
implemented.
```

### Phase 1: Workflow Template and Capability

```text
🎯 9   🛡️ 9   🧠 5
Estimated change: 120-220 lines
```

Tasks:

- Add `repository_dispatch` trigger to the generated reusable review caller.
- Add reusable workflow inputs for conflict mode.
- Generate `permissions: {}` at workflow level unless existing templates require
  an even stricter equivalent.
- Add job-level permissions based on the chosen posting strategy.
- Add action-ref pinning mode and trusted action allowlist for generated
  workflow output.
- Add tests for generated workflow content.
- Add capability detection for fallback-supported workflow.
- Add capability versioning so SaaS can distinguish old and new workflows.
- Add normalized template hash or equivalent trusted-shape check.
- Store allowed `job_workflow_sha` values for the trusted reusable workflow
  release/capability version.
- Add tests proving explicit and required workflows do not accidentally enable
  conflict fallback.
- Add tests proving manual `workflow_dispatch` exposes only normal-review inputs.
- Add health copy for org Actions policy blocking the trusted reusable workflow.
- Add health copy for action pinning policy mismatch.

Acceptance:

- Existing normal `pull_request` semantics remain unchanged.
- Explicit generated workflow rendering remains conflict-fallback disabled unless
  separately redesigned.
- Required workflow rendering remains unchanged.
- Tests prove no `pull_request_target`.
- Tests prove the caller does not use raw payload values in shell scripts.
- Tests prove conflict workflow uses only trusted action refs and no PR-head
  local actions.
- Tests prove no top-level write permissions or `write-all` are generated.
- Config exchange later rejects a mutable trusted ref if `job_workflow_sha` is
  missing or not in the allowed manifest.

### Phase 2: SaaS Conflict Detector

```text
🎯 9   🛡️ 8   🧠 7
Estimated change: 220-360 lines
```

Tasks:

- On PR webhook, enqueue mergeability check.
- On base-branch push or scheduled reconciliation, enqueue bounded open-PR
  conflict checks.
- Retry unknown mergeability.
- Create fallback attempt record with unique key.
- Create fallback nonce and store only its hash.
- Dispatch `repository_dispatch` from an outbox worker after the fallback record
  transaction commits.
- Record safe metadata.
- Rate-limit conflict fallback dispatches by repository and PR.
- Add terminal-state-aware retry policy.

Acceptance:

- Clean PR does not dispatch.
- Dirty PR dispatches once.
- Duplicate webhook does not dispatch twice.
- Draft/fork/closed PRs are skipped.
- Explicit/required workflow repositories are skipped with clear capability
  state.
- Dispatch payload never contains code, diff, prompts, provider output, or
  secrets.
- Base-branch push reconciliation does not scan unrelated repositories or store
  push commit contents.

### Phase 3: Runtime Conflict Mode

```text
🎯 9   🛡️ 9   🧠 8
Estimated change: 240-420 lines
```

Tasks:

- Add `REVIEW_ROUTER_REVIEW_KIND=conflict-head` or a dedicated input.
- Validate dispatch record and nonce before provider-backed execution.
- Validate PR state before review.
- Validate stale state before posting.
- Use separate check/status context.
- Use separate summary marker.
- If using ReviewRouter OIDC posting capability, request it only after full
  runtime validation and keep it inside the posting client.
- Degrade inline failures to summary-only.
- Use PR files/diff data as the preferred diff source.
- Enforce conflict-mode checkout policy: exact head SHA, no credentials,
  submodules, LFS, dependency caches, hooks, package scripts, generators, tests,
  or builds.
- Enforce provider/model subprocess environment allowlist.
- Disable artifacts and caches for conflict-mode runtime data.

Acceptance:

- Stale head exits without comments.
- Conflict review posts separate status.
- Normal review path is not changed.
- Status/check posting failure is reported as degraded, not silently ignored.
- Posting token mint/validation failure is reported as degraded, not retried
  through normal ReviewRouter context.
- PR-controlled submodules, LFS, caches, hooks, and local actions do not run.
- Tokens, nonce, prompts, diffs, provider output, and model output are not
  persisted to logs, artifacts, caches, health reports, or subprocess env.

### Phase 4: Required OIDC and Nonce Gate

```text
🎯 9   🛡️ 10   🧠 8
Estimated change: 80-160 lines
```

Tasks:

- Add `repository_dispatch` to allowed OIDC events.
- Add fallback nonce validation in config exchange.
- Mark nonce one-time-use or bind it to `head_sha`.
- Add tests for invalid nonce, stale nonce, wrong head SHA, wrong base ref,
  wrong base SHA, and wrong repo.
- Add tests proving `repository_dispatch` cannot exchange normal runtime config.
- Add tests proving `workflow_dispatch` cannot select conflict-head mode.
- Record `run_id` and `run_attempt` from OIDC claims when runtime starts.

Acceptance:

- `repository_dispatch` from allowed workflow can exchange config only with a
  valid fallback record.
- Random dispatch cannot obtain runtime config.
- Replayed nonce cannot obtain runtime config.
- Wrong workflow ref cannot obtain runtime config.

### Phase 5: Beta Rollout

```text
🎯 8   🛡️ 9   🧠 6
Estimated change: 40-100 lines
```

Tasks:

- Feature flag by workspace/repository.
- Add health state in dashboard.
- Run disposable conflict PR smoke test.
- Monitor dispatch counts, skips, stale exits, comment failures.

Acceptance:

- No duplicate comments across repeated webhook delivery.
- No false green.
- No unexpected provider execution for fork PRs.

## Edge Cases

### Clean PR

Expected:

```text
No fallback dispatch.
Normal pull_request workflow handles review.
```

### Conflict PR

Expected:

```text
Fallback dispatches once for the current head/base ref/SHA pair.
Conflict review posts separate status/check.
```

### Conflict Resolved Before Fallback Starts

Expected:

```text
Fallback runtime fetches PR.
Mergeability no longer has a positive conflict signal.
Runtime exits resolved-before-review/stale.
Runtime does not post conflict findings.
Runtime does not set the normal ReviewRouter context.
Attempt records normal_review_recheck_needed unless a fresh normal review for
the same repo/PR/head/base identity is already observed.
```

Note:

```text
If the conflict disappeared because the base branch changed, a normal pull_request
workflow may not automatically appear because the PR head did not change. That is
a separate normal-review recovery problem and must not be solved by pretending
the conflict-head review is normal review.
```

### Base Push Resolves Conflict Without Head Change

Expected:

```text
Base-push reconciliation fetches affected open PRs.
PR is now mergeable or inconclusive rather than positively conflicted.
No conflict fallback review is dispatched.
If no normal ReviewRouter run exists for the current repo/PR/head/base identity,
record normal_review_recheck_needed.
If a safe normal-review rerun mechanism exists, enqueue it through normal-review
idempotency, not conflict fallback.
If not, dashboard/summary copy tells the user that normal review still needs a
fresh PR event or explicit normal-review rerun.
```

### New Commit Pushed During Review

Expected:

```text
Old run reaches pre-post validation.
head_sha mismatch.
Old run exits without comments.
New fallback attempt can be created for new head_sha if still conflicted.
```

### PR Closed or Drafted During Review

Expected:

```text
Runtime reaches pre-post validation.
Fresh PR state is closed, merged, or draft.
Runtime exits stale/no-op.
No summary, inline comments, or success/failure conflict status is posted.
```

### Duplicate Webhook Delivery

Expected:

```text
Unique DB key prevents duplicate dispatch.
```

### Dispatch Succeeds but Workflow Missing Trigger

Expected:

```text
Capability detection should prevent this before dispatch.
If it still happens, mark fallback attempt as no_run_observed.
```

### Dispatch Created by User Manually

Expected:

```text
Runtime requires valid SaaS fallback nonce for OIDC config.
Without it, no runtime config and no review.
```

### Self-Generated Repository Dispatch Webhook

Expected:

```text
Webhook delivery may be recorded for audit/debugging.
No conflict detector job is enqueued.
No normal review job is enqueued.
No setup or repository health is marked green from this event alone.
```

### Repository in Static Config Mode

Expected:

```text
No SaaS config nonce is available.
Default is disabled for conflict fallback unless explicitly allowed.
If explicitly allowed, runtime still validates same-repo PR, open state, current head SHA, and trusted workflow.
```

### PR Changes ReviewRouter Config

Expected:

```text
Conflict runtime may read the changed config file as review input.
It does not use PR-head config to choose providers, limits, trusted refs, prompts, or posting behavior.
Runtime config still comes from SaaS/default-branch/static trusted source.
```

### Provider Secrets Missing

Expected:

```text
Conflict review reports provider auth missing through existing safe health path.
No code/diff is sent to SaaS.
```

### Inline Position Invalid

Expected:

```text
Skip that inline.
Include finding in summary.
Do not fail entire run unless provider/runtime itself failed.
```

### Posting Crashes After Summary

Expected:

```text
Summary comment id and summary body hash are checkpointed before inline/status writes.
Retry updates or reuses the stored summary comment id.
Retry does not create a duplicate summary from marker search alone.
Final status/check is posted only after a fresh pre-post validation.
```

### Posting Crashes After Some Inline Comments

Expected:

```text
Posted inline finding fingerprints are checkpointed.
Retry skips already-posted inline fingerprints.
Findings whose coordinates are no longer valid are moved to summary-only.
Attempt is marked partial/degraded if not every planned inline can be posted.
```

### Pending GitHub Review Exists

Expected:

```text
V1 should not create this state.
Runtime does not submit a found pending review automatically because it cannot prove the draft body still matches the current attempt.
Attempt is marked degraded with pending_review_found.
Operator cleanup or a future explicit cleanup design is required before enabling pending review batching.
```

### Secondary Rate Limit During Inline Posting

Expected:

```text
Stop posting more inline comments.
Do not retry the burst immediately.
Move remaining findings to summary-only.
Post final advisory status/check as partial/degraded after fresh pre-post validation.
```

### User Spoofs Conflict Summary Marker

Expected:

```text
Do not update user-authored comments even if they contain the hidden marker.
Update only the stored ReviewRouter comment id or a comment authored by the expected App/bot identity with matching repo/pr/head/base marker metadata.
If ownership cannot be proven, create a new summary comment and record safe health metadata.
Marker metadata is decoded through a canonical parser. Raw branch names inside HTML comment markers are invalid.
```

### Model Output Contains ReviewRouter Marker Namespace

Expected:

```text
Runtime strips or escapes marker namespace text from model-controlled sections.
Runtime appends exactly one deterministic marker footer that it computes itself.
If an existing bot-authored summary contains extra marker namespace strings outside the footer, marker parsing rejects it as ambiguous.
Do not update that ambiguous comment by marker search alone.
Create a new safe summary comment or use the stored comment id only if ownership and footer metadata still validate.
```

### Model Output Tries to Control Posting

Expected:

```text
Schema validation rejects model fields that look like status, context, target_url, comment_id, marker, token, nonce, retry, approve, or request_changes.
Runtime computes status/check state and posting destinations from trusted policy and validated attempt state only.
No comments, reviews, or statuses are posted from unvalidated model control fields.
Attempt records safe health metadata if output cannot be safely normalized.
```

### Conflict Review Findings Are Blocking

Expected:

```text
Post failure on the separate ReviewRouter conflict review status/check.
Do not submit APPROVE.
Do not submit REQUEST_CHANGES unless a future explicit opt-in design makes conflict review a branch-protection gate.
Normal human review state remains untouched.
```

### Huge Diff

Expected:

```text
Use existing diff compaction and batching.
Conflict mode should not bypass diff size limits.
```

### PR Files API Limit or Missing Patch

Expected:

```text
Fetch paginated PR files up to the documented GitHub limit.
If file list or patch data is incomplete, mark review as partial.
Do not post inline comments for files/lines without trustworthy mapping.
Include summary-only notes where safe.
```

### Generated or Lockfile-Only Conflict PR

Expected:

```text
Use existing trivial/dependency/doc skipping logic.
Post clear skipped reason in conflict status/check if needed.
```

### Bot PR

Expected:

```text
Follow existing bot PR policy.
If normal review skips bots for secret-backed execution, conflict fallback should match that behavior.
```

### Base Branch Changes During Review

Expected:

```text
If current base SHA changed and expected_base_sha is set, exit stale.
This avoids reviewing against an old base while presenting current findings.
```

### PR Retargeted to Different Base Ref With Same Base SHA

Expected:

```text
Runtime exits stale because expected_base_ref no longer matches.
Detector may create a new attempt for the new base_ref after a fresh positive conflict signal.
Do not reuse old comment markers, inline fingerprints, posting tokens, or terminal status suppression keys.
```

### Old Conflict Status Visible After Retarget

Expected:

```text
Old commit status/check may still be visible on the same head SHA.
ReviewRouter does not treat that status/check as current for the new PR/base identity.
PR-specific summary marker and fallback attempt record are authoritative.
Dashboard/setup copy warns that the conflict context must not be required.
```

### Multiple PRs Share the Same Head SHA

Expected:

```text
Each same-repo PR is evaluated through its own fallback attempt record.
Summary comments and inline findings remain PR-scoped.
Commit status/check copy stays conflict-only and advisory because the object is head-SHA visible.
No product decision uses head-SHA status/check without checking repository id, PR number, base ref, and base SHA.
```

### Base Branch Push Creates New Conflict

Expected:

```text
Default/base push reconciliation fetches open PRs targeting that base.
Each same-repo PR is evaluated through the normal conflict detector.
Dirty PRs dispatch once per head/base ref/SHA pair.
Push commit contents are not stored.
```

### Base Branch Changes While Same PR Head Stays Conflicted

Expected:

```text
Create a new fallback attempt because base_sha changed.
Do not suppress it as a duplicate of the previous head_sha attempt.
Comment markers and inline fingerprints include base_sha to avoid mixing findings.
Older runs with the previous base_sha exit stale before posting.
```

### Merge Queue Event Arrives

Expected:

```text
merge_group stays normal-review mode.
Conflict fallback does not post status/check to the merge group SHA or gh-readonly-queue ref.
Conflict fallback health does not satisfy merge queue required checks.
```

If `push` webhooks are not enabled:

```text
Scheduled reconciliation is the only automatic catch-up.
Dashboard/ops docs must call out the delayed detection.
```

### Mergeability Stays Unknown

Expected:

```text
Retry with bounded backoff.
If still unknown, record conflict_detection_inconclusive.
Do not dispatch.
```

### Head Branch Deleted

Expected:

```text
Fresh PR fetch or checkout fails safely.
Mark skipped/stale.
Do not comment.
```

### Workflow Updated Only in PR Branch

Expected:

```text
Ignore it.
repository_dispatch uses the workflow from the default branch only.
Capability detection must inspect the default-branch workflow.
```

### Explicit Generated Workflow

Expected:

```text
Capability detection marks conflict fallback unsupported for v1.
No repository_dispatch is sent.
Dashboard asks for a reusable caller update or a future explicit-mode upgrade.
```

Reason:

```text
Existing explicit workflow setup restores provider auth before conflict nonce validation.
```

### Required Workflow

Expected:

```text
reviewrouter-required.yml keeps only pull_request and merge_group semantics.
No repository_dispatch trigger.
No conflict-head review can satisfy ReviewRouter Required.
```

### Status Permission Missing

Expected:

```text
Review may still produce a summary if comment permissions exist.
Attempt is marked degraded with status_post_failed.
Do not create a normal ReviewRouter status as fallback.
```

### Posting Token Cannot Be Minted

Expected:

```text
Runtime does not post comments or statuses with a broader token.
Attempt is marked degraded with posting_token_unavailable or posting_token_rejected.
Do not fall back to normal ReviewRouter context.
Do not retry provider execution.
```

### Generated Workflow Has Top-Level Write Permissions

Expected:

```text
Capability probe marks conflict fallback unsupported until the workflow is updated.
Runtime refuses conflict-head config if workflow shape validation detects broad write scopes.
Dashboard explains that write scopes must be job-level or replaced by OIDC-scoped posting.
```

### OIDC Claim Missing or Audience Wrong

Expected:

```text
Runtime config exchange fails closed.
Attempt is marked oidc_validation_failed with safe metadata only.
No provider-backed config, posting token, summary, or status/check is returned.
Dashboard asks for workflow/runtime update if the claim is unavailable due to old template shape.
```

### Nonce or OIDC Request Token Is Visible Before Preflight

Expected:

```text
The workflow shape is rejected if checkout, cache restore, package scripts, local actions, or nonessential external actions run before ReviewRouter OIDC preflight.
Provider/model subprocesses never inherit ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN, nonce, GITHUB_TOKEN, or posting tokens.
Config exchange treats nonce as correlation plus replay guard, not standalone authorization.
```

### App Permission Missing for Repository Dispatch

Expected:

```text
Dispatch call fails safely.
Record dispatch_failed with safe error summary.
Surface setup/permission remediation instead of retrying forever.
```

### Repository Renamed or Transferred During Dispatch

Expected:

```text
SaaS refreshes repository metadata by GitHub repository id.
If the installation still controls the repository, dispatch uses the fresh owner/name.
If not, attempt is skipped with installation_not_active or repository_not_selected.
Runtime validates repository_id before returning config or posting.
```

### Random Manual Repository Dispatch

Expected:

```text
Workflow may start.
Runtime cannot obtain provider-backed config without a matching SaaS record and nonce.
No review comments are posted.
```

### Manual Dispatch Reuses Public Marker or Dispatch Id

Expected:

```text
Workflow may start, but it cannot cancel a legitimate conflict run through
workflow concurrency because concurrency groups do not use payload fields or
public marker/attempt ids.
Runtime cannot obtain provider-backed config without matching OIDC, nonce, and
fallback record.
No review comments or statuses are posted.
```

### Conflict Status Required by User

Expected:

```text
Do not automatically configure this.
If a user makes it required, document that it is advisory and separate from normal review.
Normal ReviewRouter review still runs after conflicts are resolved.
```

### Dispatch Run Cancelled by New Commit

Expected:

```text
Old run may continue briefly.
Old run exits stale before comments after head SHA validation.
If trusted SaaS-side cancellation is implemented later, old attempt is marked cancelled.
No duplicate comments.
```

### GitHub API Rate Limit

Expected:

```text
Stop dispatching for the repository temporarily.
Record rate_limited.
Do not burn retries in a tight loop.
```

### Payload Limit or Validation Failure

Expected:

```text
Keep client_payload small.
If runtime validation fails, exit without comments and report safe metadata only.
```

### Mergeability Signal Is Ambiguous

Expected:

```text
Retry bounded times if GitHub reports UNKNOWN/null or omits conflict detail.
Do not dispatch only because REST mergeable is false.
Dispatch only when GraphQL mergeable is CONFLICTING, GraphQL mergeStateStatus is DIRTY, or an equivalent fresh conflict state is present.
Record conflict_signal_inconclusive if the positive signal never appears.
```

### Repository Dispatch Attempts Normal Mode

Expected:

```text
OIDC exchange rejects repository_dispatch unless review_kind is conflict-head.
Runtime config is not returned.
Attempt is recorded as dispatch_mode_invalid or oidc_validation_failed.
```

### Workflow Dispatch Attempts Conflict Mode

Expected:

```text
Generated workflow has no user-editable conflict-head inputs.
Runtime rejects conflict-head unless event_name is repository_dispatch.
Manual rerun remains normal-review only.
```

### GitHub UI Rerun of Old Dispatch

Expected:

```text
Runtime validates nonce against the original dispatch record and GitHub run identity.
If rerun policy allows same run_id with a new run_attempt, config exchange succeeds.
If run_id differs or the record is terminal/expired, config exchange fails closed.
```

### Actions Disabled or Workflow Disabled

Expected:

```text
Capability probe detects disabled Actions/workflow where possible.
SaaS does not dispatch.
If dispatch already happened, mark no_run_observed after TTL and surface remediation.
```

### Reusable Workflow Blocked by Organization Policy

Expected:

```text
Dispatch may succeed but runtime never starts.
Attempt becomes reusable_workflow_policy_blocked_or_no_run_observed after TTL.
Dashboard asks the user to allow the trusted reusable workflow ref.
No automatic fallback to explicit workflow.
```

### Action Pinning Policy Requires Full SHA

Expected:

```text
Capability probe detects the generated workflow is not policy-compatible where possible.
If dispatch already happened and no run starts, mark workflow_action_policy_blocked or no_run_observed.
Dashboard asks the user to update generated workflow rendering or allow the trusted action refs.
No automatic fallback to explicit workflow.
```

### Self-Hosted Runner Override

Expected:

```text
Generated workflow uses GitHub-hosted runner for v1.
If customer edits to self-hosted, fallback is unsupported unless explicit policy allows it.
Runtime still refuses to execute PR code.
```

### PR Adds Local Action or Composite Action

Expected:

```text
Conflict workflow does not execute actions from the checked-out PR workspace.
Conflict runtime treats workflow/action changes in the PR as review input only.
Config exchange still uses the trusted default-branch workflow identity.
```

### Conflict Run Would Upload Sensitive Artifact

Expected:

```text
Conflict mode blocks artifact/cache creation for workspace files, diffs, prompts, provider output, model output, tokens, and nonce.
Attempt records sensitive_runtime_data_blocked if a code path tries to persist it.
Logs and health metadata contain only safe counts, categories, timings, and run ids.
```

### Interaction Workflow Dispatch Attempt

Expected:

```text
Conflict-head config exchange rejects workflow_ref for reviewrouter-interaction.yml.
No provider-backed config is returned.
No review comments are posted.
```

### Conflict Status Webhook Arrives

Expected:

```text
Webhook normalization accepts it only as safe metadata if needed.
No review dispatch is enqueued from status/check/workflow_run events.
Normal repository health is not marked successful based on conflict-only status.
```

### Conflict Summary Comment Webhook Arrives

Expected:

```text
Webhook normalization accepts it only as safe metadata if needed.
No interaction command is executed from ReviewRouter-authored conflict summaries.
No conflict detection or normal review dispatch is enqueued from the comment webhook.
```

### Status Context Spam

Expected:

```text
Use one stable context: ReviewRouter conflict review.
Do not create per-model, per-provider, per-run, or per-attempt contexts.
If status churn becomes high, move richer state into a check run or summary comment.
Do not emit a commit status and a check run with the same name at the same time.
```

### Status and Check Name Collision

Expected:

```text
Pick either commit status or check run for v1.
If migrating object type later, use a separate migration name or a no-overlap rollout.
Dashboard warns if both objects with the same required check name are observed.
```

### Commit Status Limit Approaches

Expected:

```text
Do not create multiple lifecycle statuses for the same SHA/context.
Suppress duplicate terminal statuses for the same attempt conclusion.
If mutable lifecycle is needed, move to check runs.
```

### Failed Dispatch Retry

Expected:

```text
If GitHub dispatch fails before any run starts, retry through the same outbox/idempotency path.
If a run started or comments were posted, do not auto-retry unless a safe retry policy explicitly allows it.
Every retry uses a fresh nonce and dispatch id unless it is the same authenticated run exchange.
```

## Test Plan

### Unit Tests

- reusable workflow template includes `repository_dispatch` trigger
- workflow templates do not include `pull_request_target`
- generated caller uses `permissions: {}` at workflow level or stricter
  equivalent
- reusable workflow template uses job-level permissions
- conflict workflow does not generate `write-all`, `read-all`, or top-level
  write permissions
- ReviewRouter OIDC posting capability mode does not require workflow
  `statuses: write` or `checks: write`
- workflow-token fallback mode includes only the selected job-level
  `statuses: write` or `checks: write`
- explicit workflow template does not enable conflict fallback in v1
- required workflow template does not include `repository_dispatch`
- reusable workflow passes `pr_number` from `client_payload`
- reusable workflow passes `expected_head_sha`
- reusable workflow passes dispatch id and nonce
- reusable workflow passes dispatch event type
- reusable workflow does not interpolate payload into shell
- reusable workflow concurrency group does not reference `client_payload`,
  branch names, PR numbers, public marker ids, or dispatch ids
- reusable workflow does not enable `cancel-in-progress` for unvalidated
  repository_dispatch runs
- reusable workflow does not expose conflict-head inputs through workflow_dispatch
- dispatch payload schema rejects more than 10 top-level payload keys
- dispatch payload schema rejects payloads above 65,535 characters
- dispatch nonce is masked before diagnostic output
- health/audit/status/comment payloads never include raw nonce
- provider/model subprocess environment allowlist excludes `GITHUB_TOKEN`, App
  tokens, dispatch nonce, `ACTIONS_ID_TOKEN_REQUEST_URL`,
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, prompts, and full diffs
- conflict-mode debug logging redacts tokens, nonce, prompts, diffs,
  provider output, and model output
- conflict-mode artifact/cache policy rejects uploads of workspace files, diff
  batches, prompts, provider output, model output, tokens, or nonce values
- action-control-plane accepts `repository_dispatch`
- action-control-plane rejects unrelated workflow refs
- action-control-plane rejects wrong OIDC audience
- action-control-plane rejects missing or wrong `job_workflow_sha` when trusted
  capability metadata requires it
- action-control-plane rejects unsupported `runner_environment`
- action-control-plane treats nonce as insufficient without valid OIDC claims
- conflict detector skips clean PR
- conflict detector skips draft PR
- conflict detector skips fork PR
- conflict detector skips unsupported workflow capability
- conflict detector skips untrusted workflow shape
- conflict detector skips explicit workflow style in v1
- conflict detector skips required-workflow-only repositories
- conflict detector skips ambiguous non-mergeable PRs without positive conflict
  signal
- conflict detector treats `UNKNOWN`, `null`, missing mergeability detail, and
  API timeout as inconclusive after bounded retries
- conflict detector enqueues from base-branch push reconciliation
- conflict detector scheduled reconciliation catches base-push-created conflicts
- conflict detector dispatches positively conflicting PR once
- conflict detector ignores duplicate dirty webhook for same head/base ref/SHA pair
- conflict detector dispatches again for new head SHA or new base SHA
- conflict detector records exact conflict signal source
- fallback nonce validates for matching repo/pr/head/base
- fallback nonce rejects wrong repo
- fallback nonce rejects wrong PR number
- fallback nonce rejects wrong head SHA
- fallback nonce rejects wrong base ref
- fallback nonce rejects wrong base SHA
- expected base ref validation rejects control characters, CR/LF, leading
  `refs/`, `..`, `@{`, traversal-like segments, overlong names, and
  `gh-readonly-queue/*`
- runtime never uses base ref in shell commands, cache keys, artifact names,
  concurrency groups, or string-built refspecs
- fallback nonce rejects expired nonce
- fallback nonce rejects reused nonce if one-time-use is implemented
- fallback nonce allows only documented same-run rerun behavior
- OIDC exchange rejects repository_dispatch for normal runtime config
- OIDC exchange rejects workflow_dispatch for conflict-head runtime config
- conflict mode rejects wrong dispatch event type
- conflict mode rejects `reviewrouter-interaction.yml` workflow refs
- conflict mode rejects missing status/check token path
- conflict mode never submits `APPROVE`
- conflict mode never submits `REQUEST_CHANGES` unless a future opt-in design
  explicitly enables it
- conflict mode never creates a GitHub pull request review without explicit
  `event=COMMENT` in v1
- conflict mode rejects or degrades if it detects an existing pending review for
  the same attempt
- conflict mode verifies existing summary comment id, author/app identity, and
  marker metadata before update
- conflict summary marker parser rejects raw/unencoded user-controlled marker
  metadata
- conflict summary marker parser rejects bot-authored summaries that contain
  extra ReviewRouter marker namespace strings outside the deterministic footer
- model output schema rejects control-like fields such as `status`, `context`,
  `target_url`, `comment_id`, `marker`, `token`, `nonce`, `retry`, `approve`,
  and `request_changes`
- runtime computes status/check state, context, target URL, comment id, and
  marker footer independently of model output
- model/PR-controlled markdown is sanitized before posting: ReviewRouter marker
  namespace escaped/removed, raw HTML blocked, mentions disarmed, and body
  lengths bounded
- runtime config exchange returns immutable `review_config_snapshot_id` and
  `review_config_hash`
- conflict mode stores config snapshot id/hash, prompt policy version, output
  schema version, and provider routing version on the fallback attempt
- posting-token exchange rejects config snapshot mismatch between model
  execution and posting
- same-attempt retry reuses the original config snapshot; a different config
  snapshot requires explicit new-attempt semantics
- posting manifest is computed before GitHub writes and only safe hashes/ids are
  persisted
- crash recovery after summary, inline comments, or status/check does not
  duplicate already-checkpointed writes
- secondary rate limit during inline posting degrades remaining findings to
  summary-only instead of immediate burst retry
- conflict mode rejects broad workflow write permissions
- conflict mode mints posting token only after OIDC, nonce, workflow ref,
  repository id, PR state, head SHA, base ref, and base SHA validation
- posting token is scoped to repository id, PR number, head SHA, base ref, base SHA,
  context, allowed APIs, and short TTL
- posting capability scope is enforced by ReviewRouter server-side logic, not
  assumed from raw GitHub App installation token granularity
- posting proxy rejects writes to any other PR, head SHA, base ref/SHA,
  status/check context, or comment id
- posting token is minted after pre-post validation, not before checkout/model
  execution
- conflict status/check is treated as advisory and never as the source of truth
  for current PR/base identity
- old success/failure status on the same head SHA does not suppress a new
  fallback attempt after base ref or base SHA changes
- conflict mode uses PR files/diff data before local diff fallback
- conflict mode degrades invalid changed-line mapping to summary-only
- conflict mode marks review partial when PR files data is incomplete
- conflict mode rejects unsupported self-hosted runner policy if surfaced to runtime
- conflict mode never uses `github.sha` as the review head for repository dispatch
- conflict mode posts status/check to expected head SHA
- conflict mode does not load ReviewRouter policy/config from PR head
- conflict mode checkout template sets `persist-credentials: false`,
  `submodules: false`, `lfs: false`, `clean: true`, and exact
  `expected_head_sha`
- conflict mode does not restore dependency caches or run repository hooks
- conflict workflow template does not include local actions from the checked-out
  PR workspace
- workflow action refs are validated against the selected pinning policy
- workflow shape rejects checkout/cache/package/model steps before trusted OIDC
  preflight
- pre-post validation rejects closed, merged, draft, forked, renamed, or
  superseded PR state
- repository rename/transfer uses GitHub repository id as authority
- status/check webhook for conflict context does not enqueue new review work
- comment webhook from ReviewRouter-authored conflict summary does not enqueue
  interaction, conflict detection, or normal review work
- repository_dispatch webhook does not enqueue review work
- conflict status is not treated as normal ReviewRouter health success
- status context is stable and does not include run/provider/model identifiers
- conflict mode does not emit commit status and check run with the same name
- commit status posting suppresses duplicate terminal statuses for the same
  attempt conclusion
- reusable workflow policy block becomes no_run_observed/remediation health
- retry policy allows dispatch failure retry before run start
- retry policy blocks terminal-state automatic retries

### Integration Tests

- same-repo conflict PR receives conflict review status
- duplicate webhook does not create duplicate summary
- stale run does not post comments
- PR closed/drafted during review does not receive comments or terminal success/failure status
- conflict resolved before fallback does not post normal ReviewRouter context
- inline comment failure degrades to summary-only
- user-authored comment containing the hidden marker is not edited
- model output containing `<!-- reviewrouter:` does not create a second valid
  marker or cause the bot to update an ambiguous summary
- model output cannot choose failure/success status, status context, target URL,
  comment id, or review decision
- oversized model output is truncated with a partial note or rejected safely
  before GitHub posting
- conflict mode does not change GitHub review approval/request-changes state
- normal PR review still uses normal context
- conflict review does not satisfy normal context
- manual repository dispatch without nonce does not obtain config
- manual repository dispatch cannot obtain normal runtime config
- workflow_dispatch cannot obtain conflict-head config
- GitHub UI rerun follows nonce/run identity policy
- interaction workflow cannot obtain conflict-head provider config
- conflict status/check webhook does not create a feedback loop
- conflict summary comment webhook does not create an interaction feedback loop
- self-generated repository_dispatch webhook does not create a feedback loop
- status/check posting failure is visible as degraded health
- posting token mint or validation failure is visible as degraded health
- manual repository_dispatch using a known/public marker or dispatch id cannot
  cancel a legitimate fallback run
- raw GitHub App installation token mode records `raw_app_token_scope_degraded`
  because operation enforcement after minting is weaker than proxy mode
- broad generated workflow permissions are rejected by capability/runtime
  validation
- old conflict run is cancelled or stale after new head SHA
- PR retarget to different base ref with the same base SHA creates a separate
  attempt and stale-exits older runs
- conflict fallback does not affect `merge_group` required checks or post to
  merge group SHAs
- status/check name collision is detected or prevented during rollout
- conflict context required-check configuration is detected when possible or
  clearly warned against in setup copy
- two PRs with the same head SHA do not share PR-specific summary/comment
  state, even though the status/check is head-SHA visible
- old conflict status/check on the same head SHA does not drive product
  decisions after PR retarget
- explicit workflow repository is skipped until compatible
- required workflow is not modified by conflict fallback rollout
- base branch push that creates conflict triggers fallback or scheduled catch-up
- base branch push that resolves conflict without head change records
  `normal_review_recheck_needed` or enqueues safe normal-review rerun
- ambiguous mergeability does not dispatch conflict fallback
- base branch push that changes base SHA for an already conflicted same-head PR
  creates a new head/base ref/SHA attempt
- same-head different-base findings do not reuse old hidden markers or inline
  fingerprints
- org Actions policy block is reported without explicit workflow fallback
- PR-head ReviewRouter config changes are treated as review input, not trusted policy
- repository rename/transfer during dispatch is handled by repository id
- malicious PR submodule and LFS configuration is not fetched in conflict mode
- provider/model subprocess cannot read `GITHUB_TOKEN`, App tokens, dispatch
  nonce, OIDC request env vars, prompts, or full diffs through inherited
  environment variables
- conflict-mode run does not create artifacts or caches containing workspace
  files, diff batches, prompts, provider output, model output, tokens, or nonce
- action policy that requires full SHA pins is surfaced as capability/health
  state, not bypassed with explicit workflow fallback

### Smoke Tests

Use a disposable test repository.

Test matrix:

```text
1. Create base file on main.
2. Create PR branch changing same line.
3. Change same line on main to create conflict.
4. Open PR.
5. Confirm normal pull_request workflow does not run.
6. Confirm conflict fallback dispatches.
7. Confirm "ReviewRouter conflict review" appears on head SHA.
8. Confirm summary says final resolved merge result was not reviewed.
9. Push new commit to PR.
10. Confirm old run is stale and new attempt is used.
11. Resolve conflict by pushing a new commit to the PR branch.
12. Confirm normal pull_request workflow runs for the new PR head.
13. Create another conflict and resolve it by changing only the base branch.
14. Confirm conflict fallback records normal_review_recheck_needed or enqueues
    the safe normal-review rerun path.
15. Confirm no normal ReviewRouter success is synthesized by conflict mode.
```

## Observability

SaaS should record metadata only:

```text
fallback_detected_count
fallback_dispatched_count
fallback_duplicate_suppressed_count
fallback_skipped_draft_count
fallback_skipped_fork_count
fallback_skipped_capability_count
fallback_stale_count
fallback_resolved_before_review_count
fallback_completed_count
fallback_failed_count
fallback_partial_review_count
fallback_inline_degraded_count
fallback_status_post_failed_count
fallback_no_run_observed_count
fallback_nonce_rejected_count
fallback_rate_limited_count
fallback_rerun_rejected_count
fallback_dispatch_mode_invalid_count
fallback_interaction_workflow_rejected_count
fallback_status_webhook_ignored_count
fallback_comment_webhook_ignored_count
fallback_repository_dispatch_webhook_ignored_count
fallback_conflict_health_recorded_count
fallback_explicit_workflow_skipped_count
fallback_required_workflow_skipped_count
fallback_retry_dead_lettered_count
fallback_base_push_reconciliation_count
fallback_scheduled_reconciliation_count
fallback_reusable_workflow_policy_blocked_count
fallback_status_duplicate_suppressed_count
fallback_pr_state_stale_before_post_count
fallback_pr_head_config_ignored_count
fallback_repository_identity_refreshed_count
fallback_checkout_policy_violation_count
fallback_sensitive_runtime_data_blocked_count
fallback_workflow_action_policy_blocked_count
fallback_action_ref_untrusted_count
fallback_write_token_policy_violation_count
fallback_posting_token_rejected_count
fallback_posting_token_unavailable_count
fallback_oidc_audience_rejected_count
fallback_oidc_claim_missing_count
fallback_oidc_job_workflow_sha_untrusted_count
fallback_reusable_workflow_sha_drift_count
fallback_base_sha_new_attempt_count
fallback_base_ref_new_attempt_count
fallback_preflight_order_violation_count
fallback_conflict_signal_inconclusive_count
fallback_marker_ownership_rejected_count
fallback_marker_parse_rejected_count
fallback_review_decision_blocked_count
fallback_merge_group_isolated_count
fallback_status_check_name_collision_count
fallback_concurrency_policy_violation_count
fallback_raw_app_token_scope_degraded_count
fallback_conflict_context_required_detected_count
fallback_head_sha_status_stale_ignored_count
fallback_model_output_schema_rejected_count
fallback_model_marker_collision_rejected_count
fallback_model_markdown_sanitized_count
fallback_config_snapshot_mismatch_count
fallback_config_snapshot_reused_count
fallback_posting_resume_count
fallback_posting_checkpoint_missing_count
fallback_pending_review_detected_count
fallback_inline_secondary_rate_limited_count
fallback_normal_review_recheck_needed_count
fallback_normal_review_recheck_enqueued_count
```

Safe error categories:

```text
mergeability_unknown
workflow_capability_missing
workflow_shape_untrusted
workflow_style_unsupported
required_workflow_not_supported
reusable_workflow_policy_blocked
dispatch_failed
dispatch_mode_invalid
dispatch_retry_dead_lettered
dispatch_payload_invalid
oidc_validation_failed
nonce_invalid
nonce_expired
nonce_reused
stale_head
stale_base
stale_pr_state
resolved_before_review
pr_head_config_untrusted
repository_identity_changed
fork_pr
draft_pr
rate_limited
provider_auth_missing
provider_runtime_failed
github_comment_position_invalid
status_post_failed
partial_diff_coverage
workflow_ref_not_allowed
interaction_workflow_not_allowed
actions_disabled
workflow_disabled
self_hosted_runner_unsupported
rerun_not_allowed
status_webhook_ignored
comment_webhook_ignored
repository_dispatch_webhook_ignored
conflict_context_not_normal_health
default_branch_sha_not_review_head
base_push_reconciliation_delayed
status_duplicate_suppressed
checkout_policy_violation
sensitive_runtime_data_blocked
workflow_action_policy_blocked
action_ref_untrusted
write_token_policy_violation
posting_token_rejected
posting_token_unavailable
oidc_audience_invalid
oidc_claim_missing
job_workflow_sha_untrusted
reusable_workflow_sha_drift
base_sha_changed_new_attempt
base_ref_changed_new_attempt
preflight_order_violation
conflict_signal_inconclusive
comment_marker_ownership_untrusted
comment_marker_parse_invalid
review_decision_not_allowed
merge_group_not_conflict_target
status_check_name_collision
concurrency_policy_violation
raw_app_token_scope_degraded
conflict_context_required_detected
head_sha_status_stale_ignored
model_output_schema_invalid
model_marker_namespace_collision
model_markdown_sanitized
config_snapshot_mismatch
config_snapshot_missing
posting_checkpoint_missing
pending_review_found
inline_secondary_rate_limited
normal_review_recheck_needed
normal_review_recheck_unavailable
```

Do not store:

- source code
- full diffs
- prompts
- provider model output
- provider secrets
- GitHub tokens or App tokens
- dispatch nonce values
- raw environment dumps
- GitHub Actions artifacts from conflict-mode runtime data

## UX Requirements

PR summary should make the mode clear:

```text
ReviewRouter conflict review

Reviewed the PR changes against the base branch.
The final resolved merge result should be reviewed again after conflicts are fixed.
```

Dashboard health state examples:

```text
Conflict fallback ready
Workflow update required for conflict fallback
Conflict fallback skipped for fork PR
Conflict fallback skipped for draft PR
Conflict fallback dispatched
Conflict fallback stale after new commit
Conflict fallback blocked by workflow action policy
Conflict fallback blocked by unsafe runtime output
Conflict fallback inconclusive because merge conflict signal is not confirmed
Conflict fallback skipped because summary marker ownership is untrusted
```

## Implementation Checklist

- [ ] Add feature flag for conflict fallback.
- [ ] Add reusable workflow template trigger for `repository_dispatch`.
- [ ] Add reusable workflow inputs for conflict mode.
- [ ] Generate workflow-level `permissions: {}` or stricter equivalent.
- [ ] Add explicit job-level permissions for the selected posting strategy.
- [ ] Add ReviewRouter OIDC posting capability mode for conflict
      comments/statuses/checks.
- [ ] Add posting token scope checks: repository id, PR number, head SHA,
      base ref, base SHA, context, APIs, TTL.
- [ ] Decide whether posting capability is a ReviewRouter proxy/session or raw
      GitHub App token fallback; do not treat raw App token as PR-scoped.
- [ ] Add server-side operation-scope enforcement for posting: exact PR, head
      SHA, base ref/SHA, status/check context, comment id, and bot identity.
- [ ] Add workflow concurrency policy that avoids untrusted payload fields,
      branch names, PR numbers, public marker ids, and dispatch ids.
- [ ] Add action-ref pinning policy support for generated workflow output.
- [ ] Add action-ref trust validation for external `uses:` steps.
- [ ] Keep explicit workflow conflict fallback disabled until pre-secret
      validation exists.
- [ ] Keep `reviewrouter-required.yml` unchanged for conflict fallback.
- [ ] Add workflow capability probe.
- [ ] Add workflow capability versioning.
- [ ] Add trusted workflow shape/hash validation.
- [ ] Add Actions/workflow disabled detection where GitHub API exposes it.
- [ ] Add DB table or durable unique record for fallback attempts.
- [ ] Include `base_ref` and `base_sha` in fallback uniqueness, comment markers,
      and inline finding fingerprints.
- [ ] Add base-ref data validation and prove base refs are not used in shell
      commands, cache keys, artifact names, concurrency groups, or refspecs.
- [ ] Store summary comment id and verify ReviewRouter App/bot author identity
      before updating old summaries.
- [ ] Add model-output validation boundary: strict schema, no control fields,
      bounded text, sanitized markdown, and runtime-owned marker footer.
- [ ] Add marker parser rule that accepts only the deterministic runtime footer
      and rejects extra ReviewRouter marker namespace strings.
- [ ] Add immutable review config snapshot id/hash for provider routing, model
      selection, prompt policy, output schema, blocking policy, and posting
      policy.
- [ ] Add config snapshot consistency checks between config exchange, model
      execution, finding validation, summary rendering, status/check conclusion,
      and posting-token exchange.
- [ ] Add posting manifest and checkpointed posting phases for summary, inline,
      review id, status/check, and completion.
- [ ] Add pending-review prevention: never omit GitHub review `event`; v1 uses
      issue comments, individual review comments, or submitted `COMMENT` review
      only.
- [ ] Add inline posting caps, secondary-rate-limit handling, and summary-only
      degradation for unposted findings.
- [ ] Add positive conflict-signal detection through GraphQL mergeability or
      equivalent fresh API data.
- [ ] Add PR mergeability retry/backoff.
- [ ] Add base-branch push reconciliation or scheduled reconciliation.
- [ ] Add normal-review recheck handling when base-push reconciliation resolves
      a conflict without a PR head update.
- [ ] Add safe normal-review rerun integration if available; otherwise add
      dashboard/summary remediation for `normal_review_recheck_needed`.
- [ ] Add dispatch nonce generation, hash storage, TTL, and replay protection.
- [ ] Add dispatch nonce masking and raw nonce redaction tests.
- [ ] Add `repository_dispatch` call.
- [ ] Route conflict detection and dispatch through outbox/idempotency.
- [ ] Add terminal-state-aware retry policy.
- [ ] Add separate conflict status/check context.
- [ ] Add conflict summary marker.
- [ ] Add status/check posting token path.
- [ ] Add runtime PR state validation.
- [ ] Add stale validation before posting.
- [ ] Add full pre-post PR state validation.
- [ ] Add trusted config-source enforcement for conflict mode.
- [ ] Add repository identity refresh and rename/transfer handling.
- [ ] Add broad write-permission rejection in workflow capability/runtime
      validation.
- [ ] Add conflict-mode checkout policy: exact head SHA, no credentials,
      submodules, LFS, dependency caches, hooks, package scripts, generators,
      tests, or builds.
- [ ] Add provider/model subprocess environment allowlist.
- [ ] Add no-artifact/no-cache policy for conflict-mode runtime data.
- [ ] Add OIDC `repository_dispatch` event allowlist.
- [ ] Make `repository_dispatch` OIDC validation conflict-specific, not generic.
- [ ] Add OIDC audience validation for runtime config and posting token
      exchanges.
- [ ] Add OIDC `workflow_sha`, `job_workflow_sha`, `runner_environment`, `jti`,
      `run_id`, and `run_attempt` validation where available.
- [ ] Enforce ReviewRouter OIDC preflight before checkout/cache/package/model
      work in conflict mode.
- [ ] Add fallback nonce validation.
- [ ] Add nonce rerun policy.
- [ ] Add runtime started callback through OIDC config exchange.
- [ ] Add strict dispatch payload schema and size/key-count validation.
- [ ] Add PR files/diff API path before local diff fallback.
- [ ] Add PR files pagination, limit, and missing patch handling.
- [ ] Add shell/payload injection tests.
- [ ] Add conflict-mode workflow-ref tests for review vs interaction workflows.
- [ ] Add status/check webhook loop prevention tests.
- [ ] Add conflict summary comment webhook loop prevention tests.
- [ ] Add repository_dispatch webhook loop prevention tests.
- [ ] Add conflict vs normal health separation tests.
- [ ] Add stable status context tests.
- [ ] Add status/check object type collision tests.
- [ ] Add advisory-status tests proving head-SHA status/check never replaces
      PR/base attempt validation.
- [ ] Add branch-protection/ruleset warning or best-effort detection for users
      who require the conflict context.
- [ ] Add merge_group isolation tests proving conflict fallback never posts to
      merge group SHAs or satisfies merge queue required checks.
- [ ] Add conflict-signal tests for `CONFLICTING`, `DIRTY`, `BLOCKED`, `BEHIND`,
      `UNSTABLE`, `UNKNOWN`, REST `mergeable=false` without detail, and timeout.
- [ ] Add marker ownership tests for spoofed user-authored comments.
- [ ] Add marker parser tests for encoded metadata and malicious raw branch/ref
      strings.
- [ ] Add model output schema tests proving model output cannot control status
      state, context, target URL, comment id, marker, token, nonce, retry, or
      review decision.
- [ ] Add model/PR markdown sanitization tests for ReviewRouter marker namespace,
      raw HTML, mentions, and oversized bodies.
- [ ] Add config snapshot mismatch tests proving posting fails closed when model
      execution and posting-token exchange disagree on snapshot id/hash.
- [ ] Add same-attempt retry tests proving the original config snapshot is
      reused, and new config snapshots require explicit new-attempt semantics.
- [ ] Add crash-recovery posting tests for summary-posted/status-missing,
      partial-inline-posted, status-already-posted, and missing checkpoint cases.
- [ ] Add pending-review tests proving v1 never creates `PENDING` reviews and
      never auto-submits an unknown draft.
- [ ] Add secondary-rate-limit tests proving inline posting stops and degrades
      remaining findings to summary-only.
- [ ] Add base-push-resolved-conflict tests proving no conflict success is
      synthesized and `normal_review_recheck_needed` or safe normal rerun is
      produced.
- [ ] Add conflict review decision tests proving no `APPROVE` or
      `REQUEST_CHANGES` review is submitted.
- [ ] Add write-token isolation tests for workflow-level and job-level
      permissions.
- [ ] Add posting-token minting and scope tests.
- [ ] Add default-branch SHA vs review-head SHA tests.
- [ ] Add repository_dispatch normal-config rejection tests.
- [ ] Add workflow_dispatch conflict-head rejection tests.
- [ ] Add base-push-created conflict detection tests.
- [ ] Add same-head/new-base-ref-or-base-SHA conflict attempt tests.
- [ ] Add same-head/same-base-SHA/different-base-ref retarget tests.
- [ ] Add duplicate terminal status suppression tests.
- [ ] Add reusable workflow policy blocked/no-run-observed tests.
- [ ] Add checkout hardening tests for submodules, LFS, caches, hooks, and exact
      head SHA.
- [ ] Add sensitive data redaction tests for tokens, nonce, prompts, diffs,
      OIDC request env vars, provider output, model output, artifacts, caches,
      and subprocess env.
- [ ] Add OIDC preflight-order tests proving checkout/cache/package/model work
      cannot run before config exchange.
- [ ] Add action pinning policy tests, including full-SHA-required org policy.
- [ ] Add summary-only degradation for inline failures.
- [ ] Add unit tests.
- [ ] Add integration tests.
- [ ] Add disposable conflict PR smoke test.
- [ ] Roll out behind feature flag.

## Source Constraints

These GitHub constraints drive the design:

- `pull_request` workflows do not run while a PR has merge conflicts. GitHub
  documents that `pull_request_target` does run in that case, but warns to
  understand the security risks before using it.
- GitHub documents the default `pull_request` activity as opened, reopened, or
  head-branch updated. A base-branch push that resolves a conflict may not
  create a new normal `pull_request` run for the same PR head SHA.
- `repository_dispatch` is intended for external activity that should trigger a
  workflow, and the receiving workflow must be configured for that event.
- The repository dispatch API can trigger a GitHub Actions workflow or a GitHub
  App webhook, so ReviewRouter must ignore self-generated dispatch webhooks as
  review triggers.
- `repository_dispatch` runs the workflow that exists on the repository default
  branch. Updating only the PR branch workflow is not enough.
- `repository_dispatch` sets the workflow SHA/ref to the default branch context,
  not to the PR head. Conflict mode must carry and validate the intended PR head
  SHA explicitly.
- Even for regular `pull_request`, GitHub documents that `GITHUB_SHA` is the
  merge-branch commit and recommends using the PR head SHA when the head commit
  is required. Conflict fallback must be even stricter because there is no merge
  commit.
- `repository_dispatch.client_payload` has a documented limit on top-level
  properties and total payload size, so the payload must stay small.
- The REST endpoint for creating `repository_dispatch` requires
  `Contents: write` for fine-grained tokens and GitHub App installation tokens.
- GitHub App installation access tokens can be limited by repositories and
  permission set, and otherwise inherit the installation's granted access. They
  do not provide native one-PR, one-SHA, one-status-context, or one-comment-id
  scoping, so ReviewRouter must enforce operation-level limits itself.
- GitHub `push` events can be filtered by branch in Actions. For SaaS webhook
  detection, adding `push` is an App event-subscription change, not a new
  repository permission.
- The PR files endpoint is paginated, returns 30 files per page by default, and
  documents a maximum of 3000 files. Review code must detect incomplete
  file/patch coverage.
- GitHub REST PR `mergeable` can be `true`, `false`, or `null`; `null` means
  GitHub is computing mergeability in the background and the request should be
  retried later.
- GitHub GraphQL `MergeableState.CONFLICTING` means the PR cannot be merged due
  to merge conflicts. GraphQL `MergeStateStatus.DIRTY` means the merge commit
  cannot be cleanly created. Prefer these positive signals for conflict fallback.
- GitHub GraphQL pull request review events include `APPROVE`, `COMMENT`, and
  `REQUEST_CHANGES`; conflict mode should use comment/advisory behavior, not an
  approval decision.
- GitHub pull request reviews created without an `event` are pending reviews.
  Conflict fallback v1 must not depend on pending review drafts.
- GitHub review comment endpoints can trigger notifications and secondary rate
  limiting. Inline posting must be bounded and able to degrade to summary-only.
- GitHub now recommends `line`/`side` coordinates for pull request review
  comments, with `start_line`/`start_side` for multi-line comments. The older
  `position` parameter is documented as closing down.
- GitHub merge queue checks use the `merge_group` event and a temporary
  merge-group SHA/branch. Conflict fallback must not post to that SHA because it
  reviews the PR head, not the merge queue group.
- The REST endpoint for creating `workflow_dispatch` requires `Actions: write`.
- Creating commit statuses requires commit status write permission. GitHub also
  documents a 1000-status per-SHA/context limit, so ReviewRouter must use one
  stable context and avoid status spam.
- GitHub commit status APIs create statuses for a given SHA/context and the
  combined status is also read for a ref/SHA. They are not scoped to one PR
  number, base branch, or base SHA.
- GitHub warns that ambiguous status check names can block merging, and if a
  check and a status have the same required name both can be required. Conflict
  fallback must avoid same-name dual emission.
- Workflow `GITHUB_TOKEN` permissions are explicit: when any permissions are
  specified, unspecified permissions are set to `none`. Add `statuses: write` or
  `checks: write` deliberately if workflow-token posting is chosen instead of
  the ReviewRouter OIDC posting capability.
- GitHub supports job-level `GITHUB_TOKEN` permissions. Use job-level scopes so
  write permissions do not accidentally apply to every job/action.
- GitHub OIDC tokens include claims such as `aud`, `iss`, `repository_id`,
  `workflow_ref`, `workflow_sha`, `job_workflow_ref`, `job_workflow_sha`,
  `run_id`, `run_attempt`, and `runner_environment`. Conflict runtime config
  must validate these instead of relying on path strings or nonce alone.
- GitHub requires `id-token: write` before a job can request an OIDC JWT; that
  permission does not grant repository write access, but it does make OIDC token
  minting possible inside the job. Keep it on the trusted runtime job only.
- GitHub documents that an action can access `github.token` even if the workflow
  does not explicitly pass `GITHUB_TOKEN`. Treat every `uses:` step as trusted
  code.
- GitHub Actions security guidance recommends pinning actions to full-length
  commit SHAs for immutable action references. Some organizations can enforce
  this policy, so the generated workflow must support policy-compatible action
  refs.
- Checks are richer but are an additional object lifecycle and webhook surface.
  Use them only when the status API is not enough.
- GitHub Actions security guidance treats PR-controlled data as untrusted input
  and recommends avoiding direct use of untrusted expressions in shell scripts.

Useful references:

- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch
- https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event
- https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
- https://docs.github.com/en/graphql/reference/enums#mergeablestate
- https://docs.github.com/en/graphql/reference/enums#mergestatestatus
- https://docs.github.com/en/graphql/reference/enums#pullrequestreviewevent
- https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
- https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/using-a-merge-queue
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks
- https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- https://docs.github.com/en/rest/commits/statuses#create-a-commit-status
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions
- https://docs.github.com/en/actions/reference/security/oidc
- https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
- https://docs.github.com/en/rest/checks
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

## Final Recommendation

Build the feature as a narrow conflict fallback:

```text
repository_dispatch + conflict-head mode + ReviewRouter OIDC posting capability + separate advisory status/check context
```

Do not use `pull_request_target`. Do not make conflict review satisfy the normal
required ReviewRouter check. Do not execute PR code. Do not trust dispatch
payload. Do not dispatch without idempotency. Do not run provider-backed review
without a valid SaaS fallback record and nonce. Do not make write-capable
`GITHUB_TOKEN` scopes globally available to the conflict review workflow.

This gives ReviewRouter CodeRabbit-like usefulness on conflicted PRs while
keeping the product's stronger trust boundary.
