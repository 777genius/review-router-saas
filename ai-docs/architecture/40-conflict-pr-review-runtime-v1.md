# Conflict PR Review Runtime v1 Implementation Plan

This plan covers the missing runtime layer required before
`REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK` can be enabled in production.
It builds on the control-plane, webhook, outbox, database, OIDC, and workflow
capability work from the conflict fallback implementation.

The goal is not to make conflict review look like normal merge-result review.
The goal is to safely review the PR head when GitHub cannot produce a merge
commit because the PR has conflicts, then post clearly advisory output without
weakening the normal required review path.

## Scope And Non-goals

In scope:

- Add a `conflict-head` runtime execution mode.
- Prove the runtime was started by the expected `repository_dispatch` attempt.
- Checkout and review the exact expected PR head SHA.
- Build a bounded diff against the expected base semantics.
- Isolate provider/model execution from GitHub/OIDC/posting secrets.
- Validate the PR state immediately before every GitHub write phase.
- Post advisory, clearly labeled conflict-review output.
- Make retries and partial posting idempotent.
- Keep the feature behind a flag until runtime and E2E safety gates pass.

Out of scope for v1:

- Reviewing a synthetic merge result when GitHub cannot create one.
- Enabling conflict fallback for explicit user-authored workflows.
- Enabling conflict fallback for unsupported fork trust modes.
- Self-hosted runner support.
- Treating conflict review as a required merge gate.
- Reusing the normal required ReviewRouter status/check context.
- Returning a broad GitHub App token to the runtime before model execution.
- Letting model output decide posting destinations, status contexts, retry
  behavior, approval, or request-changes behavior.

Risk posture:

- Prefer a skipped/degraded conflict review over any behavior that can post to
  the wrong PR, wrong SHA, wrong repository, wrong status context, or wrong
  comment.
- Prefer no inline comments over comments with uncertain coordinates.
- Prefer no status/check over a status/check that can be confused with normal
  required review.
- Prefer failing closed for older workflow/runtime versions over compatibility
  that widens trust.
- Prefer adding a narrow type/port over adding a boolean branch inside shared
  normal-review code.

## Definition Of Done

The feature is not done when the workflow starts. It is done only when all of
these are true:

- Runtime can complete a simple conflicted PR review in a disposable GitHub repo.
- Runtime exits stale without comments when head, base, PR state, repository
  selection, or workflow capability changes during the run.
- Runtime can crash after summary, after some inline comments, and after final
  status without duplicating comments on retry.
- Runtime cannot obtain normal config, normal comment token, or normal required
  status/check behavior from `repository_dispatch`.
- Runtime cannot leak raw nonce, OIDC token, GitHub token, posting token, full
  diff, or full prompt through logs, health, comments, or database safe summaries.
- Runtime cannot execute provider/model subprocesses with posting or OIDC
  credentials in the environment.
- Local checks and disposable GitHub E2E smoke both pass.
- Production rollout has a tested rollback path and alert thresholds.
- No new GitHub App permission is required unless the implementation chooses
  check runs instead of commit statuses and documents why.

## Current Completion Estimate

With the current branch implementation:

| Area                                                | Completion |
| --------------------------------------------------- | ---------: |
| Conflict detection, attempt lifecycle, dispatch     |     85-90% |
| Workflow rendering and capability validation        |     91-95% |
| OIDC/config control-plane guardrails                |     92-95% |
| Runtime `conflict-head` execution                   |     91-94% |
| Posting proxy/session and pre-post enforcement      |     89-93% |
| Advisory summary/status/check side effects          |     87-91% |
| End-to-end GitHub Actions validation                |         0% |
| Code path excluding external GitHub E2E             |     96-98% |
| Production readiness including E2E/release evidence |     89-91% |

This estimate is intentionally conservative. The already built layer is large
and valuable, but production safety depends on the runtime and posting layers,
which are the highest-risk parts.

Important status note:

- Server-side posting session/proxy, idempotent summary/status writes, marker
  ownership checks, read-before-write retry safety, repo-scoped rollout, and
  fresh pre-post validation before posting-session issuance are implemented.
- Runtime-domain helpers for exact checkout plans, bounded deterministic diff
  packets, provider environment isolation, and model-output schema validation
  are implemented.
- Runtime library contracts are implemented for the conflict sequence:
  pre-checkout validation, exact-head checkout port, bounded diff port,
  sanitized provider runner port, deterministic posting manifest, pre-post
  validation, summary posting, pre-status validation, and advisory status
  posting.
- Runtime HTTP clients are implemented for action control-plane OIDC/config
  exchange and conflict posting session/summary/status endpoints. They use fixed
  endpoints and do not accept model-controlled target SHA, context, URL, comment
  id, or arbitrary GitHub API methods.
- Runtime HTTP clients reject untrusted `api_url` shapes before sending OIDC or
  session tokens, use `redirect: "error"` on token-bearing requests, and require
  the GitHub Actions OIDC request URL to be HTTPS.
- Runtime action-control-plane clients also reject unsafe fixed endpoint path
  shapes before token-bearing calls: empty or whitespace-mutated paths,
  non-absolute paths, protocol-relative paths, backslashes, query strings,
  fragments, traversal, encoded traversal, encoded slashes, encoded backslashes,
  control characters, and same-origin mismatches.
- Workflow provisioning uses the same trusted `api_url` boundary: HTTPS in
  production, loopback HTTP for local development only, and no userinfo, path,
  query, or fragment.
- The conflict-specific reusable workflow runtime is implemented separately from
  the normal review reusable workflow at
  `.github/workflows/reviewrouter-conflict-reusable.yml`. This avoids changing
  normal PR review behavior while adding the conflict runtime.
- The conflict workflow and generated conflict caller pass only Codex/OpenAI
  provider secrets into the conflict runtime. Ledger, Claude, and OpenRouter
  secrets are not passed to the conflict job.
- Local workflow contract tests verify the conflict runtime preflight happens
  before target PR checkout, target checkout uses the exact conflict head SHA,
  checkout credentials are not persisted, job permissions stay read/OIDC-only,
  and untrusted inputs are not interpolated inside shell script bodies.
- The conflict reusable workflow validates `runtime_ref` before checking out
  ReviewRouter runtime code. The control plane also rejects conflict runtime
  config requests that omit the runtime version header or use mutable refs such
  as `main`.
- The generated workflow and runtime/control-plane payload contract bind the
  `repository_dispatch` action type to `reviewrouter_conflict_review`, so a
  generic or wrong dispatch action cannot obtain conflict runtime config.
- Versioned HTTP contract tests verify unsupported conflict providers, mutable
  runtime refs, unknown conflict dispatch fields, and alias conflicts return
  stable safe errors without leaking provider/model details.
- The runtime CLI masks the raw dispatch nonce before OIDC/config exchange and
  rejects secret-looking failure codes before printing terminal-safe errors.
- The runtime CLI performs OIDC/config preflight before PR checkout, stores the
  scoped action session file under runner temp, verifies exact detached checkout
  without persisted credentials, builds a real Git diff against the expected
  base/head SHAs, runs the Codex provider through a bounded schema/timeout
  adapter, requests a posting session, and calls the fixed posting endpoints.
- Runtime path handling rejects traversal, control/bidi characters, NFC and
  case-display collisions, symlink modes, and submodule/gitlink modes; rendered
  finding paths are markdown-escaped before they can appear in advisory output.
- Runtime Git diff commands use literal pathspec mode and revalidate every
  `--name-status` path before per-file diff construction, so pathspec-like file
  names are preserved as data and unsafe paths cannot reach the per-file binary
  diff command.
- The provider subprocess uses a disposable `CODEX_HOME`, `HOME`,
  `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`, removes temp model/config/output
  files after completion/failure, does not inherit ambient GitHub env when an
  explicit env is supplied, and escalates timed-out commands from `SIGTERM` to
  `SIGKILL`.
- Runtime health failure reporting redacts secret-like provider error messages
  to stable safe reason codes.
- Nonce-like strings are now treated as secret-like across shared safe-payload
  checks, runtime safe error codes, CLI terminal errors, and control-plane
  ambiguous-write summaries.
- Conflict posting endpoints have explicit request body limits. Server-side
  summary/status writes repeat pre-post PR-state validation through the narrow
  GitHub adapter before write attempts, and ambiguous-write safe summaries redact
  secret-like values before persistence.
- Conflict posting HTTP routes now have an integration test that exchanges a
  conflict action session, obtains a scoped posting session, posts summary and
  advisory status through the proxy, proves duplicate summary replay is
  idempotent, and proves the generic comment-token route remains unavailable for
  conflict-head sessions.
- The v1 provider adapter supports one Codex-backed provider. Any non-Codex
  provider or multi-provider/consensus topology in the conflict runtime config
  fails closed during control-plane runtime config exchange, before
  checkout/provider execution. Normal non-conflict review remains unchanged.
- Production enablement remains blocked until the disposable GitHub Actions E2E
  smoke passes against a real conflicted PR and a reviewed release/SHA evidence
  pack is attached for the runtime ref.

## Traceability To Plan 39

This document is the runtime execution continuation of
`39-conflict-pr-review-fallback.md`. It should not replace plan 39. It should
make the remaining runtime/posting work explicit enough to implement without
accidentally widening trust boundaries.

| Plan 39 area                                 | Current implementation status                          | Covered here                                                 |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `repository_dispatch` controlled entry point | implemented in generated workflow/control plane        | runtime validates event/action/version before checkout       |
| durable fallback attempts                    | implemented for detection/dispatch/posting intents     | extended with posting checkpoints and state transitions      |
| OIDC conflict-specific config exchange       | implemented in runtime preflight and control plane     | runtime preflight, config/posting purpose separation         |
| conflict-head checkout policy                | implemented by conflict reusable workflow and verifier | exact SHA checkout, no credentials, no mutable refs          |
| diff building                                | implemented by Git CLI source and bounded manifest     | bounded diff, deterministic manifest, stale base/head checks |
| model process isolation                      | implemented for single Codex-backed v1 provider mode   | env allowlist, unsupported/topology gate, output schema      |
| posting token/proxy                          | implemented through scoped posting session/proxy       | scoped posting session/proxy contract                        |
| pre-post validation                          | implemented in runtime and repeated server-side        | validation before summary and before status/check            |
| advisory status/comment                      | implemented through proxy/GitHub adapter               | summary/status wording, context, markers, checkpointing      |
| duplicate prevention after partial writes    | implemented server-side with intent/checkpoint flow    | server-side checkpoints and read-before-write retry          |
| E2E GitHub validation                        | not implemented                                        | disposable repository smoke matrix                           |

Implementation rule:

- A future PR must link each completed item back to this traceability table.
- If an item is intentionally deferred, it must stay behind a fail-closed path.
- Do not mark the feature production-enableable while E2E validation, runtime
  release pinning, or provider-mode gating remains incomplete.

## Decision Log

These decisions are locked for v1 unless a future design review updates this
document and adds tests for the changed behavior.

| Decision                 | Chosen v1 behavior                           | Why                                                      |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------- |
| Review target            | PR head against expected base semantics      | GitHub cannot produce a merge result for conflicted PRs  |
| Output semantics         | advisory only                                | avoids false branch-protection confidence                |
| Dispatch mechanism       | controlled `repository_dispatch`             | works when normal PR workflow cannot review merge result |
| Runtime auth             | OIDC preflight before checkout               | prevents raw payload from authorizing runtime config     |
| Posting auth             | ReviewRouter posting proxy/session           | scopes writes below broad repository token behavior      |
| Summary update authority | stored comment id or verified app/bot marker | prevents user marker spoofing                            |
| Status/check target      | expected head SHA                            | visible on PR without pretending merge result exists     |
| Status/check context     | `ReviewRouter conflict review`               | avoids normal required context collision                 |
| Fork PRs                 | skipped in v1                                | avoids changing fork trust model                         |
| Explicit workflows       | unsupported in v1                            | cannot prove pre-secret validation order                 |
| Self-hosted runners      | unsupported in v1                            | runner trust model is different                          |
| Dry-run                  | same validators, no GitHub writes            | validates runtime safely before posting rollout          |

Decision review triggers:

- Need to support forks.
- Need to support explicit workflows.
- Need to make conflict status required.
- Need to use raw GitHub App tokens in runtime.
- Need to post check runs instead of commit statuses.
- Need to store full prompts/diffs/model output.

Any of these requires a separate architecture update, not just code changes.

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
- Repo-scoped conflict fallback rollout allowlist in addition to the global
  feature flag.
- Conflict runtime config advertises posting proxy only when the server-side
  posting stack is available.
- Server-side conflict posting sessions with a separate JWT purpose/audience.
- Fresh GitHub PR state validation before posting-session issuance and repeated
  validation inside each GitHub write.
- Advisory summary comment posting through a narrow GitHub adapter with App-bot
  marker ownership checks.
- Advisory status posting to the expected head SHA with fixed context
  `ReviewRouter conflict review`.
- Posting intents with reserve/commit/ambiguous states for retry-safe partial
  writes.
- Runtime-domain helpers for exact checkout plans, bounded deterministic diffs,
  provider environment allowlist, unsafe path rejection, and model output
  validation.
- Runtime orchestrator and HTTP clients for OIDC/config exchange, conflict
  posting-session, advisory summary, and advisory status calls.
- Conflict reusable workflow separated from normal reusable workflow, with
  preflight before PR checkout and exact head checkout using
  `persist-credentials: false`.
- Generated interaction workflows suppress ReviewRouter-authored conflict
  summary comments by requiring both the hidden conflict marker and a bot actor
  before suppression. A user who copies the marker text into a comment does not
  suppress normal `/rr` interaction handling.
- Runtime CLI for GitHub Actions that writes scoped session data outside the
  checkout, re-fetches config for stale validation, verifies detached head/no
  persisted credentials, builds Git diff packets, runs the provider, and posts
  through the proxy.
- Codex provider subprocess adapter with read-only sandbox flags, schema output,
  timeout, temp `CODEX_HOME`, and no runtime/posting/GitHub token environment.
- Local simulation tests proving phase order, stale-before-checkout stop,
  dry-run without posting, provider secret isolation, and fixed posting/config
  endpoint usage.

Missing before enabling the feature:

- End-to-end GitHub Actions smoke test against a disposable repository.
- Published runtime release or immutable SHA evidence for the new conflict
  reusable workflow ref.
- Provider-specific conflict adapters and multi-provider orchestration if
  product wants conflict fallback to run for Claude/OpenRouter or consensus
  configs. Until then the control-plane gate must remain fail-closed for
  unsupported conflict modes.

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

Runtime enablement must be two-key:

- Global environment flag enables the code path.
- Repository/workspace capability or rollout policy allows the specific repo.

This avoids an all-repositories blast radius if a production flag is set
incorrectly. If the existing product configuration does not yet support
repo-scoped rollout, add it before enabling outside disposable/internal repos.

Kill switch requirements:

- Turning off the flag must stop new conflict attempts and new dispatches.
- Existing started runs must fail closed at config/posting exchange if the flag
  is now disabled.
- Started runs must not keep a cached posting capability after disablement.
- Dead-lettered attempts must not replay automatically after disablement.
- Rollback must not require deleting workflow files from user repositories.

## Feature Flag Matrix

The feature must have explicit behavior for every flag/rollout combination.
Avoid "flag on means everything runs" logic.

| Global flag | Repo/workspace rollout | Workflow capability | Runtime support | Expected behavior                                                       |
| ----------- | ---------------------- | ------------------- | --------------- | ----------------------------------------------------------------------- |
| off         | off                    | any                 | any             | no attempts, no dispatch, no posting                                    |
| off         | on                     | any                 | any             | no attempts, no dispatch, no posting                                    |
| on          | off                    | any                 | any             | no attempts for that repo/workspace                                     |
| on          | on                     | missing             | any             | record skip/degraded readiness, no dispatch                             |
| on          | on                     | present             | old runtime     | dispatch may start only in test rollout, config rejects before checkout |
| on          | on                     | present             | parser only     | dry-run/preflight only, no posting                                      |
| on          | on                     | present             | full runtime    | eligible only after acceptance gates pass                               |

Flag checks must happen at:

- webhook conflict detection
- base-push reconciliation
- outbox dispatch
- OIDC/config exchange
- posting-session exchange
- pre-status validation

If checks disagree because config changed mid-run, choose the safest current
server-side value. A disabled flag always wins.

## Rollout Configuration Consistency

Feature flags and repo/workspace rollout are safety controls, not just product
configuration. They must be read in a way that makes emergency disablement
effective even when caches, workers, and runtime sessions are stale.

Rules:

- Global disable always overrides repo/workspace allowlists.
- Config reads used for GitHub writes must be fresh enough for incident
  response. If there is a cache, posting exchange must bypass it or use a very
  short, documented TTL.
- Runtime config may include current rollout state for diagnostics, but runtime
  must not treat it as authority during posting. Server-side posting exchange
  re-reads policy.
- Rollout changes must be audit logged with actor, scope, old value, new value,
  timestamp, and reason when available.
- Outbox workers must re-read rollout state before sending dispatch, not only
  when the attempt was recorded.
- Started runs must fail closed at posting exchange after rollout disablement
  even if they already received runtime config.
- Manual replay must re-check rollout state. Operators cannot replay a paused
  repo unless a dedicated audited override exists.
- Repo transfer, installation change, or repository unselection invalidates the
  repo rollout decision until a fresh eligibility check passes.

Cache policy:

| Decision point        | Cache allowed?            | Requirement                                 |
| --------------------- | ------------------------- | ------------------------------------------- |
| conflict detection    | yes, bounded              | disabled flag still wins on next event      |
| outbox dispatch       | only short-lived          | re-read before `repository_dispatch`        |
| OIDC/runtime config   | no stale allow            | re-read flag, rollout, entitlement          |
| posting session       | no stale allow            | authoritative fresh server-side check       |
| final advisory status | no stale allow            | pre-status validation checks current policy |
| dashboard/readiness   | yes, display as readiness | cannot imply production posting is enabled  |

Tests:

- Disable global flag after model output and before posting session; no GitHub
  write occurs.
- Disable repo rollout after posting session request starts; session is denied
  or fails closed before write.
- Worker cache contains old allow decision; outbox dispatch still re-checks and
  skips.
- Manual replay of paused repo is rejected without audited override.
- Repository unselected after dispatch denies config and posting exchanges.

## Architecture Boundary

Keep the existing ownership boundaries:

| Area                              | Owner                                             | Must not own                                           |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Conflict attempt lifecycle        | `packages/features/conflict-review`               | OIDC token parsing, runtime config mapping             |
| Async execution                   | existing outbox worker                            | GitHub PR semantics or posting policy                  |
| Workflow rendering and capability | `packages/features/workflow-provisioning`         | attempt records, mergeability polling                  |
| OIDC session and runtime config   | `packages/features/action-control-plane`          | attempt lifecycle, GitHub PR diff building             |
| Runtime execution                 | ReviewRouter reusable workflow runtime            | durable attempt ownership, server-side posting policy  |
| Posting operation enforcement     | control plane posting proxy or posting capability | model output interpretation                            |
| GitHub posting client             | infrastructure adapter behind a narrow port       | deciding whether a run is current or advisory/required |

Important boundary rule:

`action-control-plane` may validate identity, issue runtime config, and issue
posting capabilities, but it must not own conflict attempt lifecycle. The
conflict feature owns attempts and decides whether a run is current.

Dependency direction:

```text
runtime client
-> action-control-plane HTTP API
-> conflict-review verifier port
-> conflict-review attempt repository
-> GitHub gateway ports
```

Do not introduce a direct import from `action-control-plane` domain into
`conflict-review` domain. If shared validation is needed, place it in
`packages/shared` with stable, narrow functions.

SOLID guardrails:

- Single responsibility: runtime mode parsing, OIDC exchange, diff building,
  model execution, and posting are separate modules with separate tests.
- Open/closed: add `conflict-head` as a mode behind explicit interfaces rather
  than adding `if repository_dispatch` branches throughout normal review code.
- Interface segregation: posting code receives a `ConflictPostingSession`, not a
  generic GitHub token.
- Dependency inversion: runtime depends on ports for GitHub state, diff source,
  provider execution, and posting, so tests can simulate stale and crash states.

## Ownership And Review Gates

Each implementation PR should have an explicit owner for the risk it changes.
The same person should not be the only reviewer for the code and the security
boundary.

| Area                   | Primary owner                               | Required reviewer focus                          |
| ---------------------- | ------------------------------------------- | ------------------------------------------------ |
| conflict attempt state | conflict-review feature owner               | idempotency, state transitions, stale handling   |
| outbox dispatch        | worker/outbox owner                         | retry, poison jobs, duplicate dispatch           |
| workflow generation    | workflow-provisioning owner                 | permissions, triggers, capability hash           |
| OIDC/config exchange   | action-control-plane owner                  | claims, nonce, session purpose                   |
| runtime checkout/diff  | runtime owner                               | exact SHA, no credentials, bounded diff          |
| provider/model runner  | provider/runtime owner                      | env isolation, schema, timeouts                  |
| posting proxy/session  | action-control-plane + GitHub adapter owner | scope, idempotency, GitHub writes                |
| summary/status UX      | product/support owner                       | advisory wording, no required-review implication |
| rollout/ops            | operations owner                            | flags, metrics, rollback, runbooks               |

Review gates:

- Any PR that touches posting needs a security/trust-boundary review.
- Any PR that touches workflow permissions needs workflow capability review.
- Any PR that touches schema/version fields needs compatibility review.
- Any PR that touches summary/status wording needs UX/support review.
- Any PR that touches retry/dead-letter behavior needs outbox review.

## Normal Review Isolation

Conflict fallback must be added beside normal review, not inside the normal
review path in a way that changes existing behavior.

Hard isolation rules:

- Normal `pull_request` and `merge_group` review must not depend on conflict
  attempt records.
- Normal review must not read conflict posting checkpoints.
- Conflict review must not post normal required status/check context.
- Conflict review must not submit `APPROVE` or `REQUEST_CHANGES`.
- Conflict review must not satisfy branch protection that expects normal
  ReviewRouter review.
- Interaction/comment workflows must not treat conflict summaries as normal
  review comments.
- `repository_dispatch` webhooks must not enqueue normal review work.
- Status/check webhooks for conflict context must not enqueue review work.
- Conflict health must not make repository health say normal review is healthy.

Normal review regression tests:

- A standard PR without conflicts still runs normal review with the same config.
- `merge_group` still uses normal review semantics.
- Manual `workflow_dispatch` cannot set conflict inputs.
- Existing setup/readiness behavior does not require conflict workflow markers
  when the feature flag is off.
- Normal review comment-token flow still works for normal sessions.
- Conflict session cannot call normal `/comment-token`.

Regression matrix:

| Existing path                | Must remain true                                      | Regression test idea                                  |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `pull_request` review        | reviews merge result when GitHub can produce it       | normal PR fixture still requests normal config        |
| `merge_group` review         | uses existing merge-group semantics                   | merge-group event cannot select conflict mode         |
| normal comment token         | works only for normal review scopes                   | normal token still valid for normal path              |
| normal required status/check | context and target SHA unchanged                      | conflict context constant never equals normal context |
| explicit workflow users      | remain unsupported for conflict fallback v1           | explicit workflow cannot obtain conflict config       |
| setup/provisioning workflow  | required workflow is not changed into dispatch review | generated YAML keeps jobs/events separate             |
| comment/status webhooks      | normal triggers ignore conflict-authored artifacts    | conflict summary/status does not enqueue review       |
| dashboard/readiness          | flag off looks like current production behavior       | no conflict-ready claim when runtime missing          |
| outbox worker                | normal jobs are not starved by conflict retries       | conflict poison job does not block normal queue       |

Regression rules:

- Do not share a helper if it requires normal review to understand
  `conflict-head` fields.
- Do not make normal review parse conflict dispatch payloads for convenience.
- Do not make the normal status/check policy depend on conflict advisory
  outcomes.
- Do not let conflict health reasons appear as normal review failures unless
  they are explicitly mapped for user-facing copy.
- If a shared type gains conflict-only fields, normal constructors/builders must
  keep those fields absent or impossible to read without mode checks.

The implementation should prefer type-level separation:

```text
ReviewKind = "normal" | "conflict-head"
NormalReviewSession
ConflictReviewSession
NormalPostingCapability
ConflictPostingSession
```

Do not model `conflict-head` as a boolean on a broad mutable session object. A
boolean makes it too easy to accidentally pass a conflict session into normal
posting code.

## Conflict Resolution And Normal Re-review Handoff

Conflict fallback is not the end of the review lifecycle. When conflicts are
resolved, normal merge-result review should run or be clearly requested.

Expected handoff:

```text
conflict detected
-> advisory conflict-head review may run
-> user resolves conflicts with a new PR head commit or base changes remove conflict
-> conflict attempts for old head/base become stale
-> normal review path reviews merge result when GitHub can produce it
```

Rules:

- Conflict summary must not suppress normal review after conflicts resolve.
- Conflict status/check must not be interpreted as the latest review after a new
  head commit.
- Base-push reconciliation that observes conflict resolution should either
  trigger the existing normal recheck path or record a safe remediation reason.
- If normal recheck cannot be triggered automatically, the summary/status should
  point to safe remediation copy, not silently stop.
- Conflict attempts must never mark normal review as completed.

Tests:

- Conflict summary on old head does not block normal review on new head.
- Base push resolves conflict and stale conflict attempt does not post.
- Normal review recheck is triggered or a clear remediation reason is recorded.
- Required ReviewRouter context remains owned by normal review only.

## Threat Model And Trust Boundaries

Assume every boundary below can be attacked or become stale:

| Boundary                             | Trust level                                | Main risk                                         | Required control                                            |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------- |
| GitHub webhook payload               | signed but still event data, not authority | stale or misleading PR/base/head fields           | refetch by installation/repository id before decisions      |
| `repository_dispatch.client_payload` | untrusted                                  | forged dispatch id, nonce, head/base metadata     | validate against stored attempt and OIDC run identity       |
| GitHub Actions workflow inputs       | untrusted runtime input                    | shell injection, wrong mode, old runtime          | strict parser, shared validators, version gate              |
| GitHub Actions OIDC token            | trusted only after verification            | generic `repository_dispatch` opens normal config | conflict-specific claims, audience, workflow refs           |
| Runtime workspace                    | untrusted after checkout                   | repository code reads secrets or changes files    | no credentials, provider env allowlist, no preflight bypass |
| Model/provider output                | untrusted content                          | prompt injection controls posting                 | strict schema, no control fields, runtime-owned policy      |
| Posting session                      | high privilege, narrow scope               | wrong PR/status/comment write                     | scoped session/proxy, TTL, operation allowlist              |
| GitHub write response                | external side effect                       | ambiguous retry duplicates writes                 | checkpoint before/after, read-before-write retry            |

Threat classes:

- Spoofing: manual `repository_dispatch` or copied marker tries to impersonate a
  valid attempt.
- Tampering: workflow file changes after dispatch or model output injects
  control fields.
- Repudiation: no durable checkpoint makes it impossible to know whether a
  comment was posted.
- Information disclosure: logs/health/comments leak nonce, token, full diff, or
  prompt.
- Denial of service: duplicate webhooks or secondary rate limits create retry
  storms.
- Elevation of privilege: conflict mode obtains normal review token or broad App
  token.

Mandatory controls by threat:

| Threat                 | Control                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| spoofed dispatch       | nonce-bound attempt plus OIDC repository/workflow/run identity         |
| stale run              | head/base/PR validation before checkout, before posting, before status |
| marker spoofing        | stored comment id or app/bot author identity plus canonical marker     |
| broad posting          | conflict posting proxy/session, no generic `/comment-token`            |
| model prompt injection | schema validation and runtime-owned posting policy                     |
| duplicate write        | idempotency keys, checkpoints, read-before-write retry                 |
| secret leak            | mask before logs, env allowlist, bounded safe health                   |
| cross-tenant write     | workspace/repository/installation id validation on every exchange      |

## Tenant And Authorization Boundary

Every conflict action must prove it belongs to the same tenant and repository at
each server round trip. Do not rely on values that came from the runtime after
checkout.

Required identity tuple:

```text
workspaceId
repositoryId
githubRepositoryId
githubInstallationId
pullRequestNumber
headSha
baseRef
baseSha
dispatchId
configSnapshotId
runId
runAttempt
```

Validation rules:

- Runtime session token must include immutable repository and workspace ids.
- Posting session must be derived from the runtime session, not from raw request
  body ids.
- GitHub App installation id must match the repository record and OIDC
  repository id.
- Repository full name is only a mutable API coordinate and must never be the
  sole trust key.
- Workspace entitlement or repository selection must be checked at config and
  posting exchange.
- If a repository moves to another workspace/account during a run, posting fails
  closed until a fresh attempt is recorded.
- A dispatch id must not be globally guessable enough to authorize anything by
  itself. It is an identifier, not a secret.

Tests:

- Attempt from workspace A cannot be used with runtime session for workspace B.
- Repository id mismatch fails even if full name matches.
- Installation id mismatch fails even if repository id matches.
- Repository full name rename does not break safe API lookup if immutable ids
  match.
- Repository transfer or unselection during run stops posting.

## Source Of Truth Map

Every implementation review should ask "which system is authoritative for this
field?" If the answer is "the runtime sent it", the design is probably unsafe.

| Decision or value      | Source of truth                        | Runtime may provide?               | Notes                               |
| ---------------------- | -------------------------------------- | ---------------------------------- | ----------------------------------- |
| workspace id           | ReviewRouter repository record         | No                                 | derived from selected repository    |
| repository id          | ReviewRouter repository record         | No                                 | internal immutable id               |
| GitHub repository id   | GitHub + stored repository record      | Only as OIDC claim                 | request body value is not authority |
| GitHub installation id | stored installation/repository record  | No                                 | must match selected repository      |
| repository full name   | GitHub API fresh lookup                | As hint only                       | mutable API coordinate              |
| PR number              | stored attempt                         | Only if it matches attempt/session | not enough to authorize             |
| head SHA               | stored attempt + fresh GitHub PR       | Only for cross-check               | never from `github.sha`             |
| base ref               | stored attempt + fresh GitHub PR       | Only for cross-check               | validated branch ref                |
| base SHA semantics     | stored attempt + fresh GitHub/API data | No                                 | stale if incompatible               |
| dispatch id            | stored attempt                         | Yes                                | identifier only, not secret         |
| nonce                  | runtime input, hash in attempt         | Yes                                | must match hash and run binding     |
| config snapshot        | server-side config snapshot            | No                                 | runtime cannot choose config        |
| workflow capability    | server analyzer                        | No                                 | runtime cannot self-certify shape   |
| run id/run attempt     | OIDC claims                            | No request-body authority          | bound at start                      |
| model findings         | model output after validation          | Yes                                | content only, no control fields     |
| status/check context   | runtime/server constant                | No                                 | never model/user-controlled         |
| target URL             | runtime/server policy                  | No model control                   | safe run or ReviewRouter URL        |
| summary comment id     | posting checkpoint/GitHub              | No model control                   | author/marker validated             |
| terminal state         | conflict attempt state machine         | No                                 | compare-and-set transition          |

Rules:

- Runtime request bodies are proposals or observations, never authority for
  privileged decisions.
- If two sources disagree, choose the more authoritative server/GitHub source or
  fail closed.
- Do not add a new field to runtime inputs without adding it to this table.

## Runtime Module Decomposition

Implement the runtime in small units. Avoid a single large script that parses
inputs, checks out, runs the model, and posts comments.

Recommended modules:

| Module                           | Responsibility                              | Inputs                           | Outputs                                     |
| -------------------------------- | ------------------------------------------- | -------------------------------- | ------------------------------------------- |
| `ConflictRuntimeInputParser`     | Parse and validate action inputs/env        | workflow inputs/env              | validated conflict runtime request          |
| `ConflictRuntimePreflight`       | OIDC request and config exchange            | validated request                | runtime session and non-posting config      |
| `ConflictPrStateValidator`       | Fresh PR state validation                   | session, expected head/base      | current PR state or stale/degraded reason   |
| `ConflictCheckoutPlanner`        | Produce exact checkout plan                 | expected head SHA                | immutable checkout command/step data        |
| `ConflictDiffBuilder`            | Build bounded diff and file metadata        | current PR state, checkout       | bounded diff packet and truncation metadata |
| `ConflictProviderRunner`         | Run model/provider in sanitized environment | diff packet, review config       | untrusted raw model output                  |
| `ConflictFindingValidator`       | Validate and bound model output             | raw model output                 | safe findings and summary draft             |
| `ConflictPostingManifestBuilder` | Build deterministic posting manifest        | safe findings, PR state, session | posting manifest and hash                   |
| `ConflictPostingClient`          | Call server-side posting proxy/session      | posting session, manifest        | posting checkpoints                         |
| `ConflictHealthReporter`         | Report safe telemetry                       | phase, reason, counts, hashes    | health event                                |

Every module should be testable without a real GitHub repository except the
final E2E smoke path.

## Chosen Runtime Strategy

Recommended v1 strategy:

Use a server-side posting proxy or one-shot ReviewRouter posting session. The
runtime should never receive a broad GitHub App installation token before model
execution. If a raw App token fallback is ever added, it must be marked as a
degraded mode and remain disabled by default.

Scores:

| Strategy                         | 🎯 Confidence | 🛡️ Reliability | 🧠 Complexity | Estimated change |
| -------------------------------- | ------------: | -------------: | ------------: | ---------------: |
| Posting proxy/session            |          9/10 |           9/10 |          8/10 |     900-1600 LOC |
| Raw App token late-mint fallback |          6/10 |           6/10 |          6/10 |      500-900 LOC |
| Use normal comment token         |          2/10 |           2/10 |          3/10 |      100-250 LOC |

Reject the normal comment-token approach. It is easier, but it breaks the core
security model because the token is not scoped to one conflict attempt and one
posting contract.

Decision:

Use `Posting proxy/session` for v1. Do not implement raw App token fallback in
the same PR unless the proxy/session path is proven impossible. Mixing both
paths early doubles the security review surface.

## Protocol Versioning And Compatibility

Conflict runtime must use explicit protocol versions. Do not infer support only
from whether an input exists.

Recommended version fields:

| Field                       | Owner                   | Purpose                                              |
| --------------------------- | ----------------------- | ---------------------------------------------------- |
| `fallbackVersion`           | conflict-review attempt | semantic version of conflict fallback attempt format |
| `runtimeProtocolVersion`    | reusable runtime        | HTTP/config/posting protocol version                 |
| `workflowCapabilityVersion` | workflow-provisioning   | generated workflow shape version                     |
| `postingManifestVersion`    | runtime/posting proxy   | canonical manifest format                            |
| `summaryMarkerVersion`      | runtime/posting proxy   | hidden marker parser version                         |
| `modelOutputSchemaVersion`  | runtime                 | validator for provider/model result                  |

Compatibility matrix:

| Server support                    | Runtime support           | Workflow support          | Behavior                                            |
| --------------------------------- | ------------------------- | ------------------------- | --------------------------------------------------- |
| no conflict support               | any                       | any                       | no dispatch, feature flag ignored or rejected       |
| control-plane only                | no runtime support        | conflict workflow present | config exchange fails before checkout               |
| control-plane + runtime parser    | no posting support        | conflict workflow present | dry-run or degraded, no GitHub writes               |
| control-plane + runtime + posting | conflict workflow present | matching capability       | eligible for E2E and staged rollout                 |
| newer server, older runtime       | old protocol              | any                       | reject conflict config before checkout              |
| older server, newer runtime       | unsupported protocol      | any                       | runtime exits with safe health, no checkout/posting |

Versioning rules:

- Server must reject unknown future protocol versions unless explicitly marked
  backward compatible.
- Runtime must reject missing required protocol fields in conflict mode.
- Workflow capability hash must include the inputs, permissions, runtime ref,
  and reusable workflow path.
- Summary marker parser must support old marker versions only if ownership and
  scope validation remain exact.
- Posting manifest version changes must be accompanied by deterministic hash
  tests.
- A runtime version that supports dry-run only must not be production-posting
  eligible.

Rollout ordering:

1. Deploy server that knows the new protocol but keeps feature flag off.
2. Generate/provision conflict-capable workflow only for internal/disposable
   repos.
3. Deploy runtime that can parse conflict mode and fail closed before checkout.
4. Add checkout/diff/model dry-run support.
5. Add posting proxy/session support behind dry-run validation.
6. Enable posting in disposable repos.
7. Enable limited beta only after E2E evidence is attached to the rollout.

## Deployment Order And Rollback Safety

Deployment must be safe across mixed versions. Assume API, worker, web, database,
runtime, and generated workflows do not update atomically.

Safe deployment order:

1. Add backward-compatible database columns/enums while no code writes them.
2. Deploy API that can read old and new attempt records, with feature flag off.
3. Deploy worker that understands new outbox/retry states, still flag-gated.
4. Deploy web/setup code that can render/probe conflict-capable workflows, still
   rollout-gated.
5. Release runtime that rejects conflict mode safely if server does not support
   it.
6. Enable dry-run only for disposable repositories.
7. Enable posting only after dry-run and E2E pass.

Rollback constraints:

- Rolling back API must not break reading attempts with new nullable fields.
- Rolling back worker must not replay conflict outbox events into unsafe states.
- Rolling back runtime must fail before checkout, not continue as normal review.
- Rolling back workflow generation must not delete user workflow files during an
  incident.
- Database rollback should not be required for feature disablement.

Mixed-version tests:

- New workflow with old runtime exits before checkout.
- Old workflow with new server cannot obtain conflict config.
- New runtime with old server exits safely.
- New posting manifest with old server is rejected before GitHub writes.
- Old attempt rows without runtime fields still render in dashboard/health.

## Workflow Security Contract

The generated conflict-capable workflow is part of the trust boundary. Runtime
code cannot compensate for a workflow that grants broad permissions or runs
untrusted steps before preflight.

Required workflow properties:

- Top-level `permissions` is `{}` or equivalent least privilege.
- Normal review job and conflict review job are separate jobs.
- Normal review job does not run for `repository_dispatch`.
- Conflict review job runs only when:
  - `github.event_name == 'repository_dispatch'`
  - `github.event.action == 'reviewrouter_conflict_review'`
- Conflict review job permissions are exactly the minimum needed before posting:
  - `contents: read`
  - `id-token: write`
- Conflict review job does not receive write permissions for pull requests,
  issues, statuses, checks, or contents.
- Conflict review job calls the trusted reusable runtime by the expected ref.
- Conflict review job passes conflict inputs from `client_payload` only as data
  for runtime validation, not as authority.
- Conflict workflow does not expose user-editable `workflow_dispatch` inputs for
  `review_kind`, head SHA, base ref, base SHA, dispatch id, or nonce.
- Workflow concurrency group does not use branch names, PR titles, raw dispatch
  ids, raw nonce, or user-controlled text.
- Workflow does not define caches or artifact uploads for conflict data.
- Workflow does not run local shell steps before trusted runtime preflight.

Forbidden workflow properties:

- `permissions: write-all`
- `permissions: read-all`
- top-level write permissions
- local `run:` steps before OIDC/config preflight
- local actions or composite actions before preflight
- dependency install before preflight
- exposing conflict inputs through manual dispatch
- adding `repository_dispatch` to the required workflow

Workflow tests:

- Rendered workflow contains separate normal and conflict jobs.
- Conflict job cannot satisfy normal required review.
- Required workflow never receives `repository_dispatch`.
- Capability analyzer rejects top-level write/read-all permissions.
- Capability analyzer rejects unexpected conflict job permissions.
- Capability analyzer rejects local steps before reusable runtime call.
- Capability hash changes if permissions, runtime ref, inputs, or job shape
  changes.

## Dispatch Payload And Nonce Policy

`repository_dispatch.client_payload` is delivery data only. It must be small,
bounded, non-authoritative, and useless without the durable server-side attempt
record.

Payload rules:

- Include only dispatch id, nonce, attempt reference, expected head/base hints,
  and protocol/version fields needed for runtime preflight.
- Do not include provider config, posting policy, prompt content, model output,
  user secrets, installation tokens, GitHub tokens, or full diff content.
- Do not include repository full name as an authorization field. It can be a
  display/API hint only.
- Do not include user-editable workflow inputs that can override review kind,
  context, target SHA, comment id, or target URL.
- Keep payload size far below GitHub limits so future fields do not push runtime
  authors toward storing secrets in workflow env or artifacts.
- Treat every payload field as untrusted until OIDC, nonce, attempt, and
  workflow capability validation pass.

Nonce rules:

- Nonce is generated server-side with cryptographically strong randomness.
- Store only nonce hash and metadata needed for replay defense.
- Nonce is scoped to one dispatch id, one attempt, one repository id, one run
  identity after OIDC binding, and one purpose.
- Nonce must be masked in workflow logs before any step can echo env or inputs.
- Nonce must not be passed to provider/model subprocesses.
- Nonce replay from another run, run attempt, repository, or purpose fails
  closed.
- Manual replay before runtime start must rotate dispatch id and nonce.
- Replay after runtime start must not rotate posting fingerprints and must use
  checkpoint-aware recovery.

Tests:

- Dispatch payload fixture contains no provider config, prompt, diff, token, or
  posting field.
- Payload with valid dispatch id but wrong repository id is rejected.
- Nonce replay from another run is rejected.
- Nonce replay with wrong purpose is rejected.
- Logs mask nonce before any raw payload logging.
- Oversized payload is rejected before dispatch.

## GitHub Actions Concurrency And Rerun Contract

GitHub Actions reruns, cancellation, and concurrency settings can create subtle
duplicate or stale runs. The workflow contract must make rerun behavior safe
without relying on GitHub to run exactly once.

Concurrency rules:

- Conflict job concurrency group must be deterministic and bounded.
- Concurrency group must not include raw nonce, PR title, branch name, raw base
  ref, user-controlled text, or raw dispatch payload.
- Concurrency group should include safe attempt/dispatch identity where
  possible, but correctness still comes from server-side CAS and checkpoints.
- `cancel-in-progress` must be reviewed explicitly. If enabled, cancellation
  must leave pending posting intents reconcilable. If disabled, duplicate
  started runs must still fail via server-side state checks.
- Workflow rerun must use the original dispatch payload only as data. Server
  state decides whether the attempt is still current or already terminal.
- A rerun with a new `run_attempt` may resume only through existing checkpoints
  or exit stale. It must not create a second posting session that ignores prior
  side effects.
- A rerun after a newer attempt exists must exit stale before checkout or before
  posting, depending on when the server detects it.
- A rerun of an old runtime version must fail before checkout if the protocol is
  no longer supported.

Tests:

- Rerun after summary checkpoint does not create a second summary.
- Rerun after final status exits terminal/no-op.
- Rerun after newer head attempt exits stale.
- Duplicate runs racing to start bind only one run identity or one posting
  session.
- Concurrency group generation rejects user-controlled strings.
- `cancel-in-progress` behavior has explicit tests for pending intent
  reconciliation.

## Runtime Supply Chain And Release Integrity

The reusable runtime is part of the security boundary. A safe server design can
still be defeated if workflow generation points at a mutable or unreviewed
runtime revision.

Release rules:

- Production conflict workflows should reference an immutable runtime release or
  pinned SHA, not a floating branch.
- Development may use mutable refs only in explicitly non-production
  repositories and only with dry-run/posting disabled.
- Runtime release artifacts must include the supported
  `runtimeProtocolVersion`, minimum server version, and checksum or commit SHA.
- Server-side workflow capability validation must bind the expected runtime ref
  or SHA into `workflowCapabilityHash`.
- OIDC validation must verify `job_workflow_ref` and `job_workflow_sha` against
  the capability snapshot where GitHub provides those claims.
- A runtime release that changes protocol, posting manifest, marker format, or
  model output schema must bump the relevant version and update compatibility
  tests.
- Do not auto-upgrade customer workflows to a new conflict-capable runtime while
  the global feature flag is off unless the new runtime is fail-closed.

Release evidence:

- generated workflow snippet with runtime ref
- runtime version and protocol version
- server compatibility matrix row
- smoke run URL for the release candidate
- proof that old server/new runtime and new server/old runtime both fail closed
- proof that posting remains disabled when only runtime is upgraded

Forbidden:

- Using `main`, `master`, `latest`, or mutable tags for production conflict
  runtime posting.
- Letting workflow provisioning silently change runtime refs without updating
  capability hash.
- Treating runtime version strings as trust without OIDC workflow identity and
  capability validation.
- Publishing a runtime that can post without the server-side posting proxy.

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

## TOCTOU Guard Points

The main correctness risk is time-of-check to time-of-use drift. The PR can
change after any validation, and GitHub writes are external side effects. Treat
every privileged boundary as stale until the server proves otherwise.

Guard table:

| Boundary                        | Revalidate immediately before use                       | If check fails                                 |
| ------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| before returning runtime config | flag, rollout, workflow capability, attempt, nonce      | deny config, no checkout                       |
| before checkout                 | repository id, PR number, head SHA, base ref/base SHA   | mark stale/skipped, no checkout                |
| before diff construction        | head SHA, base semantics, PR open/not draft             | mark stale, no model                           |
| before provider/model execution | diff bounds, config snapshot hash, provider readiness   | degrade before model                           |
| after model output validation   | attempt state, latest attempt generation, manifest hash | do not request posting session                 |
| before posting session issuance | full pre-post validation plus flag/rollout              | deny session, no GitHub write                  |
| before summary create/update    | session scope, marker ownership, attempt state          | no summary write                               |
| before every inline batch       | head/base still current, write budget, coordinate map   | stop inline, summary-only/degraded             |
| before final advisory status    | final pre-status validation, advisory context           | no success status, degraded/stale health only  |
| before health/audit persistence | redaction policy and payload bounds                     | drop unsafe fields, keep safe reason code only |

Rules:

- A validation result must never be cached across model execution or posting
  phases.
- Runtime-provided PR/head/base values are hints only after OIDC start. Server
  state and GitHub gateway reads decide freshness.
- The posting proxy must repeat server-side freshness checks even if runtime
  already called a pre-post validation endpoint.
- A successful pre-post validation permits only the next bounded phase, not the
  whole remaining run.
- If two guards disagree, the stricter result wins. For example, if the runtime
  believes the PR is current but server sees a newer attempt, the run is stale.

Tests:

- Head changes between pre-post validation and summary write.
- Head changes between summary write and inline batch.
- Base changes between inline batch and status write.
- Feature flag disables between posting session issuance and first write.
- Workflow capability changes after model output but before posting.
- Latest attempt generation changes after model output.
- Health payload containing raw diff/prompt is rejected or redacted.

## Attempt State Machine

The runtime must not invent its own lifecycle separate from durable attempts.
Every transition should be idempotent and compare the current stored state.

Recommended states:

```text
recorded
-> dispatched
-> started
-> model_running
-> posting_started
-> summary_posted
-> inline_posting_completed
-> status_posted
-> completed
```

Terminal or non-happy states:

```text
skipped
stale
failed
degraded
dead_letter
```

Allowed transitions:

| From                       | To                                              | Allowed when                                      |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `recorded`                 | `dispatched`                                    | dispatch API accepted and nonce/dispatch id saved |
| `recorded`                 | `skipped`                                       | capability, policy, or PR state says do not run   |
| `dispatched`               | `started`                                       | OIDC and nonce validation pass                    |
| `started`                  | `model_running`                                 | pre-checkout PR validation passes                 |
| `model_running`            | `posting_started`                               | model output validated and pre-post passes        |
| `posting_started`          | `summary_posted`                                | summary create/update checkpoint saved            |
| `summary_posted`           | `inline_posting_completed`                      | inline phase completed or degraded safely         |
| `inline_posting_completed` | `status_posted`                                 | fresh pre-status validation passes                |
| `status_posted`            | `completed`                                     | final health recorded                             |
| any non-terminal           | `stale`                                         | head/base/PR state no longer matches attempt      |
| any non-terminal           | `failed`                                        | unrecoverable internal/runtime error              |
| any posting state          | `degraded`                                      | advisory output partially posted safely           |
| retryable non-terminal     | prior safe retry state with incremented attempt | no posting side effects have escaped              |

Forbidden transitions:

- `completed` back to any posting state.
- `stale` back to posting.
- `failed` back to posting unless a retry policy proves no side effects escaped.
- `dispatched` to `completed` without `started`.
- Any state to normal review state.

Concurrency rules:

- State updates must use optimistic concurrency or compare-and-set semantics.
- Posting writes must use a two-step intent/commit checkpoint. Reserve intent
  before the GitHub call, then commit the checkpoint only after the write is
  confirmed or reconciled.
- A second runtime for the same dispatch id must not be able to start a new
  posting session.
- A newer attempt for the same PR/head/base should make older attempts stale
  before posting.
- Retrying dispatch before runtime starts may rotate nonce and dispatch id.
- Retrying after runtime starts must preserve idempotency and must not rotate
  posting fingerprints.

## Transactional Consistency And Locking

Do not rely on "the workflow probably runs once". GitHub can redeliver webhooks,
users can press rerun, workers can retry outbox jobs, and HTTP responses can be
lost after a GitHub write succeeded. The database must make unsafe interleavings
unrepresentable.

State transition rules:

- Every attempt row should have a monotonically increasing `version` or
  equivalent compare-and-set token.
- State transitions update by `(attemptId, expectedStatus, expectedVersion)`.
- Terminal states are absorbing. A terminal row update should be a no-op unless
  the operation is an explicit operator recovery path.
- A stale transition wins over non-terminal progress if the latest PR/head/base
  generation no longer matches the attempt.
- `runId` and `runAttempt` are bound once during OIDC start. Later writes must
  match both values.
- No server endpoint may trust a runtime-supplied state. Runtime asks for a
  transition; server decides from stored state.

Locking and uniqueness:

- The "current attempt" semantic key is
  `(workspaceId, repositoryId, pullRequestNumber, headSha, baseRef, baseSha)`.
- At most one non-terminal current attempt should exist for the same semantic
  key. If the existing schema cannot express this as a partial unique index,
  implement an application-level compare-and-set with tests.
- Dispatch id must be unique and immutable after it is observed by the runtime.
- Nonce hash must be bound to one dispatch id and one run identity after
  successful OIDC exchange.
- Posting intent ids must be unique by
  `(attemptId, operationKind, operationFingerprint)`.
- Summary comment id, inline fingerprints, and advisory status target must be
  written only through checkpoint-aware repository methods.

External write lifecycle:

```text
begin db transaction
  validate attempt/version/state/scope
  reserve posting intent with idempotency key and pending state
commit

call GitHub through narrow adapter/proxy

begin db transaction
  compare-and-set pending intent
  save GitHub id/body hash/fingerprint/status target
  advance attempt state if all prerequisites are satisfied
commit
```

If the GitHub call times out or returns an ambiguous error:

- Do not create a new intent.
- Do not blindly retry the write.
- Reconcile through the proxy by reading GitHub state using the stored intent,
  marker, fingerprint, author identity, target SHA, and context.
- Commit the checkpoint only if reconciliation proves the write exists and
  belongs to this attempt.
- Otherwise keep the intent pending/degraded for bounded retry or operator
  recovery.

Forbidden transaction patterns:

- Holding a database transaction open while calling GitHub or a provider.
- Updating attempt state after a GitHub write without checking row version.
- Marking a write checkpoint complete before GitHub success or reconciliation.
- Rotating posting fingerprints after a retry.
- Using `updatedAt` ordering as the only duplicate prevention mechanism.

Tests:

- Two OIDC starts for the same dispatch race; only one binds run identity.
- Two posting-session requests race; only one active session/intent set wins.
- Summary write succeeds but response is lost; retry reconciles and updates the
  checkpoint without creating another summary.
- Status write succeeds but DB update fails; retry reads status/check before
  writing again.
- Newer attempt is created while older attempt is between model and posting;
  older attempt exits stale.
- Operator replay cannot move a terminal `stale` attempt back to posting.

## Consistency Model And Read Sources

Conflict posting decisions must not be made from stale replicas, stale caches,
or runtime-local snapshots. A stale read before a GitHub write can produce the
same class of bug as missing validation.

Read-source rules:

| Decision                      | Allowed read source                         | Forbidden source                           |
| ----------------------------- | ------------------------------------------- | ------------------------------------------ |
| issue runtime config          | primary DB or strongly consistent store     | stale cache, read replica with unknown lag |
| bind run id/run attempt       | primary DB compare-and-set                  | runtime-local state                        |
| decide latest current attempt | primary DB or transactional repository call | cached attempt list                        |
| issue posting session         | primary DB plus fresh GitHub PR state       | previously returned runtime config         |
| create/update summary         | posting intent plus fresh GitHub read       | cached comment search result               |
| post inline batch             | posting intent plus current coordinate map  | old diff map from before head/base recheck |
| post final advisory status    | final pre-status validation                 | summary-posted state alone                 |
| operator replay               | primary DB plus checkpoint reconciliation   | GitHub UI inspection alone                 |

Consistency requirements:

- Reads that authorize GitHub writes must use primary/strongly consistent data
  or a repository method that documents equivalent freshness.
- A read replica may be used for dashboards, readiness, and non-authoritative
  support views, but not for posting-session issuance or attempt transitions.
- If the infrastructure cannot guarantee strong reads, the endpoint must use
  compare-and-set writes to prove the decision was still current.
- Cache entries must include the policy/config version they represent. Missing
  version means the cache cannot authorize a privileged operation.
- GitHub PR state reads must happen after server state freshness checks, then
  server state must be checked again before the write if the phase can take
  noticeable time.
- Any cross-region deployment must document which region owns attempt mutation
  and posting intent mutation.

Tests:

- Simulated read replica returns old attempt state; posting session is denied or
  CAS fails.
- Stale cached rollout allow decision cannot issue posting session.
- Cached GitHub comment search result cannot update a user-authored comment.
- Cross-region duplicate runtime starts race; only one region can bind run
  identity.
- Dashboard can display old data but cannot trigger replay or posting from it.

## Time, Deadline, And Cancellation Semantics

Runtime phases need explicit deadlines. Without them, retries and cancellations
can leave ambiguous writes, stale attempts, or provider runs that finish after a
newer attempt already exists.

Time-source rules:

- Server decides token/session expiry using server time.
- Runtime may enforce local deadlines for resource control, but local clock
  cannot extend server-issued TTLs.
- Use monotonic timers for elapsed duration in runtime where available.
- Store timestamps for audit, not as the only correctness guard.
- Clock skew should fail closed at token/session validation, not relax purpose
  or attempt checks.

Deadline rules:

| Phase                | Deadline behavior                                      |
| -------------------- | ------------------------------------------------------ |
| OIDC/config exchange | fail before checkout if expired or delayed             |
| checkout/diff        | fail/degrade before model; no posting authority        |
| provider/model       | cancel provider, validate no partial output by default |
| posting session      | short TTL, cannot be refreshed by runtime alone        |
| summary write        | ambiguous timeout goes to reconciliation               |
| inline batch         | stop at deadline and mark inline degraded              |
| final status         | no retry after stale/deadline unless revalidated       |
| health/audit         | best-effort safe payload, never blocks kill switch     |

Cancellation rules:

- Cancellation before model output produces no comments.
- Cancellation during model execution kills the provider subprocess and removes
  prompt/temp files according to retention policy.
- Cancellation after posting intent reservation must leave the intent pending
  for reconciliation, not mark it complete.
- Cancellation after summary success but before checkpoint commit must reconcile
  before retry.
- GitHub Actions rerun after cancellation must use the same attempt checkpoints
  or exit stale.

Tests:

- Provider timeout after partial stdout posts no findings by default.
- Posting session expires between summary and inline; inline/status stop safely.
- Runtime receives cancellation after posting intent reservation; retry
  reconciles.
- Local clock is ahead/behind server clock; token validation still fails closed.
- Health reporting failure after terminal checkpoint does not reopen attempt.

## Data Contracts

### Conflict Attempt Record

The durable attempt must be the authority for:

- repository id
- GitHub repository id
- installation id
- workspace id
- PR number
- head SHA
- base ref
- base SHA
- dispatch id
- nonce hash
- fallback version
- config snapshot id/hash
- workflow capability version/hash
- status
- run id and run attempt after OIDC start
- safe failure/degraded reason
- posting checkpoints

Do not store:

- raw nonce
- OIDC token
- GitHub token
- posting token
- full diff
- full prompt
- full model output
- raw comment body unless existing product policy already allows it

### Runtime Config Response

Conflict runtime config may include:

- provider routing/config needed for review
- non-posting runtime session token
- expected repository/PR/head/base metadata
- config snapshot id/hash
- API URLs
- safe limits

Conflict runtime config must not include:

- posting token/session
- GitHub App installation token
- status context chosen by model/user input
- summary comment id unless scoped and verified for conflict mode
- retry decisions based on runtime-provided payload

### Posting Session Response

Posting session response may include only:

- a short-lived ReviewRouter posting session token or proxy authorization
- allowed operations
- allowed status/check context
- allowed target head SHA
- allowed summary comment id or create-summary permission
- inline cap
- expiration time

The response must be invalid outside the exact attempt and run identity that
requested it.

## Canonicalization And Hashing

Idempotency depends on stable canonical values. Do not compute hashes from raw,
order-dependent, or model-controlled objects.

Canonicalization rules:

- JSON is serialized with deterministic key ordering.
- Omit fields that are not part of the semantic identity, such as local temp
  paths, elapsed time, logs, retry counters, and raw provider metadata.
- Normalize line endings to `\n`.
- Normalize file paths as POSIX-style relative paths after validation.
- Preserve case for file paths and branch refs. Do not lowercase values that are
  case-sensitive in Git.
- Trim only fields where the parser defines trimming. Do not trim model bodies
  before hashing unless rendering also trims them.
- Hash summary body after runtime-owned marker is added.
- Hash finding bodies after markdown sanitization and mention policy.
- Include `repositoryId`, `pullRequestNumber`, `headSha`, `baseRef`, `baseSha`,
  `configSnapshotId`, and `dispatchId` in manifest identity.
- Include schema/version fields in hashes so format changes cannot collide with
  old checkpoints.

Required hashes:

| Hash                     | Inputs                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `configSnapshotHash`     | provider routing, model, prompt policy, output schema, posting policy           |
| `workflowCapabilityHash` | workflow path, runtime ref, permissions, event triggers, inputs, job shape      |
| `postingManifestHash`    | attempt identity, safe findings, summary hash, inline fingerprints, status plan |
| `summaryBodyHash`        | rendered advisory summary plus canonical marker                                 |
| `inlineFingerprint`      | repo id, PR number, head/base, path, side, line range, sanitized body hash      |
| `postingScopeHash`       | allowed operations, context, comment id scope, TTL bucket, run identity         |

Hash tests:

- Same semantic manifest produces same hash across retries.
- Reordered JSON keys produce same hash.
- Changed base SHA produces different hash.
- Changed config snapshot produces different hash.
- Changed sanitized finding body produces different inline fingerprint.
- Runtime local paths do not affect hash.

## Path, Unicode, And File Identity Policy

File paths are repository-controlled data. They affect diff construction,
fingerprints, inline coordinates, prompt content, markdown rendering, logs, and
shell/process boundaries, so they need a single policy.

Path rules:

- Accept only normalized repository-relative POSIX paths from trusted diff
  sources.
- Reject absolute paths, path traversal, empty segments, control characters, NUL
  bytes, and platform-specific device paths.
- Preserve case. Do not lowercase paths because Git path identity can be
  case-sensitive.
- Normalize path separators to `/` only after validation.
- Treat symlinks, submodules, and Git LFS pointers as metadata-only in v1 unless
  a later design proves safe content handling.
- Never pass repository paths to shell commands through string interpolation.
- Never use repository path as a metric label.
- Include normalized path and file status in inline fingerprints.
- Include old and new path for rename identity where both matter, but do not
  let old path collide with new path fingerprints.
- Use a display-safe escaped path in markdown, logs, and support exports.

Unicode rules:

- Do not normalize Unicode in a way that changes Git identity.
- Reject or escape bidirectional control characters and invisible control
  characters in display contexts.
- Use byte/character limits that cannot split surrogate pairs or create invalid
  UTF-8 output.
- Store hashes over the exact validated normalized representation used by the
  posting manifest.
- If two paths are visually confusable but distinct, treat them as distinct
  repository paths but display them safely.

Tests:

- Absolute path, traversal path, NUL byte, and control-character path are
  rejected.
- Case-distinct paths do not collide in fingerprints.
- Rename old/new paths produce stable non-colliding fingerprints.
- Symlink/submodule fixtures are metadata-only.
- Bidirectional control character fixture is escaped in markdown/log display.
- Path cannot become a shell argument through string interpolation.

## API Surface

Keep the conflict API small. Do not add generic endpoints that can be reused by
normal review or manual workflows unless the authorization model is identical.

Current v1 runtime endpoints:

| Endpoint                                       | Caller               | Purpose                              | Must validate                                         |
| ---------------------------------------------- | -------------------- | ------------------------------------ | ----------------------------------------------------- |
| `POST /api/action/v1/session/exchange`         | runtime              | OIDC config/session exchange         | conflict payload only for `repository_dispatch`       |
| `GET /api/action/v1/config`                    | runtime              | non-posting runtime config retrieval | session kind, snapshot, version, repository state     |
| `POST /api/action/v1/conflict-posting/session` | runtime              | mint scoped posting session          | run identity, attempt, manifest hash, operation scope |
| `POST /api/action/v1/conflict-posting/summary` | runtime proxy client | create/update advisory summary       | posting session, marker ownership, body bounds        |
| `POST /api/action/v1/conflict-posting/status`  | runtime proxy client | post advisory status                 | posting session, fixed context, head SHA, validation  |
| `POST /api/action/v1/health-report`            | runtime              | existing safe health reporting       | bounded payload, redaction, known reason codes        |

The runtime still performs explicit pre-post validation before requesting a
posting session and again before terminal status. The server repeats PR-state
validation inside the posting-session, summary, and status write paths instead
of trusting runtime-local validation only.

If the implementation chooses a pure proxy, the runtime should not call GitHub
write APIs directly. If it chooses a one-shot posting session, the session must
still restrict the operation set in ReviewRouter before any GitHub request is
made.

API contract rules:

- All endpoints must require the existing runtime session token or a derived
  conflict posting token.
- All conflict endpoints must reject `reviewKind != conflict-head`.
- All bodies must use one canonical casing. If compatibility aliases exist, the
  parser must reject conflicting alias values.
- All endpoints must return stable machine-readable error codes.
- All endpoints must redact raw nonce/token values from errors.
- No endpoint accepts target repository, target context, target URL, comment id,
  or status conclusion from model output.
- Idempotency keys must be explicit for write endpoints.

Endpoint security checklist:

- AuthN: endpoint requires runtime session or conflict posting session.
- AuthZ: endpoint validates tenant/repository/installation/attempt tuple.
- Purpose: token purpose matches endpoint purpose.
- Freshness: token TTL, run id, run attempt, and nonce binding are valid.
- State: attempt state allows the requested transition.
- Scope: operation is inside posting session allowlist.
- Staleness: current PR state is still compatible where required.
- Idempotency: write endpoint has deterministic idempotency key.
- Redaction: errors and logs cannot include raw nonce, tokens, diff, prompt, or
  model output.
- Rate limit: endpoint applies per-repo/attempt budget where applicable.

Example write idempotency keys:

```text
summary: conflict-summary:<attempt_id>:<summary_body_hash>
inline: conflict-inline:<attempt_id>:<finding_fingerprint>
status: conflict-status:<attempt_id>:<head_sha>:<context>:<conclusion>
```

Do not use branch names or raw PR titles in idempotency keys.

## Request Schema Guardrails

All conflict runtime endpoints should have explicit schemas. Avoid optional
"bag of fields" bodies because they make mixed-version and alias bugs hard to
notice.

`posting-session` request shape:

```json
{
  "schema_version": "conflict-posting-session-request-v1",
  "dispatch_id": "dispatch_public_id",
  "attempt_id": "attempt_public_id",
  "review_kind": "conflict-head",
  "purpose": "posting_token",
  "run_id": "1234567890",
  "run_attempt": 1,
  "posting_manifest_hash": "sha256:...",
  "requested_operations": ["summary", "inline", "status"],
  "client_runtime": {
    "name": "reviewrouter-runtime",
    "version": "x.y.z",
    "protocol": "conflict-runtime-v1"
  }
}
```

Server-side schema rules:

- `schema_version`, `review_kind`, and `purpose` are required literals.
- `dispatch_id`, `attempt_id`, `run_id`, and `run_attempt` must match the
  server-bound attempt.
- `requested_operations` is intersected with server policy. It cannot add
  operations that the manifest or rollout does not allow.
- `posting_manifest_hash` must match the canonical manifest already validated
  by the server or be validated in the same request.
- Runtime version must satisfy the conflict minimum version.
- Unknown fields are rejected in v1.
- Conflicting aliases such as `dispatchId` and `dispatch_id` are rejected even
  if they contain the same value.

Write request schema rules:

- Summary body is accepted only after runtime adds the conflict marker and the
  server validates size and marker metadata.
- Inline comments are accepted as a bounded array of canonical findings, not as
  arbitrary GitHub API payloads.
- Status/check request contains only a manifest reference. The server computes
  target SHA, context, target URL, and conclusion from policy.
- Every write request carries the posting session id and idempotency key.
- Raw model output, raw prompt, and raw diff are never accepted by write
  endpoints.

Response rules:

- Return safe operation ids, counts, hashes, and degraded reason codes.
- Do not return GitHub response bodies verbatim.
- Do not return installation tokens, repository tokens, or raw posting tokens
  from write endpoints.
- Include a correlation id in every response so support can join runtime logs,
  audit events, and proxy logs without exposing secrets.

## Parser And Validation Policy

Parsing is a security boundary for conflict mode. Inputs come from GitHub event
payloads, workflow env, runtime HTTP bodies, provider output, and database
records created by older code. Each source needs a typed parser that produces a
small trusted object or fails closed.

Parser rules:

- Parse at the boundary, then pass typed values inward. Do not pass raw request
  bodies deeper than the HTTP/controller layer.
- Reject unknown fields for conflict runtime v1 unless the schema explicitly
  says the field is forward-compatible metadata.
- Reject alias conflicts even when values match. Multiple spellings often hide
  mixed-version bugs.
- Validate SHA, repository id, installation id, run id, run attempt, dispatch
  id, and PR number with dedicated validators.
- Validate branch/base refs as data only. A valid ref is still not safe for
  shell interpolation.
- Keep PR number numeric but never use it as an authorization boundary without
  repository and installation ids.
- Validate URL fields by allowlist. Runtime/model output should not provide
  posting target URLs in v1.
- Validate enum values with exhaustive switches. Unknown enum values fail
  closed, not silently default to normal review.
- Normalize only after validation. Do not lowercase case-sensitive Git values.
- Preserve original safe ids for audit, but never store raw secrets or raw
  payloads.

Typed value objects:

| Value object               | Accepts                                  | Rejects                                      |
| -------------------------- | ---------------------------------------- | -------------------------------------------- |
| `GitSha`                   | 40-char hex SHA, future SHA format gated | empty, branch names, abbreviated SHA in v1   |
| `RepositoryIdentity`       | immutable repository id + installation   | full name alone                              |
| `ConflictDispatchId`       | server-generated dispatch id             | runtime-created ids                          |
| `ConflictReviewKind`       | literal `conflict-head`                  | booleans, aliases, normal review fallback    |
| `RuntimeProtocolVersion`   | supported explicit version               | missing or inferred versions                 |
| `PostingOperationKind`     | `summary`, `inline`, `status`            | arbitrary GitHub method names                |
| `AdvisoryStatusContext`    | central conflict context constant        | model/user supplied contexts                 |
| `SafeReasonCode`           | documented taxonomy value                | free-form errors                             |
| `NormalizedRepositoryPath` | changed-file relative path               | absolute path, traversal, control characters |

Validation layering:

```text
raw payload
-> parser validates syntax and unknown fields
-> authorizer validates tenant/repo/installation/attempt
-> freshness checker validates current PR/head/base/capability
-> policy validates rollout, budgets, allowed operation
-> command handler performs side effect through narrow port
```

Tests:

- Every parser has invalid, unknown-field, alias-conflict, and boundary-value
  fixtures.
- Unknown `review_kind` cannot fall back to normal review.
- Unknown posting operation cannot reach GitHub adapter.
- Invalid URL/context/comment id from model output is ignored or rejected before
  manifest creation.
- A full repository name without immutable ids cannot authorize any endpoint.

## GitHub Adapter Contract

All GitHub reads and writes for conflict mode must go through a narrow adapter.
Do not expose Octokit, REST paths, GraphQL, or installation tokens to the runtime
or model-facing code.

Adapter ports:

| Port                       | Reads/writes                                  | Required inputs                         |
| -------------------------- | --------------------------------------------- | --------------------------------------- |
| `ConflictPrStateReader`    | reads PR state, repository id, head/base      | installation id, repository id, PR      |
| `ConflictDiffSource`       | reads changed files/diff metadata             | attempt identity, expected head/base    |
| `ConflictSummaryPoster`    | creates/updates one advisory summary          | posting intent, marker, body hash       |
| `ConflictInlinePoster`     | creates bounded inline comments               | posting intent, coordinate fingerprints |
| `ConflictStatusPoster`     | creates advisory status/check                 | posting intent, fixed context/head SHA  |
| `ConflictRulesetInspector` | optional readiness warning for required usage | repository id, advisory context         |

Adapter requirements:

- Use immutable repository id and installation id for authorization decisions.
  Repository full name is only an API coordinate and display value.
- Sanitize GitHub errors before they cross into runtime logs or health.
- Normalize GitHub secondary rate limits into stable conflict reason codes.
- Support pagination with explicit caps. No unbounded "fetch all comments" or
  "fetch all files" calls.
- Include GitHub request ids in server logs/audit when available, but do not
  expose raw response bodies to runtime.
- Use read-before-write recovery for ambiguous create/update/status responses.
- Never let callers pass arbitrary URL, REST path, GraphQL mutation, context,
  comment id, or target SHA.
- Keep retry policy inside the adapter/proxy. Runtime may retry safe endpoints,
  but it must not implement GitHub write retries itself.

Tests:

- Runtime code cannot import the raw GitHub client in conflict posting modules.
- Adapter rejects unknown operation kind.
- Adapter caps pagination for comments and changed files.
- Adapter maps secondary rate limit to a safe degraded reason.
- Adapter redacts GitHub error response fixtures that contain request bodies.
- Adapter cannot post the normal required ReviewRouter context.
- Adapter cannot update a comment whose author/app identity is not trusted.

## GitHub API Budget, Pagination, And Recovery Contract

The GitHub adapter must be predictable under large PRs, many comments, API
timeouts, secondary rate limits, and partial outages. Unbounded pagination or
silent retries can create the same user-visible damage as a broad token.

Budget rules:

- Every adapter operation has an explicit per-attempt request budget.
- Comment search, changed-files reads, status/check lookup, and ruleset reads
  have separate budgets so one phase cannot starve another.
- Pagination stops at a documented cap and returns a degraded reason if the cap
  prevents safe ownership or duplicate checks.
- Secondary rate limit on inline comments stops the inline phase for that
  attempt. It must not retry a comment burst.
- Rate-limit state is recorded as safe metadata and metrics, not raw GitHub
  response bodies.
- Adapter retries are allowed only for idempotent reads and write recovery
  probes. Write retries require read-before-write proof.
- GitHub request ids should be captured in server logs/audit when available to
  support provider-side investigations.

Pagination policy:

| Operation                 | Pagination behavior                                    |
| ------------------------- | ------------------------------------------------------ |
| changed files             | cap by file count and byte budget, degrade if exceeded |
| trusted summary search    | search only bot/app comments and stop at ownership cap |
| inline duplicate recovery | lookup by fingerprint/checkpoint, not all PR comments  |
| status/check recovery     | lookup only expected head SHA and advisory context     |
| ruleset readiness         | best effort, never blocks normal review                |

Recovery rules:

- A timeout after a create/update call becomes an ambiguous write, not a failed
  write.
- Ambiguous summary writes recover by stored comment id first, then verified
  marker/author search inside the pagination cap.
- Ambiguous inline writes recover by fingerprint and comment id if available.
- Ambiguous status/check writes recover by expected head SHA, context, and
  target URL policy.
- If recovery cannot prove the write exists or is absent, stop the phase and
  record degraded/manual-recovery reason. Do not guess.

Tests:

- Comment search pagination cap degrades safely instead of updating an
  ambiguous comment.
- Changed-files pagination cap produces bounded diff degradation.
- Secondary rate limit fixture stops inline posting without retry burst.
- Ambiguous write recovery uses GitHub request id/correlation id safely.
- Status recovery cannot treat the normal required context as conflict status.
- Adapter retry budget exhaustion records a stable reason code.

## HTTP Error And Response Contract

Runtime endpoints should fail in a way that is safe, testable, and actionable.
Do not return free-form errors that require string matching.

Error response shape:

```json
{
  "error": {
    "code": "conflict_runtime_stale_head",
    "message": "Conflict review is stale for the current PR head.",
    "retryable": false,
    "safe": true,
    "phase": "pre_post_validation",
    "attempt_id": "attempt_public_or_internal_id",
    "correlation_id": "request_correlation_id"
  }
}
```

Rules:

- `code` is a stable enum from the failure taxonomy.
- `message` is safe for logs/support and contains no raw nonce, token, prompt,
  diff, provider output, or raw GitHub response body.
- `retryable` is computed by server policy, not runtime.
- `safe` must be true for every value returned to runtime.
- `phase` must be one of the documented runtime/posting phases.
- `correlation_id` is safe and should appear in logs/audit.
- HTTP 4xx is used for policy/validation/auth failures.
- HTTP 409 is preferred for stale or state-transition conflicts.
- HTTP 429 is used for budget/rate-limit denials.
- HTTP 5xx is reserved for server failures and must not include sensitive
  details.

Retry contract:

| Error class                          | Runtime behavior                                                 |
| ------------------------------------ | ---------------------------------------------------------------- |
| invalid input/auth/purpose           | exit failed, no retry                                            |
| stale PR/head/base                   | exit stale, no posting                                           |
| feature disabled/rollout off         | exit skipped, no posting                                         |
| budget/rate limit                    | exit degraded/skipped according to phase                         |
| transient server error before writes | retry with bounded backoff                                       |
| ambiguous GitHub write               | ask server/proxy to reconcile by checkpoint, never retry blindly |

Tests:

- Every conflict endpoint returns known error codes only.
- Error body redacts raw nonce/token fixtures.
- Stale state uses conflict/stale code, not generic 500.
- Runtime does not retry non-retryable errors.
- Ambiguous write error cannot be retried directly by runtime.

## Database And Migration Plan

The current attempt table is enough for detection and dispatch, but runtime
posting needs additional durable state. Add these fields only when the runtime
actually uses them, and keep migrations backward compatible while the feature
flag is off.

Recommended fields or related table:

| Field                      | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `runId`                    | GitHub Actions run id bound during OIDC start      |
| `runAttempt`               | GitHub Actions run attempt bound during OIDC start |
| `workflowRef`              | OIDC workflow ref used for started run             |
| `workflowSha`              | OIDC workflow SHA used for started run             |
| `jobWorkflowRef`           | reusable workflow identity                         |
| `jobWorkflowSha`           | reusable workflow SHA                              |
| `configSnapshotId`         | provider/config snapshot used for review           |
| `configSnapshotHash`       | stable hash for cross-stage consistency            |
| `workflowCapabilityHash`   | workflow shape trusted at dispatch/config time     |
| `postingManifestHash`      | canonical manifest for writes                      |
| `summaryCommentId`         | GitHub id for advisory summary checkpoint          |
| `summaryBodyHash`          | duplicate/update guard                             |
| `inlineFingerprintSetHash` | compact checkpoint of planned inline comments      |
| `postedInlineFingerprints` | durable posted set or child table                  |
| `statusContext`            | expected advisory status context                   |
| `statusTargetSha`          | expected head SHA for advisory status              |
| `terminalStatusId`         | GitHub status/check id if available                |
| `lastSafeReasonCode`       | stable reason code for health/ops                  |
| `postingStartedAt`         | phase checkpoint                                   |
| `summaryPostedAt`          | phase checkpoint                                   |
| `inlinePostingCompletedAt` | phase checkpoint                                   |
| `statusPostedAt`           | phase checkpoint                                   |
| `completedAt`              | terminal checkpoint                                |

Migration safety rules:

- New columns should be nullable until runtime writes them.
- Unique constraints must not block existing rows created before runtime support.
- Any enum expansion must be deployed before code can write the new value.
- Backward-compatible readers must tolerate missing runtime posting fields.
- Rollback must not require dropping columns or deleting attempts.
- New indexes and uniqueness rules must be designed for existing data before
  they are applied in production.
- If a partial unique constraint is needed but the database abstraction cannot
  express it safely, add a repository-level CAS guard and document the weaker
  database guarantee.
- Backfills must not compute hashes from unavailable raw content. Missing old
  content should stay null and force fail-closed behavior where needed.

Data retention:

- Keep attempt metadata long enough for duplicate prevention and audit.
- Do not retain full diff, prompt, or full model output.
- If comment bodies are stored for debugging, that must be a separate product
  privacy decision, not an incidental runtime shortcut.

Migration phases:

1. Expand schema with nullable fields and new enum values.
2. Deploy readers that tolerate both old and new rows.
3. Deploy writers behind disabled feature flag.
4. Run targeted data-shape checks in production with no writes enabled.
5. Enable dry-run writes for internal/disposable repos.
6. Enable posting only after old rows, new rows, and rollback readers are
   verified.

Migration tests:

- Old attempt row without runtime fields can still be displayed and ignored by
  conflict posting.
- New attempt row with posting fields can be read by rolled-back code without
  throwing.
- Enum value expansion is deployed before any code path can write the value.
- Null `runId`, `runAttempt`, or `postingManifestHash` fails closed for posting
  endpoints.
- Duplicate current-attempt fixture is handled before adding a unique
  constraint.
- Backfill or migration scripts cannot store raw nonce, tokens, full diff,
  prompt, or model output.

Rollback data policy:

- Feature disablement is the primary rollback. Dropping columns is not part of
  emergency rollback.
- New conflict rows created during canary should remain for audit and duplicate
  prevention.
- If code rollback cannot understand a new enum, deploy a compatibility reader
  first. Do not manually rewrite production states as a shortcut.
- A rollback must not make pending posting intents invisible to the next forward
  deploy.

## Data Classification And Privacy

Conflict review touches repository content and generated review text. Classify
data before choosing where it can be stored or logged.

| Data                        | Classification              | Allowed storage                                      | Logging                               |
| --------------------------- | --------------------------- | ---------------------------------------------------- | ------------------------------------- |
| attempt id, dispatch id     | operational metadata        | database/audit                                       | yes                                   |
| repository id, PR number    | operational metadata        | database/audit                                       | yes                                   |
| head/base SHA               | operational metadata        | database/audit                                       | short/full per existing policy        |
| base ref                    | repository metadata         | database/audit after validation                      | bounded or hashed in high-volume logs |
| raw nonce                   | secret                      | never, hash only                                     | never                                 |
| OIDC token                  | secret                      | never                                                | never                                 |
| GitHub token                | secret                      | never                                                | never                                 |
| posting session token       | secret                      | never, hash/session id only                          | never                                 |
| provider credentials        | secret                      | existing secret store only                           | never                                 |
| diff content                | customer repository content | transient runtime only                               | never                                 |
| prompt                      | derived customer content    | transient runtime only unless product policy changes | never                                 |
| model output raw            | derived customer content    | transient runtime only unless product policy changes | never                                 |
| summary body hash           | operational metadata        | database/audit                                       | yes                                   |
| GitHub comment id/status id | operational metadata        | database/audit                                       | yes                                   |
| sanitized reason code       | operational metadata        | database/audit                                       | yes                                   |

Privacy rules:

- Do not store full diff/prompt/model output to make debugging easier.
- Do not include raw file snippets in health or audit payloads.
- Do not include raw provider stderr if it can contain prompt or diff content.
- If future debugging requires content capture, add an explicit retention,
  access, redaction, and customer-data policy first.
- Support exports should include ids, hashes, counts, reason codes, and GitHub
  URLs, not repository content.

## Secrets, Tokens, And Key Rotation

Conflict mode introduces more token choreography than normal review. Keep token
purpose and lifetime explicit.

Token classes:

| Token/value           | Where it appears                           | Lifetime                     | Can reach provider/model?   | Notes                                |
| --------------------- | ------------------------------------------ | ---------------------------- | --------------------------- | ------------------------------------ |
| dispatch nonce        | dispatch payload and runtime input         | single attempt/run binding   | No                          | mask before logs, store hash only    |
| GitHub OIDC token     | runtime preflight only                     | GitHub-issued short TTL      | No                          | exchanged for runtime session        |
| runtime session token | runtime to ReviewRouter API                | short server-defined TTL     | No                          | non-posting config/session only      |
| posting session token | posting phase only                         | shorter than runtime session | No                          | one attempt and operation set        |
| GitHub App token      | server-side proxy only in preferred design | GitHub-issued short TTL      | No                          | never before pre-post validation     |
| provider credentials  | provider runner only if needed             | existing provider policy     | Yes, only provider-specific | never mixed with posting/OIDC tokens |

Rules:

- Store only hashes for nonce and posting session ids.
- Use separate signing secrets or token purposes for runtime session and posting
  session. Do not let a runtime session be accepted as a posting session.
- Token verification must check purpose, issuer, audience, repository id,
  attempt id, run id, run attempt, expiration, and config snapshot.
- Token TTL should be short enough to reduce replay risk but long enough for
  normal GitHub API latency. Expiry causes a fresh validation, not reuse.
- Key rotation must support verifying tokens signed by the previous key during a
  short overlap window.
- Rotation must not make already-started runs post without revalidation.
- If key rotation invalidates active sessions, the runtime exits degraded without
  GitHub writes.

Tests:

- Runtime session cannot be used as posting session.
- Posting session cannot be used after expiration.
- Posting session signed with previous key works only inside overlap window.
- Token with correct signature but wrong purpose is rejected.
- Token with correct attempt id but wrong run attempt is rejected.
- Raw token fixture does not appear in logs, DB safe summaries, comments, or
  health payloads.

## Failure Taxonomy

Use stable reason codes. Avoid one-off strings because operations and tests need
to assert exact behavior.

| Code                                        | Meaning                                              | Posting allowed                                |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| `conflict_runtime_input_invalid`            | workflow input/env failed validation                 | No                                             |
| `conflict_runtime_oidc_rejected`            | OIDC claims or audience rejected                     | No                                             |
| `conflict_runtime_nonce_replay`             | nonce already consumed by another run/purpose        | No                                             |
| `conflict_runtime_capability_missing`       | workflow no longer supports conflict fallback        | No                                             |
| `conflict_runtime_stale_head`               | current PR head differs from attempt                 | No                                             |
| `conflict_runtime_stale_base`               | current base ref/SHA semantics differ                | No                                             |
| `conflict_runtime_pr_not_reviewable`        | PR closed, merged, draft, fork policy, or unselected | No                                             |
| `conflict_runtime_checkout_failed`          | exact checkout could not complete                    | Optional degraded status only after validation |
| `conflict_runtime_diff_too_large`           | diff exceeded v1 bounds                              | Summary-only or degraded status                |
| `conflict_runtime_provider_failed`          | model/provider execution failed                      | Optional degraded status only after validation |
| `conflict_runtime_model_output_invalid`     | model output schema invalid                          | Optional degraded status only after validation |
| `conflict_runtime_posting_session_rejected` | posting capability denied                            | No new GitHub writes                           |
| `conflict_runtime_summary_post_failed`      | summary create/update failed                         | Status may show degraded if safe               |
| `conflict_runtime_inline_post_degraded`     | inline phase partially skipped                       | Yes, summary/status with degraded note         |
| `conflict_runtime_status_post_failed`       | advisory status/check failed                         | Summary remains, health degraded               |

No reason code may include raw branch names, raw nonce, full prompt, full diff,
or provider output.

## Resource Budgets And Backpressure

Conflict fallback can be triggered by base-branch pushes across many PRs. It
must not create unbounded GitHub Actions, provider, or posting load.

Recommended budgets for v1:

| Resource                                  | Initial budget                    | Failure behavior                            |
| ----------------------------------------- | --------------------------------- | ------------------------------------------- |
| open PRs scanned per base push            | bounded page limit per repository | continue later or scheduled reconciliation  |
| conflict attempts per repository per hour | small rollout-defined cap         | skip/degrade with rate-limit reason         |
| runtime wall-clock duration               | fixed timeout per run             | fail/degrade, no posting without validation |
| checkout/fetch size                       | bounded history and file count    | fail/degrade before model                   |
| diff files                                | capped                            | summary notes omitted files                 |
| diff bytes sent to model                  | capped                            | summary/degraded mode                       |
| model findings                            | capped                            | truncate with safe note                     |
| inline comments                           | capped                            | summary-only for overflow                   |
| GitHub writes per attempt                 | capped                            | stop and mark degraded                      |
| retries per attempt                       | capped by phase                   | dead-letter or manual replay only           |

Backpressure rules:

- A base push must not enqueue infinite conflict detections for a busy repo.
- Outbox retry must use jitter/backoff and must distinguish retryable GitHub
  read failures from non-retryable policy/capability failures.
- Provider failures must not immediately retry posting phases.
- Secondary rate limits should disable inline posting for the current attempt.
- A repository with repeated conflict fallback failures should be paused for this
  feature until manually or automatically cooled down.
- Dashboard/health should expose skipped due to budget separately from stale and
  failed.

Tests:

- Base push reconciliation respects per-repo scan cap.
- Repeated duplicate webhooks do not create more than one current attempt.
- Rate limit response stops inline posting and does not retry a burst.
- Provider timeout does not create repeated dispatches.
- Budget skip does not post comments.

## Outbox And Poison Job Handling

Conflict fallback uses durable async work, so poison jobs must not create repeat
dispatches or comment storms.

Outbox rules:

- Conflict detection jobs are idempotent by repository, PR number, head SHA,
  base ref, base SHA, and fallback version.
- Dispatch jobs must check the attempt state immediately before calling GitHub.
- If dispatch succeeds but the worker crashes before marking processed, retry
  must observe the attempt dispatch state and avoid duplicate dispatch unless a
  safe retry policy rotates dispatch id/nonce before runtime starts.
- If runtime has started, worker retry must not rotate dispatch id/nonce.
- Dead-letter jobs must retain enough safe context to explain why they stopped.
- Poison jobs caused by validation/policy failures should not retry forever.
- Poison jobs caused by temporary GitHub read failures should use bounded
  backoff and then dead-letter with safe reason code.

Poison classifications:

| Class                                   | Retry?                        | Notes                          |
| --------------------------------------- | ----------------------------- | ------------------------------ |
| invalid payload/schema                  | No                            | code/data bug, needs fix       |
| repository unselected                   | No                            | policy state changed           |
| workflow capability missing             | No until setup changes        | avoid repeated dispatches      |
| GitHub 5xx/read timeout before dispatch | Yes with backoff              | no GitHub write happened       |
| dispatch accepted but worker crashed    | Conditional                   | inspect attempt dispatch state |
| runtime started                         | No redispatch                 | runtime owns progress          |
| permission missing                      | No until installation changes | expose degraded readiness      |

Tests:

- Worker crash after dispatch accepted does not create duplicate runtime starts.
- Dead-letter replay cannot bypass latest-attempt/stale checks.
- Poison validation error does not retry indefinitely.
- Runtime-started attempt prevents dispatch nonce rotation.

## Implementation Phases

### Phase 1: Runtime Mode Contract

Add an explicit `conflict-head` runtime mode to the reusable runtime.

Requirements:

- Accept `review_kind=conflict-head` only for `repository_dispatch`.
- Require `github.event.action == reviewrouter_conflict_review`.
- Reject `workflow_dispatch` with `review_kind=conflict-head`.
- Reject `pull_request` and `merge_group` with `review_kind=conflict-head`.
- Require `conflict_dispatch_id`, `conflict_dispatch_nonce`,
  `conflict_head_sha`, `conflict_base_ref`, and `conflict_base_sha`.
- Validate every conflict input with shared validators.
- Reject empty strings after trimming.
- Reject conflicting aliases. For example, if both snake_case and camelCase
  forms exist anywhere in HTTP/runtime payloads, they must represent the same
  value or the request is invalid.
- Mask `conflict_dispatch_nonce` before logging anything else.
- Never pass raw nonce to provider/model subprocesses.
- Never echo raw `client_payload` into shell.
- Fail closed if static runtime env says normal review but inputs say
  conflict-head.
- Fail closed if runtime action version is older than the minimum conflict
  runtime version.

Tests:

- Runtime accepts conflict mode from repository dispatch only.
- Runtime rejects wrong repository dispatch action.
- Runtime rejects missing conflict dispatch id.
- Runtime rejects invalid dispatch id format.
- Runtime rejects branch names with shell-sensitive syntax.
- Runtime rejects head/base SHA mismatch.
- Runtime rejects conflicting payload aliases.
- Runtime rejects old runtime action version.
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
- Re-check the global feature flag and repository rollout policy before
  returning config.
- Re-check repository selection, installation status, entitlement, and provider
  readiness before returning config.
- Re-check workflow capability version/hash. Dispatch-time capability is not
  enough because users can edit workflow files after dispatch.
- Return only non-posting runtime config.
- Return conflict metadata from the stored attempt, not from raw payload.
- Record `started` only after OIDC, nonce, capability, and policy checks pass.
- Store run id and run attempt on the attempt record, then require the same
  values for future posting exchanges.

Tests:

- Unknown dispatch id is rejected.
- Dispatch id for another repository is rejected.
- Nonce replay from another run is rejected.
- Nonce replay from the same run but wrong purpose is rejected.
- Self-hosted runners are rejected unless a future explicit safe policy exists.
- Disabled feature flag rejects config exchange.
- Repository unselected after dispatch rejects config exchange.
- Workflow capability drift rejects config exchange.
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
- Never build shell commands by interpolating branch names, file names, PR
  numbers, dispatch ids, or raw client payload.
- Do not run package scripts, generators, tests, or builds before provider
  isolation is in place.
- If git commands are required, use fixed argument arrays or checked-out action
  inputs, not shell strings.
- Disable Git credential helper and remove any ambient token after checkout.
- Do not fetch more history than needed unless diff construction explicitly
  requires it and the bound is documented.
- Treat checkout failure as degraded runtime failure, not as permission to post
  normal review output.

Tests:

- Generated workflow or runtime script checks out expected head SHA.
- Conflict mode rejects mutable ref checkout.
- Conflict mode does not persist credentials.
- Conflict mode does not use cache keys from branch names or PR numbers.
- Shell command tests prove branch/path payload is never interpolated.
- Ambient GitHub token is absent from post-checkout provider env.
- Checkout failure records safe health without raw secrets.

### Phase 3.1: Runtime Filesystem And Process Policy

Conflict runtime should not let repository-controlled files influence runtime
control data. The checked-out PR head is review input, not a trusted execution
environment.

Filesystem layout:

```text
workspace/
  repo/                 # checked-out PR head, read-only after checkout
  reviewrouter-tmp/     # runtime-owned temp data outside repo checkout
  reviewrouter-out/     # bounded sanitized outputs, if needed
```

Requirements:

- Store nonce/session metadata, manifests, model output JSON, and checkpoints
  outside the repository checkout.
- Treat the repository checkout as read-only after checkout. Runtime-owned files
  should not be written into the PR tree.
- Disable or ignore repository-local config that can change runtime behavior,
  such as local tool config, hooks, dependency scripts, and generated aliases.
- Do not source `.env`, shell profiles, project scripts, or package manager
  lifecycle hooks from the PR head.
- Spawn subprocesses with argument arrays and explicit working directories.
- Pass model input through bounded files or stdin controlled by the runtime, not
  through shell interpolation.
- Remove temp files that contain prompt/model content before the job finishes
  unless product retention policy explicitly says otherwise.
- If debug artifacts are ever added, they must be disabled by default and must
  run through the data classification policy first.

Process rules:

- No `shell: true` for commands that contain repository data.
- No dependency install or build step is required for v1 conflict review.
- Provider subprocess receives only the provider env allowlist and bounded model
  input.
- Posting subprocess, if any, is separate from provider subprocess and never
  shares its environment.
- Runtime should fail closed if it cannot prove which directory is checkout and
  which directory is runtime-owned temp storage.

Tests:

- Runtime refuses to write manifest/checkpoint files under the PR checkout.
- Repository `.env` and shell profile fixtures are ignored.
- Malicious file path fixture cannot alter command arguments.
- Provider subprocess working directory does not contain posting token files.
- Temp files with prompt/model content are removed or redacted after completion.

### Phase 3.2: Runtime Network Egress Policy

GitHub-hosted runners may not provide hard network egress controls, so the
runtime must enforce egress at the client/code boundary. The goal is to avoid a
hidden path where model/provider code can call GitHub writes or exfiltrate
posting credentials.

Allowed runtime network destinations:

| Destination                | Phase                         | Allowed purpose                                   |
| -------------------------- | ----------------------------- | ------------------------------------------------- |
| ReviewRouter API           | OIDC/config, validation, post | runtime config, health, posting proxy commands    |
| configured provider API    | model phase only              | provider/model execution with provider env only   |
| GitHub read API, if needed | checkout/diff read only       | bounded PR files/state reads, no writes           |
| GitHub write API           | server-side proxy only        | not from runtime/provider process in preferred v1 |

Rules:

- Runtime HTTP clients should be explicit dependencies per phase. Do not expose
  a generic `fetch` wrapper to provider/model/posting code.
- Provider/model subprocesses must not receive ReviewRouter API tokens, GitHub
  tokens, posting session tokens, or OIDC request environment.
- Posting code should call ReviewRouter proxy commands, not GitHub write APIs.
- If runtime must call GitHub read APIs, use a read-only capability and keep
  writes impossible by type/API surface.
- Do not let repository code configure proxy URLs, provider base URLs, GitHub
  API URLs, or ReviewRouter API URLs.
- Block or reject redirects from trusted API hosts to untrusted destinations.
- Network errors from provider calls must not trigger posting retries.
- Network diagnostics must log only host category and safe reason code, not full
  URLs with query strings or headers.

Tests:

- Provider subprocess cannot reach posting proxy with provider env.
- Runtime posting module has no direct GitHub write client; GitHub writes stay
  in the server-side adapter.
- Untrusted provider base URL from repository files is ignored.
- HTTP redirect from token-bearing OIDC/config/posting clients is rejected with
  `redirect: "error"`.
- GitHub write URL fixture is rejected outside server-side proxy adapter.
- Network error fixture does not include headers/tokens in logs.

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
- Normalize file paths as data only. Do not pass model-provided or PR-provided
  file paths to shell commands.
- Handle renamed files explicitly: old path and new path must not collide in
  fingerprints.
- Treat deleted files as summary-only unless line mapping is reliable.
- Use deterministic ordering for files and findings so posting fingerprints are
  stable across retries.
- Include truncation/degradation markers in model context so the model does not
  imply it reviewed omitted content.

Tests:

- Diff builder refuses stale head SHA.
- Diff builder refuses stale base ref.
- Large diff degrades to bounded summary mode.
- Binary files do not produce raw binary prompt content.
- File path validation prevents shell interpolation risks.
- Renamed file fingerprints remain stable.
- Deleted file findings do not create invalid inline comments.
- Re-running diff construction over the same inputs yields the same manifest
  hash.

### Phase 4.1: Prompt Packet Construction

The prompt packet is derived from customer repository content and trusted
runtime policy. It must not become a control channel for posting, status, target
URLs, or retry behavior.

Prompt packet components:

- fixed system/developer instructions owned by ReviewRouter
- conflict-mode advisory semantics
- bounded diff packet
- changed-file metadata
- base/head metadata needed for explanation, not authorization
- explicit truncation/degradation notes
- output schema instructions

Prompt packet must not include:

- raw nonce, OIDC token, GitHub token, posting session token, provider secrets
- installation token or ReviewRouter API token
- full unbounded diff
- full repository tree
- raw workflow `client_payload`
- hidden summary marker metadata used for ownership decisions
- status context, comment id, target URL, or posting operation identifiers that
  could be copied back by the model as authority

Prompt construction rules:

- Build prompt from typed diff/config objects, not raw GitHub payloads.
- Keep trusted policy instructions outside repository-controlled text.
- Delimit repository content clearly so prompt injection can be treated as
  untrusted content.
- Include "head-only/advisory" semantics in the prompt, but enforce those
  semantics in runtime policy even if the model ignores them.
- Include omitted-file/truncation metadata so output cannot imply full coverage.
- Hash the canonical prompt packet metadata for audit, but do not persist full
  prompt content.
- If prompt construction fails or exceeds budget, degrade before model execution
  and do not post review findings.

Tests:

- Raw nonce/token fixtures never appear in prompt packet.
- Repository content that asks to change status context is treated as text only.
- Prompt packet with large diff records truncation metadata.
- Hidden marker metadata is not present in model-visible prompt.
- Prompt packet hash is stable across retry for the same bounded inputs.

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
- Strip or neutralize hidden HTML comments from model text before adding the
  runtime-owned marker.
- Treat model-provided markdown links as untrusted text. The runtime chooses
  target URLs for status/check output.
- Do not let provider failures trigger automatic retries that re-run posting
  phases. Retry model execution and retry posting are separate policies.

Tests:

- Provider env snapshot does not include OIDC or posting secrets.
- Model output with control fields is rejected or sanitized.
- Oversized model output degrades safely.
- Malformed model JSON does not post anything.
- Prompt injection cannot choose status context or comment id.
- Model output with copied ReviewRouter marker cannot influence summary update.
- Model output with `@team` mentions is bounded or sanitized according to policy.

### Phase 5.0.1: Provider Contract And Data Retention

Provider execution touches customer repository content. The provider adapter
must have an explicit contract so conflict fallback does not accidentally widen
data retention, logging, or training behavior.

Provider contract requirements:

- Provider selection comes from the server config snapshot, not repository
  content or model output.
- Provider request includes only the bounded prompt packet and provider-specific
  credentials required for that provider.
- Provider adapter must document whether the provider can retain prompts,
  outputs, metadata, or logs, and this must match existing product policy.
- Provider stderr/stdout are treated as potentially sensitive because they can
  contain prompt or diff content.
- Provider request/response ids may be stored for support only if they do not
  reveal prompt or repository content.
- Provider retries must not change posting manifest identity unless model output
  is regenerated before any posting side effect.
- Provider fallback between models/providers is disabled for v1 unless the
  config snapshot and manifest explicitly record the chosen provider path.
- Provider timeout or rate limit must not cause runtime to post a misleading
  success status.
- Provider adapter must not receive posting session, OIDC, GitHub, or
  ReviewRouter runtime tokens.

Provider output retention:

| Data                    | Runtime handling                          |
| ----------------------- | ----------------------------------------- |
| raw provider response   | transient only unless product policy says |
| validated findings      | used to build manifest, not persisted raw |
| provider request id     | safe if opaque and non-content-bearing    |
| provider stderr         | redacted summary only                     |
| token usage/counts      | safe bounded metadata                     |
| provider retry metadata | safe reason codes and counts              |

Tests:

- Provider adapter fixture with stderr containing prompt text is redacted.
- Provider fallback attempt changes manifest metadata or is disabled.
- Provider timeout cannot produce success advisory status.
- Provider request snapshot excludes all non-provider secrets.
- Provider selection from repository file is ignored.
- Provider response id is logged only if allowlisted as safe metadata.

### Phase 5.1: Model Output Schema

Conflict mode should use a stricter output schema than a free-form review body.
The schema should allow review content, not workflow control.

Allowed top-level fields:

```text
schema_version
summary
findings[]
metadata
```

Allowed finding fields:

```text
stable_id_hint
path
side
start_line
end_line
severity
title
body
confidence
```

Runtime-owned fields that must be rejected or ignored:

```text
status
conclusion
context
target_url
comment_id
marker
token
nonce
retry
approve
request_changes
repository
pull_request_number
head_sha
base_ref
base_sha
dispatch_id
```

Validation rules:

- `schema_version` must match the runtime-supported conflict schema version.
- `path` must match a changed file after runtime normalization.
- `side` must be one of the runtime-supported sides.
- `start_line` and `end_line` must be positive integers and within mapped
  changed-line coordinates before inline posting.
- `severity` is advisory content only and cannot decide status/check conclusion
  without runtime policy.
- `confidence` is advisory content only and must be bounded.
- `title` and `body` have size limits before markdown rendering.
- Unknown top-level fields fail validation in v1.
- Unknown nested finding fields fail validation in v1 unless explicitly placed
  under bounded metadata.

Degradation:

- If the whole output is invalid, post no findings.
- If some findings are invalid, drop invalid findings and record a degraded
  reason only if the remaining output still validates.
- If all inline coordinates are invalid, summary-only is allowed after pre-post
  validation.

Tests:

- Unknown top-level control field rejects output.
- Unknown nested control field rejects output.
- Finding path outside changed files is dropped or invalid.
- Finding with valid summary but invalid inline coordinates becomes summary-only.
- Severity cannot change advisory status/check context or conclusion.

Example valid output:

```json
{
  "schema_version": "conflict-review-findings-v1",
  "summary": "The head-only review found two possible issues.",
  "findings": [
    {
      "stable_id_hint": "input-validation-missing",
      "path": "src/form.ts",
      "side": "RIGHT",
      "start_line": 42,
      "end_line": 42,
      "severity": "medium",
      "title": "Validate the submitted value before use",
      "body": "This path accepts user input without the existing validator.",
      "confidence": 0.78
    }
  ],
  "metadata": {
    "model": "safe-provider-id"
  }
}
```

Example rejected output:

```json
{
  "schema_version": "conflict-review-findings-v1",
  "summary": "Looks good",
  "status": "success",
  "context": "ReviewRouter",
  "target_url": "https://example.invalid",
  "comment_id": 123
}
```

The second example is rejected because model output attempts to control status,
context, target URL, and comment id.

### Phase 5.2: Rendered Markdown Safety

Sanitizing model output is not enough. The rendered GitHub comment/status text
must also be safe, bounded, and clearly advisory after markdown rendering.

Rendering rules:

- Runtime owns the outer template, advisory heading, marker footer, and status
  description.
- Model text can fill only bounded summary/finding slots.
- Strip or neutralize HTML comments before appending runtime-owned marker.
- Strip or escape model-provided marker-like text so it cannot affect future
  ownership parsing.
- Bound code fences, tables, links, headings, images, and nested lists so a
  finding cannot create an unreadable or huge comment.
- Sanitize mentions according to product policy. At minimum, prevent surprise
  mass notifications from model-generated `@org/team` style text.
- Treat links as untrusted. Do not use model-provided links as status/check
  target URLs.
- Do not render raw provider errors, raw GitHub errors, prompt snippets, or diff
  snippets in failure summaries unless an explicit product policy allows it.
- Ensure hidden marker cannot be truncated away. If body size would truncate the
  marker, shorten visible content first.
- Summary body hash must be computed after rendering and sanitization, including
  the final marker.

Rendered output tests:

- Model text containing copied marker does not affect marker parser.
- Model text with HTML comments cannot hide or alter runtime marker.
- Long markdown tables/code fences are truncated safely.
- Mass mention fixtures are escaped or suppressed.
- Summary body near GitHub limit keeps marker intact.
- Status description cannot include model text.
- Rendered body hash is stable across retry.

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
- Verify the global feature flag and rollout policy are still enabled.
- Verify the attempt is still the latest current attempt for this PR/head/base
  semantic key.
- Verify no newer PR synchronize/base-push reconciliation event has superseded
  the attempt.
- If stale, exit without comments and without success status.
- If permission or capability is missing, record degraded health.
- Pre-post validation must run at least twice: once before summary/inline writes
  and once immediately before final advisory status/check.

Tests:

- PR closed during model run produces no comments.
- PR drafted during model run produces no comments.
- PR synchronized during model run produces no comments.
- PR retargeted during model run produces no comments.
- Repository unselected during model run produces no comments.
- Capability removed during model run produces no comments.
- Feature flag disabled during model run produces no comments.
- Newer attempt supersedes older run before posting.

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
- No untrusted field from model output changes the operation set.
- The session purpose is `posting_token` or another explicit posting purpose,
  not the runtime-config purpose.

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
- maximum body sizes
- maximum total GitHub writes
- target URL policy

Forbidden:

- Posting session must not be usable for normal review.
- Posting session must not be accepted for another PR.
- Posting session must not allow arbitrary status context.
- Posting session must not allow arbitrary target URL.
- Posting session must not allow arbitrary comment id.
- Posting session must not be passed to model/provider subprocesses.
- Posting session must not support GraphQL or REST endpoints outside the
  explicit conflict posting operation set.
- Posting session must not be persisted in artifacts, caches, or health payloads.

Tests:

- Posting session for one PR cannot post to another PR.
- Posting session for one head SHA cannot post to another head SHA.
- Posting session cannot choose a normal required context.
- Expired posting session is rejected.
- Posting session cannot update a user-authored comment.
- Posting session cannot post a second summary beyond policy.
- Posting session cannot call a non-posting API.
- Posting session denied after flag disablement.

### Phase 7.1: Posting Proxy Operations

If using a proxy, each operation should be a narrow server-side command, not a
generic "call GitHub" tunnel.

Allowed proxy commands:

| Command                             | Allowed GitHub write                            | Required validation                                       |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `create_or_update_conflict_summary` | issue/PR comment create or update               | summary marker, author identity, comment id, PR/head/base |
| `create_conflict_inline_comment`    | PR review comment or submitted comment review   | file/line coordinate, fingerprint, cap, PR/head/base      |
| `create_conflict_status`            | commit status or check run for advisory context | target head SHA, context, conclusion, target URL policy   |
| `record_conflict_checkpoint`        | ReviewRouter DB only                            | attempt state transition and manifest hash                |

Forbidden proxy commands:

- arbitrary REST path
- arbitrary GraphQL query/mutation
- update any comment by URL
- delete comments
- submit approval or request-changes review
- create normal ReviewRouter status/check
- create workflow dispatch or repository dispatch
- access repository secrets, variables, artifacts, or caches

Proxy design rules:

- Each command validates the posting session scope before touching GitHub.
- Each command validates current attempt state.
- Each command has an idempotency key.
- Each command is safe to retry after network timeout by querying current GitHub
  state first.
- Each command returns only safe ids, hashes, and counts.
- GitHub response bodies are not forwarded verbatim to runtime logs.

Read-before-write algorithms:

Summary:

```text
load attempt checkpoints
if summaryCommentId exists:
  fetch comment by id
  verify author/app identity and marker metadata
  if body hash already matches: return existing
  update comment
else:
  search only trusted bot/app comments with conflict marker
  if exactly one matching owned marker: update it
  if none or ambiguous: create new summary
save summaryCommentId and body hash before returning success
```

Inline:

```text
for each finding fingerprint:
  if fingerprint is already checkpointed: skip
  validate coordinate against current diff mapping
  if invalid: record skipped fingerprint reason
  post comment
  checkpoint fingerprint immediately
stop when cap or secondary rate limit is reached
```

Status:

```text
run final pre-status validation
compute conclusion from runtime policy
post status/check to expected head SHA with fixed context
checkpoint terminal status id/hash
mark attempt completed or degraded
```

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
- summary marker metadata hash
- inline comment coordinate fingerprints
- degraded/truncated flags
- posting session scope hash

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
- Checkpoints must be written server-side. Runtime-local files are not enough
  because retries may run on a different runner.
- Runtime should be able to ask the server for existing checkpoints before
  posting anything.
- Hashes must be computed over canonical normalized content, not over raw model
  output.
- Final advisory status/check is posted only after a fresh validation.
- A retry after summary but before status must reuse/update summary safely.
- A retry after status must not post a duplicate terminal status if the attempt
  is already terminal.

Tests:

- Crash after summary does not create duplicate summary.
- Crash after some inline comments skips already-posted fingerprints.
- Crash after status does not post a second terminal status.
- Retry after stale validation does not post anything new.
- Runtime with empty local workspace can resume from server checkpoints.
- Canonical manifest hash is stable across retry.

### Phase 8.1: Idempotency Retention And Replay Window

Duplicate prevention depends on retaining enough checkpoint and fingerprint data
after the visible GitHub write has happened. Cleanup must not erase the only
proof needed to avoid duplicate summaries, inline comments, or statuses.

Retention rules:

- Attempt identity, summary comment id, summary body hash, status target/context,
  posting manifest hash, and terminal state must outlive the maximum retry,
  rerun, support, and replay window.
- Inline fingerprint records may be compacted after the support window, but only
  into a hash/set representation that still prevents duplicate replay inside the
  replay window.
- Pending posting intents must not be deleted by routine cleanup. They require
  reconciliation, terminal degradation, or explicit operator action.
- Expired posting sessions can be pruned, but their session ids/hashes should
  remain linkable to audit events until the audit window ends.
- Raw secrets and raw content remain non-retained even when idempotency metadata
  is retained.
- Cleanup jobs must be idempotent and must not change attempt terminal state
  without a documented recovery operation.

Replay window policy:

| Data                                | Minimum retention reason          |
| ----------------------------------- | --------------------------------- |
| attempt id and semantic key         | stale/latest-attempt decisions    |
| dispatch id and nonce hash metadata | replay defense and support lookup |
| summary comment id/body hash        | duplicate summary prevention      |
| inline fingerprints                 | duplicate inline prevention       |
| status target/context/id            | duplicate status/check recovery   |
| posting intent pending/completed    | ambiguous write reconciliation    |
| audit event ids                     | support and incident forensics    |

Tests:

- Cleanup cannot delete pending posting intent.
- Compacted inline fingerprints still suppress duplicate replay.
- Expired posting session deletion does not erase audit lookup.
- Attempt after cleanup still prevents duplicate summary inside replay window.
- Cleanup job is safe to run twice.

### Phase 9: Summary Comment

Conflict review summary must be clearly advisory.

Requirements:

- The visible text must say the PR has conflicts and this is a head-only review.
- Do not claim the merge result was reviewed.
- Do not approve or request changes.
- Do not use wording that implies the PR is safe to merge.
- Do not use the normal ReviewRouter summary marker namespace unless the parser
  explicitly distinguishes conflict markers.
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
- If both stored comment id and marker search disagree, prefer stored id only
  when author/app identity and marker metadata validate.
- If stored comment id points to a deleted/missing comment, create a new summary
  and update the checkpoint.

Tests:

- User-authored comment with copied marker is not updated.
- Bot-authored comment with wrong repo id is not updated.
- Bot-authored comment with wrong head SHA is not updated.
- Marker parser rejects malformed metadata.
- Summary body never includes raw nonce or posting token.
- Summary never uses required-review language.
- Deleted stored comment id creates one replacement summary, not repeated
  duplicates.

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
- Do not post inline comments before the summary checkpoint. The summary is the
  recovery anchor.
- Inline findings must include a deterministic fingerprint based on repo id, PR
  number, head SHA, base ref/SHA, normalized file path, side, line range, and
  normalized finding body hash.

Tests:

- Invalid line coordinates degrade to summary-only.
- Secondary rate limit stops inline posting.
- Pending review is never left open.
- Finding for deleted/renamed file does not crash posting.
- Retry after partial inline posting does not repost the same fingerprint.
- Inline comments are skipped when coordinate mapping is ambiguous.

### Phase 10.1: Inline Coordinate Policy

Inline comments are optional. They must never be posted unless the coordinate is
known to refer to the reviewed head/base diff.

Coordinate requirements:

- File path must match a changed file in the bounded diff packet.
- File status must support inline comments for the chosen side.
- Line must map to a changed line accepted by the GitHub API coordinate style in
  use.
- Multi-line comments require both start and end coordinates to map reliably.
- Renamed files use normalized new path for right-side findings and must not
  reuse deleted-path fingerprints.
- Deleted files are summary-only unless the selected GitHub API coordinate style
  is proven to support the location safely.
- Binary files are summary-only.
- Generated or truncated files are summary-only unless the full coordinate range
  is included in the reviewed diff packet.

Coordinate fallback:

| Coordinate state              | Behavior                                           |
| ----------------------------- | -------------------------------------------------- |
| exact changed-line mapping    | inline allowed                                     |
| valid file but uncertain line | summary-only                                       |
| deleted/binary/truncated file | summary-only                                       |
| GitHub rejects coordinate     | checkpoint skipped reason, continue summary/status |
| secondary rate limit          | stop inline phase, mark degraded                   |

Tests:

- Deleted file finding is summary-only.
- Renamed file finding uses new path fingerprint.
- Truncated file finding is summary-only.
- GitHub coordinate rejection does not retry the same invalid inline comment.
- Mixed valid/invalid findings post only valid inline comments and summarize the
  rest.

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
- The advisory context name must be centralized as a constant and tested against
  the normal required context.
- Never let repository settings or model output override the context in v1.
- If a repository has made the advisory context required manually, ReviewRouter
  should still treat it as advisory and document the misconfiguration.

Tests:

- Status posts to expected head SHA.
- Status context cannot be model-controlled.
- Status failure is visible as degraded health.
- Status webhook for conflict context does not enqueue review work.
- Old status on same head SHA does not make a new PR/base attempt current.
- Normal required context name and conflict context name cannot collide.
- Status target URL cannot be model-controlled.

### Phase 11.1: Advisory Conclusion Policy

Status/check conclusion must be computed from trusted runtime phases. Model
severity, number of findings, or prompt text must not directly choose the
conclusion.

Recommended commit status mapping:

| Runtime outcome                          | Commit status state                            | Description intent                                   |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| summary/status posted after valid review | `success`                                      | advisory head-only review completed                  |
| summary posted, inline degraded          | `success` or `failure` only by explicit policy | advisory review completed with limited inline output |
| provider failed before findings          | `failure` or no status by explicit policy      | advisory review could not complete safely            |
| stale before posting                     | no success status                              | old attempt should not look current                  |
| PR closed/draft/fork unsupported         | no success status                              | not reviewable in v1                                 |
| posting session denied                   | no new status                                  | no safe posting authority                            |
| status posting failed                    | no fallback to normal context                  | record degraded health                               |

Rules:

- Never post `success` after stale head/base validation fails.
- Never post normal required context as fallback.
- Never map "no findings" to approval.
- Never map "high severity" to request changes.
- If commit status API supports only limited states, choose conservative
  descriptions and keep the context advisory.
- If check runs are added later, repeat this mapping with check conclusions in a
  new design update.

Tests:

- Stale run cannot post success.
- Provider failure cannot post normal required context.
- Model severity cannot change status context or target SHA.
- No findings still uses advisory wording, not approval wording.
- Status posting failure records degraded health without alternate unsafe write.

## User-facing UX Contract

Conflict fallback must reduce confusion, not create false confidence.

Summary wording requirements:

- Say that the PR currently has merge conflicts.
- Say that ReviewRouter reviewed the PR head, not the merge result.
- Say that findings are advisory until conflicts are resolved.
- Say that normal merge-result review should run after conflicts are resolved.
- Include the reviewed head SHA and base ref.
- Avoid "approved", "blocked", "required", "safe to merge", "merge result", and
  "final review" language.

Suggested summary opening:

```text
ReviewRouter conflict review ran on the PR head because GitHub could not create
a merge result for this PR. This is advisory head-only feedback. Resolve the
conflicts to get the normal ReviewRouter merge-result review.
```

Advisory status/check descriptions:

| State            | Description style                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------- |
| success          | `Advisory head-only conflict review completed`                                           |
| neutral/degraded | `Advisory conflict review completed with limited output`                                 |
| failure/degraded | `Advisory conflict review could not complete safely`                                     |
| stale/skipped    | do not post success/failure status unless policy explicitly chooses a safe skipped state |

Do not expose internal reason codes directly to users. Map them to concise,
safe copy and keep raw diagnostics in health/audit.

UX tests:

- Summary says head-only/advisory.
- Summary never says merge result was reviewed.
- Status/check context is distinct from normal required context.
- Provider failure copy does not reveal prompt, diff, or provider stderr.
- Stale run does not leave a misleading successful status.

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
- phase-specific safe reason code
- whether local runtime, server validation, or GitHub API caused the failure

Do not record:

- raw nonce
- OIDC token
- GitHub App token
- posting token
- full diff
- full prompt
- full model output
- raw secret values
- raw branch names in unbounded/free-form error text
- raw GitHub API response bodies when they may contain comment contents

Tests:

- Error summaries redact nonce.
- Health route rejects oversized payload.
- Health route rejects control fields from model output.
- Health records stale exit without posting.
- Health reason codes are stable and documented.
- GitHub API error bodies are summarized safely.

## Telemetry Cardinality And Privacy Budget

Observability should make incidents easier to diagnose without creating a new
data leak or metrics outage. Every metric and log field needs a cardinality and
privacy decision before production rollout.

Cardinality rules:

- Low-cardinality labels may include phase, safe reason code, runtime protocol
  version, posting operation kind, and rollout stage.
- High-cardinality values such as attempt id, dispatch id, run id, PR number,
  repository id, comment id, status id, and hashes belong in logs/audit, not
  metric labels.
- Raw branch refs, file paths, provider model output, prompt text, error
  messages, and GitHub response bodies must never be metric labels.
- If repository/workspace labels are required for dashboards, use bounded
  internal ids only where the metrics system can handle cardinality, otherwise
  sample or aggregate.
- Alerting should use ratios and reason-code categories, not individual PR ids.

Privacy budget:

| Channel             | Allowed                                      | Forbidden                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------------- |
| metric labels       | phase, reason code, version, operation       | repo content, prompt, branch text, tokens      |
| structured logs     | ids, hashes, counts, phase, safe error class | raw diff, prompt, model output, raw API body   |
| audit trail         | ids, hashes, GitHub ids, policy decisions    | raw secrets and full customer content          |
| support export      | URLs, ids, reason codes, timestamps          | repository snippets unless product policy says |
| dashboard summaries | aggregated counts and rates                  | model text or file-level findings              |

Tests:

- Metric label allowlist rejects attempt id, PR number, file path, and branch
  name labels.
- Log redaction fixture removes token-like, nonce-like, and prompt-like values.
- Support export fixture contains only ids, URLs, hashes, counts, and reason
  codes.
- Alert rule tests use aggregate thresholds, not single PR identifiers.

## Observability And Alerts

Conflict fallback should be observable before production enablement. Logging
only errors is not enough because the most dangerous failures are silent stale
posts, duplicate summaries, and missing advisory status.

Metrics:

| Metric                                        | Type    | Alert condition                                   |
| --------------------------------------------- | ------- | ------------------------------------------------- |
| `conflict_attempt_recorded_count`             | counter | sudden spike by repo/workspace                    |
| `conflict_dispatch_sent_count`                | counter | dispatch sent but started count stays low         |
| `conflict_runtime_started_count`              | counter | started without terminal status after timeout     |
| `conflict_runtime_stale_count`                | counter | unusually high stale ratio after rollout          |
| `conflict_posting_session_denied_count`       | counter | any production spike                              |
| `conflict_summary_posted_count`               | counter | summary posted without status too often           |
| `conflict_inline_degraded_count`              | counter | secondary rate limit or coordinate mapping issues |
| `conflict_status_post_failed_count`           | counter | any sustained non-zero value                      |
| `conflict_duplicate_suppressed_count`         | counter | spike may indicate retry loop                     |
| `conflict_raw_secret_redaction_hit_count`     | counter | any hit requires investigation                    |
| `conflict_workflow_capability_rejected_count` | counter | rollout compatibility issue                       |

Structured log fields:

- attempt id
- dispatch id
- repository id
- PR number
- head SHA short hash only unless policy allows full SHA
- base ref hash or bounded validated base ref
- phase
- reason code
- run id
- run attempt
- elapsed milliseconds
- operation count

Do not log:

- raw nonce
- tokens
- full diff
- full prompt
- full model output
- raw provider stderr if it may include prompt or secrets

Alert runbook:

1. Check whether summaries or statuses are duplicating.
2. If yes, disable rollout immediately.
3. Inspect attempt state and checkpoint hashes.
4. Check recent workflow capability rejections.
5. Check GitHub API permission errors.
6. Do not manually delete comments before determining whether checkpoints point
   to them.
7. Patch retry/idempotency before re-enabling.

## Audit Trail

Conflict fallback must leave enough durable evidence to explain every
user-visible write without storing sensitive review content.

Audit events:

| Event                             | Required fields                                                             |
| --------------------------------- | --------------------------------------------------------------------------- |
| `conflict_attempt_recorded`       | attempt id, repo id, PR number, head SHA hash, base ref hash, base SHA hash |
| `conflict_dispatch_sent`          | attempt id, dispatch id, workflow capability hash                           |
| `conflict_runtime_started`        | attempt id, run id, run attempt, workflow refs                              |
| `conflict_model_completed`        | attempt id, manifest hash, bounded counts, schema version                   |
| `conflict_posting_session_issued` | attempt id, operation scope hash, TTL, manifest hash                        |
| `conflict_summary_posted`         | attempt id, comment id, body hash, marker version                           |
| `conflict_inline_posted`          | attempt id, fingerprint, comment id                                         |
| `conflict_status_posted`          | attempt id, head SHA hash, context, conclusion                              |
| `conflict_attempt_terminal`       | attempt id, final state, reason code                                        |

Audit rules:

- Audit entries must be append-only or otherwise tamper-evident enough for
  support debugging.
- Audit entries must use ids, hashes, and bounded counts instead of full review
  content.
- Audit must distinguish runtime-created writes from manually created comments
  that only contain copied markers.
- Support tooling should be able to answer "why did this PR get this comment?"
  from audit records and GitHub ids.

## Webhook Provenance And Loop Suppression

Conflict fallback creates GitHub comments and statuses, which can trigger more
webhooks. Loop suppression must be based on provenance and durable ids, not
string matching alone.

Provenance fields to capture where available:

- GitHub delivery id
- event name and action
- sender login/id/type
- installation id
- repository id
- PR number
- comment/status/check id
- app/bot author id
- status/check context
- head SHA
- attempt id or marker metadata if present

Loop suppression rules:

- ReviewRouter-authored conflict summary comments must not enqueue normal review
  or conflict review.
- Conflict advisory status/check webhooks must not enqueue normal review or
  conflict review.
- Repository dispatch delivery must not enqueue normal review.
- User edits to a conflict summary should not update attempt authority. They may
  be recorded as support/debug metadata only if safe.
- User-created comments that copy conflict markers are never trusted as owned
  summaries.
- If webhook provenance is incomplete, choose skip/degraded over guessing.
- Delivery id dedupe is useful for webhook retries, but not sufficient for
  semantic idempotency. Attempt/checkpoint identity remains authoritative.
- Loop suppression must not suppress legitimate new normal review after a new PR
  head or mergeable state appears.

Tests:

- Conflict summary comment webhook does not enqueue normal review.
- Conflict status webhook does not enqueue normal review.
- User comment with copied marker does not update summary checkpoint.
- Edited bot summary does not change attempt identity.
- Duplicate delivery id is deduped without suppressing a later distinct event.
- New head synchronize after conflict summary still allows normal review path.

## Incident Forensics And Evidence Preservation

If conflict fallback misbehaves, the first response should preserve evidence
while stopping new writes. Do not destroy the only data that can prove whether a
write was duplicated, stale, or cross-tenant.

Evidence to preserve:

- attempt row and state history
- posting intents and checkpoints
- audit event ids
- GitHub comment/status/check ids
- workflow run id/run attempt and run URL
- workflow capability hash and runtime ref/SHA
- config snapshot id/hash
- posting manifest hash
- safe reason codes and correlation ids
- redacted runtime logs if available

Do not preserve by default:

- raw nonce
- raw OIDC/GitHub/posting/provider tokens
- full diff
- full prompt
- full model output
- raw provider stderr
- raw GitHub response body containing comment content

Forensic rules:

- Disable rollout before collecting optional evidence if unsafe writes may still
  happen.
- Inspect posting intents/checkpoints before editing or hiding GitHub comments.
- If a comment/status exists in GitHub but no checkpoint exists, reconcile and
  record a recovery event before replaying.
- If evidence suggests wrong repository/PR/head write, globally disable first,
  then add a regression fixture before re-enabling.
- Do not run ad hoc SQL updates without an incident note and a follow-up
  migration/test if the update represents a missing product operation.
- Preserve enough metadata to answer support questions without reading raw
  customer content.

Forensic tests:

- Support lookup by comment id finds attempt/audit/checkpoint without raw
  content.
- Missing checkpoint after successful GitHub write can be reconciled safely.
- Incident export redacts token/prompt/diff fixtures.
- Manual DB repair path is replaced by a documented operation or explicit stop
  condition.

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

### Runtime Version Skew

Expected behavior:

- Old runtime versions that do not understand conflict mode fail before checkout.
- Control plane denies config to action versions below the conflict runtime
  minimum.

Risk:

- Generated workflow includes conflict inputs but calls an older runtime that
  treats the event as normal review.

Mitigation:

- Runtime compatibility policy must include a conflict-specific minimum version.
- Workflow capability must include runtime ref/version and conflict marker hash.

### Default Branch Workflow Changes During Run

Expected behavior:

- A run that already started continues only if its OIDC `job_workflow_ref` and
  workflow SHA match the trusted capability recorded for the attempt.
- Posting exchange revalidates capability or accepts only the exact started run
  identity if the workflow file has changed safely.

Risk:

- A workflow file is edited after dispatch to broaden permissions or change
  called runtime behavior.

Mitigation:

- Bind config and posting exchange to OIDC workflow refs/SHAs and capability
  version/hash.

### Installation Permission Revoked During Run

Expected behavior:

- Runtime config or posting exchange fails closed.
- Existing summary is not repeatedly retried if GitHub permissions are gone.

Risk:

- Retry loop causes noisy dead letters or partial posts.

Mitigation:

- Classify permission loss as degraded/non-retryable until installation changes.

### Provider Config Changes During Run

Expected behavior:

- Conflict attempt remains bound to the config snapshot from dispatch/config
  exchange.
- Runtime config exchange rejects snapshot mismatch.
- Posting exchange rejects if snapshot differs from the session.

Risk:

- Review is generated with one provider/prompt policy and posted under another.

Mitigation:

- Snapshot id/hash must be in attempt, session, manifest, and posting scope.

### Large Or Malicious Markdown Output

Expected behavior:

- Runtime bounds text length, strips hidden marker-like comments, and sanitizes
  noisy mentions.
- Oversized output degrades to a concise summary.

Risk:

- Model output creates notification spam, marker spoofing, or unreadable PR
  comments.

Mitigation:

- Strict schema, markdown sanitizer, length caps, and runtime-owned marker.

### GitHub API Partial Outage

Expected behavior:

- Runtime records safe degraded health.
- Retry policy distinguishes read failures before posting from write failures
  after side effects.

Risk:

- A retry after an ambiguous write creates duplicates.

Mitigation:

- After any ambiguous GitHub write error, query by stored id/fingerprint before
  retrying a write.

### Clock Skew And TTL Expiry

Expected behavior:

- Posting session TTL is short but tolerant of small clock skew.
- Expired sessions are retried from pre-post validation, not reused.

Risk:

- Runtime reuses a stale session or fails flaky due to tiny clock differences.

Mitigation:

- Server-side time is authoritative. Runtime treats expiry as retryable only
  before any new GitHub write.

### Concurrent Base Push And Head Push

Expected behavior:

- The current attempt is stale unless both current head and base semantics still
  match the attempt.
- A newer reconciliation or synchronize event owns the next attempt.

Risk:

- Two attempts race and both post summaries.

Mitigation:

- Latest-attempt check in pre-post validation plus summary marker scoped to
  attempt/head/base.

### GitHub Actions Rerun Button

Expected behavior:

- Rerun of the same workflow run must use the same run identity rules and must
  not bypass nonce or attempt validation.
- If the nonce is already bound to the same run id but a later run attempt, the
  policy must explicitly decide whether this is allowed.

Risk:

- A user reruns an old conflict workflow after the PR changed and receives stale
  comments.

Mitigation:

- Include `run_attempt` in nonce binding and require fresh pre-post validation.
- Prefer treating reruns after a newer attempt as stale.

### GitHub Actions Logs Retention

Expected behavior:

- Logs remain safe for their whole retention period.

Risk:

- A value that seemed harmless during runtime becomes sensitive because logs are
  long-lived and downloadable.

Mitigation:

- Mask nonce before any command output.
- Do not print env dumps.
- Do not print raw HTTP request/response bodies.
- Redact provider command lines if they include prompt file paths or config.

### Reusable Workflow Ref Mutable In Development

Expected behavior:

- Production requires immutable runtime refs or explicitly trusted version refs.
- Development may use mutable refs only behind non-production policy.

Risk:

- A mutable `v1` ref changes runtime behavior without capability revalidation.

Mitigation:

- Capability hash must include runtime ref and reusable workflow path.
- Production rollout requires a reviewed runtime release process.

### User Deletes Or Edits Bot Summary

Expected behavior:

- If the stored comment id is deleted, retry creates one replacement summary.
- If a user edits the bot summary and marker remains valid, runtime should
  prefer replacing the body from canonical content only after ownership checks.

Risk:

- User edit breaks marker or causes repeated new summaries.

Mitigation:

- Stored comment id is primary. Marker search is only a fallback and must verify
  author/app identity.

### Provider Timeout After Partial Model Output

Expected behavior:

- Partial output is discarded unless it validates completely.
- Posting does not start from partial output.

Risk:

- Half-generated findings produce misleading comments.

Mitigation:

- Provider runner writes output to a temp location and validator accepts only a
  complete schema-valid result.

### Comment Body Size Limit

Expected behavior:

- Runtime bounds summary and inline body size before requesting posting.
- Oversized content is summarized or truncated with an explicit note.

Risk:

- GitHub rejects the comment after the runtime believes posting started,
  creating ambiguous retry behavior.

Mitigation:

- Enforce conservative size limits before posting and checkpoint rejected
  oversize findings as summary-only.

### Repository Archived Or Actions Disabled

Expected behavior:

- Conflict detection records a skip/degraded reason, not a dispatch loop.
- Runtime config/posting exchange fails closed if repository state changed after
  dispatch.

Risk:

- Repeated retries target a repository that cannot run workflows or accept
  writes.

Mitigation:

- Capability probe and runtime validation include repository archived/actions
  disabled state where GitHub exposes it.

### Branch Protection Requires Advisory Context

Expected behavior:

- ReviewRouter still treats the conflict context as advisory and reports the
  repository misconfiguration.

Risk:

- Users accidentally make `ReviewRouter conflict review` required and then stale
  head-SHA statuses affect merge decisions.

Mitigation:

- Documentation and setup checks warn if the advisory context appears in known
  branch protection/ruleset settings.

### GitHub App Permission Upgrade Pending

Expected behavior:

- If the installation has not accepted required permissions, conflict fallback
  records a degraded/permission reason and posts nothing that requires the
  missing permission.

Risk:

- Runtime repeatedly dispatches but can never post advisory status/comment.

Mitigation:

- Readiness/capability check includes installation permission state before
  dispatch and again before posting.

### Multiple Providers Or Provider Fallback

Expected behavior:

- Provider choice is fixed by the config snapshot.
- Provider fallback cannot change posting policy or status conclusion.

Risk:

- A provider fallback produces output under a different policy than the one
  recorded on the attempt.

Mitigation:

- Config snapshot includes provider routing/fallback policy and output schema.
- Posting manifest records model/provider identity as safe ids, not raw output.

### Runtime File Mutation By Repository Code

Expected behavior:

- Runtime control files, tokens, and manifests are outside paths where repository
  code can modify them.

Risk:

- Checked-out PR code tampers with posting manifest or health payload before
  upload.

Mitigation:

- Store runtime control files in a protected temp directory outside repository
  checkout.
- Validate manifest server-side against session and attempt before posting.

### Runtime Process Killed Mid-step

Expected behavior:

- Server-side checkpoints determine whether retry resumes or exits.
- Runtime-local files are disposable and not the source of truth.

Risk:

- A killed process loses local state after a GitHub write and retries duplicate
  comments.

Mitigation:

- Checkpoint immediately after each confirmed write.
- Reconcile ambiguous writes by GitHub id/fingerprint before retry.

### User Force-pushes Same Head SHA Through Rebase Edge Case

Expected behavior:

- If GitHub reports the same head SHA, attempt identity still includes base ref,
  base SHA semantics, PR number, and config snapshot.

Risk:

- Product logic treats head SHA alone as enough to decide freshness.

Mitigation:

- Never use head SHA alone as source of truth. Use full attempt identity tuple.

### Bot Account Identity Changes

Expected behavior:

- Summary update logic can verify the expected App/bot identity after App slug or
  bot presentation changes.

Risk:

- ReviewRouter fails to update its own old summaries or updates someone else's
  comment.

Mitigation:

- Prefer stored GitHub comment id plus marker metadata.
- Treat author identity mismatch as ambiguous and create a new summary only after
  recording safe health.

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
16. Runtime action version must be conflict-capable before any conflict config is
    returned.
17. Feature flag and repo rollout policy are checked at dispatch, config
    exchange, and posting exchange.
18. Posting checkpoints are server-side and authoritative.
19. GitHub API writes are never retried blindly after ambiguous failures.
20. Any status/check or comment webhook generated by conflict mode is terminal
    metadata and cannot enqueue new review work.
21. Workspace, repository, installation, PR, head, base, dispatch, config
    snapshot, run id, and run attempt are validated together on every privileged
    exchange.
22. Runtime protocol version, workflow capability version, posting manifest
    version, marker version, and model output schema version are explicit.
23. Resource budgets cap dispatch, runtime, model, inline, posting, and retry
    behavior.
24. Audit records can explain every GitHub write using ids and hashes without
    storing raw secrets or full review content.

Invariant enforcement map:

| Invariant class              | Must be enforced in code                         | Must be tested by                                |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| identity binding             | OIDC exchange, attempt repository, posting proxy | wrong workspace/repo/installation/run fixtures   |
| stale prevention             | PR state reader, attempt generation check        | head/base/PR-state mutation tests                |
| token purpose separation     | token issuer/verifier                            | runtime-config vs posting-purpose negative tests |
| no generic GitHub write path | GitHub adapter/proxy                             | import/layer tests plus rejected operation tests |
| model cannot control writes  | model schema validator, manifest builder         | malicious output fixtures                        |
| duplicate prevention         | posting intents and checkpoints                  | post-write crash and ambiguous response tests    |
| advisory separation          | status/comment renderer and policy               | context collision and UX wording tests           |
| data minimization            | health/audit/log serializers                     | raw nonce/token/diff/prompt redaction fixtures   |

For every invariant above, the implementation PR should point to at least one
test. If an invariant has no test, the PR is not ready for production rollout.

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

Permission matrix:

| Capability                   | Needed for v1?              | GitHub/App permission                    | Notes                                            |
| ---------------------------- | --------------------------- | ---------------------------------------- | ------------------------------------------------ |
| create `repository_dispatch` | Yes                         | `contents: write`                        | already expected by current App profile          |
| read PR state/files          | Yes                         | existing PR/repository read capabilities | server-side gateway should use installation auth |
| post summary comment         | Yes                         | existing issues/PR comment capability    | through scoped proxy/session only                |
| post inline PR comments      | Optional v1                 | pull request write/comment capability    | cap and degrade to summary-only                  |
| post commit status           | Yes for advisory visibility | `statuses: write`                        | current manifest smoke expects it                |
| post check run               | No for initial v1           | `checks: write`                          | requires explicit permission/design update       |
| modify required workflow     | No                          | none                                     | required workflow remains unchanged              |
| access repository secrets    | No                          | none                                     | conflict mode must not read or write secrets     |
| upload artifacts/cache       | No                          | none                                     | conflict data should not be stored there         |

If implementation requires a permission not marked "Yes" above, stop and update
the app permission plan before coding.

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

## Local Simulation Harness

Build a local harness before E2E so most dangerous cases can be tested without
waiting on GitHub Actions.

Harness components:

- fake OIDC verifier with configurable claims
- fake conflict attempt repository with compare-and-set state transitions
- fake GitHub PR state gateway
- fake GitHub posting gateway with injected ambiguous write failures
- fake provider runner with valid, invalid, malicious, timeout, and oversized
  outputs
- fake clock for TTL and key rotation tests
- fake feature flag/rollout policy

Harness scenarios:

- valid conflict run through dry-run manifest
- stale head before checkout
- stale base before posting
- feature flag disabled after model output
- duplicate webhook and duplicate dispatch
- crash after summary write response is lost
- secondary rate limit after first inline comment
- user-authored copied marker
- wrong workspace/repository/installation tuple
- old runtime protocol version
- key rotation during posting session

Harness acceptance:

- No scenario requires a real GitHub token.
- No scenario writes files under repository checkout for control data.
- Every fake GitHub write records an idempotency key.
- Every injected ambiguous write has a read-before-write recovery assertion.

## External Assumptions To Re-verify

Before implementing or enabling the runtime, verify current GitHub behavior
against official GitHub documentation or a disposable repository smoke. Do not
depend only on old memory or plan text for these.

Assumptions to verify:

- `repository_dispatch` runs the workflow from the default branch.
- `repository_dispatch` OIDC claims include the expected event, workflow, job
  workflow, repository, run id, and run attempt fields.
- `repository_dispatch.client_payload` size and field limits are compatible with
  the planned payload.
- Commit status API can post the advisory context to the PR head SHA with the
  existing App permissions.
- PR review/comment APIs accept the planned inline coordinate style.
- Secondary rate limit behavior for comment bursts is handled by the posting
  proxy.
- GitHub Actions rerun behavior preserves or changes `run_attempt` as expected.
- App installation permission changes are observable before posting.
- Branch protection/ruleset APIs expose enough information to warn about
  advisory context misuse, or the docs must state the limitation.

Record verification evidence in the implementation PR. If any assumption is
false, update this plan before coding around it.

## Dry-run And Shadow Mode

Before real posting, add a dry-run mode for runtime verification. Dry-run should
exercise every step except GitHub writes.

Dry-run behavior:

- OIDC/config exchange runs normally.
- Exact checkout and diff building run normally.
- Model/provider execution can run with the same isolation policy.
- Pre-post validation runs normally.
- Posting manifest is built and sent to the server for validation.
- Posting session may be requested in a validation-only mode.
- No summary, inline comment, or status/check is written to GitHub.
- Health records `dry_run_completed` with manifest hash and bounded counts.

Shadow mode behavior:

- Conflict attempts can be recorded and dispatched only in internal repos.
- Runtime can compute findings and manifest.
- Runtime must not post user-visible output.
- Shadow output is used only to compare stale detection and runtime correctness.

Dry-run must not become a second product mode with weaker checks. It uses the
same validators and fails for the same reasons as real posting, except the final
GitHub write commands are replaced by validation-only commands.

Promotion from dry-run to posting requires:

- no secret leakage in logs
- no stale runs marked postable
- deterministic manifest hashes across retry
- bounded model output
- passing disposable repo smoke with posting disabled first

## Test Matrix

Unit tests should be organized by failure boundary, not only by happy-path
functions.

| Boundary                | Required cases                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Runtime input parser    | missing inputs, invalid dispatch id, invalid SHA, invalid base ref, conflicting aliases, wrong event/action       |
| OIDC/config exchange    | wrong event, wrong repo id, wrong workflow ref, replay nonce, old runtime version, disabled flag, unselected repo |
| Attempt state machine   | duplicate start, stale transition, terminal state no-op, retry before start, retry after ambiguous write          |
| Checkout planner        | exact SHA, no credentials, no mutable refs, no cache/artifact paths, no branch shell interpolation                |
| Diff builder            | stale head/base, large diff, binary files, renames, deletes, deterministic manifest hash                          |
| Provider runner         | env allowlist, provider failure, timeout, oversized output, malformed JSON                                        |
| Finding validator       | control fields rejected, marker-like text stripped, mention sanitization, line bounds                             |
| Pre-post validator      | closed PR, draft PR, retargeted PR, new head, unselected repo, capability drift, flag disabled                    |
| Posting session         | wrong PR, wrong SHA, wrong context, expired session, unsupported API, user-authored comment                       |
| Summary posting         | marker ownership, deleted comment id, ambiguous marker, no required-review wording                                |
| Inline posting          | coordinate failure, secondary rate limit, duplicate fingerprint, summary-only degradation                         |
| Status/check posting    | context collision, wrong SHA, model-controlled target URL, webhook loop prevention                                |
| Health telemetry        | redaction, stable reason codes, bounded payload, safe GitHub error summary                                        |
| Dry-run/shadow mode     | manifest validates, no GitHub writes, same validators as posting path                                             |
| Migration compatibility | old rows without runtime fields, enum expansion order, rollback with flag off                                     |
| Tenant isolation        | workspace mismatch, repository id mismatch, installation mismatch, repo transfer during run                       |
| Token/key rotation      | wrong purpose, expired token, previous signing key overlap, rotation during active run                            |
| Resource budgets        | base push cap, duplicate webhook burst, retry cap, diff cap, GitHub write cap                                     |
| Protocol compatibility  | older runtime, newer runtime, missing manifest version, unsupported marker version                                |
| Dispatch/nonce          | bounded payload, no secrets, nonce replay, purpose binding, masked logs                                           |
| Workflow rerun          | duplicate starts, run_attempt changes, cancellation, terminal rerun, newer-attempt stale exit                     |
| Path/unicode identity   | traversal, NUL/control chars, case-sensitive paths, symlink/submodule metadata, display escaping                  |
| GitHub API budget       | pagination caps, secondary rate limits, ambiguous write recovery, request budget exhaustion                       |
| Consistency/read source | stale replica, stale cache, cross-region race, primary/CAS proof                                                  |
| Deadline/cancellation   | provider timeout, expired posting session, canceled run, pending intent reconciliation                            |
| Provider contract       | retention policy, redacted stderr, disabled fallback, safe provider metadata                                      |
| Markdown renderer       | marker spoofing, hidden comments, mass mentions, body limit, stable rendered hash                                 |
| Operator tooling        | unauthorized replay, paused repo override, checkpoint repair proof, audited recovery                              |
| Webhook provenance      | delivery dedupe, app/bot actor identity, copied marker, status loop suppression, normal recheck preservation      |
| Idempotency retention   | pending intent cleanup, compacted fingerprints, expired sessions, duplicate replay prevention                     |
| Audit trail             | every write has audit event, audit contains hashes not raw content, support lookup by comment id                  |

Regression tests that must never be removed:

- `repository_dispatch` cannot obtain normal runtime config.
- `workflow_dispatch` cannot select `conflict-head`.
- Generic `/comment-token` rejects `conflict-head`.
- Conflict status/check context cannot equal normal required context.
- User-authored marker spoof does not update a comment.
- Raw nonce never appears in safe error summaries.
- Dry-run cannot skip pre-post validation.
- A runtime rerun after a newer attempt exits stale.
- Workspace/repository/installation mismatch cannot issue posting session.
- Ambiguous GitHub write is retried only after a read confirms missing write.

## Contract Test Strategy

This feature crosses server, workflow, runtime, model adapter, database, and
GitHub adapter boundaries. Unit tests alone are not enough because many bugs are
contract drift bugs between layers.

Contract groups:

| Contract                            | Producer                   | Consumer                    | Must prove                                      |
| ----------------------------------- | -------------------------- | --------------------------- | ----------------------------------------------- |
| dispatch payload                    | conflict-review/outbox     | generated workflow/runtime  | fields are minimal and non-authoritative        |
| OIDC runtime config                 | action-control-plane       | runtime                     | conflict mode cannot receive normal config      |
| runtime config response             | action-control-plane       | checkout/diff/model runtime | no posting token or GitHub token                |
| posting manifest                    | runtime                    | posting proxy               | canonical hash and bounded operations           |
| model output schema                 | provider/model runner      | runtime validator           | findings only, no control fields                |
| posting proxy command               | runtime/posting client     | GitHub adapter              | narrow command, no arbitrary REST/GraphQL       |
| health/audit payload                | runtime/posting proxy      | dashboard/support/audit     | safe ids/hashes/reasons only                    |
| generated workflow capability       | workflow-provisioning      | OIDC/config exchange        | permissions/events/runtime ref match snapshot   |
| database attempt/checkpoint records | conflict-review repository | retry/operator recovery     | idempotent resume and terminal-state absorption |

Contract test rules:

- Store example fixtures for each contract in versioned test data.
- Every protocol/schema version bump updates fixture snapshots.
- Tests should verify both acceptance of the exact supported shape and rejection
  of dangerous near-misses.
- Contract tests must run without real GitHub tokens.
- E2E smoke verifies GitHub behavior, but contract tests must catch local drift
  before a disposable repo run.
- A provider/model fixture cannot update posting contract snapshots directly;
  model output is always transformed by the runtime manifest builder first.

Dangerous near-misses to include:

- valid dispatch id with wrong repository id
- valid runtime session with posting purpose
- valid manifest hash with changed status context
- valid marker body with user author identity
- valid inline finding path with stale head SHA
- valid summary body containing hidden marker from model output
- valid workflow event with broad permissions
- valid protocol version with unsupported marker version

## Test Fixture Catalog

Build fixtures intentionally around the dangerous boundaries so tests are
readable and hard to weaken accidentally.

Identity and authorization fixtures:

- valid internal repository dispatch with expected OIDC claims
- wrong workspace id with otherwise valid repository id
- wrong installation id with same repository full name
- repository transferred/renamed between dispatch and posting
- selected repository becomes unselected after dispatch
- old runtime protocol with new server
- new runtime protocol with old server behavior
- feature flag disabled at config exchange and at posting exchange

PR state fixtures:

- PR open, conflicted, same head/base
- PR closed after model output
- PR draft after model output
- PR synchronized to new head SHA
- PR retargeted to new base ref
- base branch moves while head SHA stays the same
- same head SHA shared by two PRs
- force-push recreates same tree with different commit SHA

Workflow/security fixtures:

- rendered workflow with top-level `write-all`
- rendered workflow with local `run` before preflight
- rendered workflow with dependency cache before preflight
- rendered workflow with `repository_dispatch` attached to required job
- workflow capability hash changes after dispatch
- self-hosted runner label in conflict job
- explicit workflow trying to enable conflict mode

Model output fixtures:

- valid summary and one valid finding
- valid summary with invalid inline coordinates
- malformed JSON
- unknown top-level field
- nested control field such as `comment_id`
- copied ReviewRouter marker in model text
- oversized body
- markdown with noisy mentions
- markdown with hidden HTML comments
- path traversal style file path

Posting fixtures:

- stored summary id belongs to ReviewRouter bot
- stored summary id belongs to user
- marker copied by user comment
- summary create succeeds but response is lost
- inline comment succeeds then secondary rate limit starts
- status create succeeds but checkpoint write fails
- GitHub returns sanitized 403/404/429/5xx
- advisory context equals normal required context
- deleted summary comment before retry

Data-safety fixtures:

- raw nonce marker string in simulated error
- OIDC token-like string in provider stderr
- GitHub token-like string in adapter error response
- prompt/diff content accidentally included in health payload
- raw model output accidentally included in audit payload

Fixture maintenance rules:

- Fixture names should describe the risk, not the implementation detail.
- Malicious fixtures should live in security-focused test folders.
- Do not reduce fixture payloads until the exact historical bug/risk remains
  represented.
- If a production incident happens, add a fixture before changing code.

## Failure Injection Plan

Unit tests cover logic, but runtime safety also needs deliberate fault
injection. Add these before production rollout.

Inject failures at:

- after attempt is recorded but before dispatch
- after dispatch succeeds but before runtime starts
- after OIDC succeeds but before checkout
- after checkout but before diff
- after model output is produced but before validation
- after validation but before posting session
- after posting session is issued but before summary
- after summary write succeeds but response is lost
- after one inline comment succeeds
- after secondary rate limit starts
- after final status succeeds but response is lost
- after feature flag is disabled mid-run

Expected behavior:

- no duplicate summaries
- no duplicate inline comments with same fingerprint
- no normal required context writes
- no posting after stale head/base
- no raw nonce/token in logs or health
- retry either resumes from server checkpoint or exits degraded/stale

Automation:

- Use fake GitHub gateway tests for every injected write failure.
- Use disposable GitHub smoke for at least summary-after-response-loss and
  status-after-response-loss if practical.
- Keep failure injection fixtures small and deterministic.

## Static Analysis And Repo Checks

Add lightweight repository checks where possible. Unit tests are not enough for
security-sensitive string boundaries.

Suggested checks:

- Search generated conflict workflow for `permissions: write-all`, `read-all`,
  top-level write scopes, caches, artifacts, local `run` steps before preflight,
  and mutable concurrency groups.
- Search runtime code for direct uses of `GITHUB_TOKEN` in conflict mode.
- Search provider env allowlist tests for `ACTIONS_ID_TOKEN_REQUEST_URL`,
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `GITHUB_TOKEN`, `conflict_dispatch_nonce`,
  and posting token names.
- Search posting code for normal required context string and fail if conflict
  posting can use it.
- Search logs/health tests for raw nonce fixture value.
- Search shell command construction for branch/path interpolation.
- Search database writes for raw nonce, raw token, full prompt, or full diff
  fields in conflict attempt records.
- Search generated workflow/runtime logs for `env` dumps or raw HTTP body dumps.

These checks should run in CI before enabling the feature. They are cheap and
catch classes of mistakes that code review can miss.

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
17. Disable the feature flag while a run is between model and posting and confirm
    no new GitHub write happens.
18. Force a provider failure and confirm only safe degraded health/output appears.
19. Delete the stored summary comment and confirm one replacement summary is
    created on retry.

E2E pass criteria:

- No normal required context is posted by conflict mode.
- No duplicate summary appears after retry.
- No raw nonce appears in logs, health, or comments.
- Old attempts become stale after head/base changes.
- Feature can be disabled by flag without leaving stuck jobs.
- Conflict workflow logs do not contain raw nonce, OIDC token, GitHub token, or
  posting session token.
- Summary text clearly states head-only conflict review and never claims merge
  result review.
- Repeated smoke runs reuse the disposable repository and clean up test PRs.
- Cross-tenant or wrong-installation attempts are rejected in API-level smoke
  tests with no GitHub writes.
- Runtime version skew smoke proves old runtime exits before checkout.
- Feature flag disabled mid-run prevents posting even after model completed.

E2E must capture these artifacts for review:

- workflow run URL
- attempt id and dispatch id
- final attempt state
- summary comment URL
- advisory status/check URL or API response id
- redacted logs proving nonce/token masking
- exact head SHA and base ref reviewed
- manifest hash and posting checkpoint sequence
- audit event ids for each GitHub write
- rollback/disablement result for the smoke repository

## Rollout Plan

### Stage 0: Code merged, flag off

- Runtime code is present.
- Production behavior unchanged.
- Monitoring dashboards include conflict attempt and degraded health counts.
- Control plane still rejects conflict posting session because rollout is off.
- Existing normal review and merge-group behavior is unchanged.

Exit criteria:

- Normal review tests pass.
- Generated workflow tests pass with feature off and on.
- API rejects conflict posting session while rollout is off.
- Dashboard/readiness does not tell users conflict fallback is enabled.

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
- Keep a rollback checklist next to the smoke result.
- Do not proceed if any raw secret or nonce appears in logs.

Exit criteria:

- At least one successful advisory summary/status smoke.
- At least one stale-before-post smoke.
- At least one duplicate/retry smoke.
- No raw nonce/token in logs.
- Rollback tested on the disposable repo.

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
- Track user-visible noise:
  - repeated summaries per PR
  - comments on closed/draft PRs
  - status/check churn on shared head SHAs
  - stale conflict summaries after normal review resumes

Exit criteria:

- No wrong-repo/wrong-PR/wrong-SHA writes.
- Duplicate suppression stays below rollback threshold.
- Most degraded outcomes have known reason codes.
- Support wording is not causing repeated confusion.
- Provider/runtime cost remains within budget.

### Stage 3: Production default

Only after:

- No unsafe posting incidents in beta.
- No duplicate comment incidents in beta.
- No unsupported workflow false positives at meaningful scale.
- Runbooks exist for disabling the flag and replaying dead-letter attempts.
- Support has a clear explanation for advisory conflict review semantics.
- Documentation says the conflict context must not be configured as required.

## Post-launch Monitoring Window

For the first production rollout window, monitor the feature as an active
incident-risk surface, not as ordinary background work.

First 24 hours:

- Check duplicate summary count every rollout batch.
- Check stale-after-posting reports.
- Check conflict status/check context collisions.
- Check posting session denied spikes.
- Check GitHub secondary rate-limit responses.
- Check support tickets mentioning confusing conflict review wording.
- Keep rollout below the configured repo/workspace cap.

First 7 days:

- Compare conflict attempts to normal review rechecks after conflicts resolve.
- Review top degraded reason codes.
- Review repositories with repeated capability rejection.
- Review cost/provider runtime usage for conflict runs.
- Review manual recovery events and update runbooks.

Rollback thresholds:

- any confirmed wrong PR/repository/comment/status write
- any raw token/nonce leak
- duplicate summaries above agreed threshold
- conflict context accidentally used as normal required context
- unbounded dispatch/provider/posting load
- stale run posts after head/base change

If a rollback threshold is hit, disable rollout first and debug from audit ids
and checkpoints. Do not delete attempts as part of the first response.

## Canary Abort Decision Tree

Rollout should have pre-agreed actions. During canary, do not debate severity
while unsafe writes may still be happening.

Immediate global disable:

- confirmed write to wrong repository, PR, head SHA, comment, or status context
- raw nonce, OIDC token, GitHub token, posting token, prompt, or diff leaked to
  logs/comments/health/audit
- conflict mode can obtain normal required review config or normal comment token
- posting proxy exposes a generic GitHub API tunnel
- stale run posts after head/base change

Immediate repo/workspace pause:

- duplicate summaries above threshold in one repository
- repeated secondary rate limits from inline comments
- repeated ambiguous GitHub writes that cannot be reconciled automatically
- repeated workflow capability drift for a specific repository
- repository rules appear to require the advisory conflict context

Keep running but reduce scope:

- provider timeouts increase but no writes are unsafe
- large diffs frequently degrade to summary-only
- inline coordinate failures rise but summaries/statuses remain correct
- support confusion is limited to wording and no branch protection misuse exists

Debug order after abort:

1. Disable global or repo rollout according to the category above.
2. Confirm config and posting endpoints deny new conflict sessions.
3. Confirm outbox stops new conflict dispatches.
4. Inspect audit ids and posting intents before GitHub UI state.
5. Reconcile any pending intents through read-before-write logic.
6. Add or update a fixture reproducing the unsafe behavior.
7. Fix and verify locally.
8. Re-run disposable repo smoke before resuming canary.

Do not resume canary from "looks fixed" evidence. Resume only from tests plus
one clean disposable E2E smoke that covers the abort category.

## Cost And Abuse Controls

Conflict fallback can add provider/runtime cost because base branch pushes can
affect many PRs. Cost controls are part of correctness because cost spikes often
lead to emergency changes that weaken safety.

Controls:

- Per-repository cap on conflict attempts per hour.
- Per-workspace cap on conflict runtime minutes per day.
- Per-attempt cap on diff bytes and provider input tokens.
- Per-attempt cap on findings and inline comments.
- Cooldown for repositories with repeated provider failures.
- Dry-run-only mode for repositories with repeated posting/capability failures.
- Separate metrics for skipped due to budget vs stale vs failed.

Abuse scenarios:

- A user repeatedly force-pushes a conflicted branch to trigger provider runs.
- A base branch receives many pushes and scans too many open PRs.
- A malicious PR creates huge diffs or many renamed files.
- Duplicate webhook deliveries attempt to multiply dispatches.

Required behavior:

- Budget exhaustion posts no misleading success.
- Budget exhaustion records safe degraded/skipped reason.
- Budget exhaustion does not block normal review after conflicts resolve.
- Budget exhaustion is visible in operational metrics.

Rollback plan:

1. Disable repo/workspace rollout first.
2. Disable global feature flag.
3. Confirm no new conflict attempts are recorded.
4. Confirm outbox stops sending conflict `repository_dispatch`.
5. Confirm started runs fail closed at config/posting exchange.
6. Leave generated workflows in place unless a separate cleanup is needed.
7. Do not delete attempt records. They are needed for duplicate prevention and
   audit.

## Manual Recovery Runbooks

Manual operations must preserve auditability and idempotency. Avoid ad hoc DB
edits unless there is a documented operation for them.

## Operator Tool Authorization

Manual recovery is a privileged product surface. It must not become a hidden
path that bypasses the same tenant, rollout, stale-state, and idempotency rules
used by automated runtime flows.

Operator authorization rules:

- Every operator action requires authenticated actor identity and authorization
  for the workspace/repository scope.
- Actions that can cause GitHub writes, replay attempts, or alter checkpoints
  require a purpose-specific operation, not direct SQL or generic admin API.
- Replay, checkpoint reconciliation, comment repair, and rollout override must
  write audit events with actor, reason, before/after state, and correlation id.
- Operator tools must re-run the same tenant/repository/installation checks as
  runtime endpoints.
- Operator tools must re-check current PR head/base and rollout state unless the
  operation is an explicit audited disable/pause.
- Operator tools cannot issue broad GitHub tokens to the browser, CLI, or
  support UI.
- A paused repository cannot be replayed unless a dedicated audited override is
  present and the operation still passes freshness/idempotency checks.
- Read-only support views may use replicas, but write/replay operations must use
  primary/strongly consistent state.
- Operator notes must not contain raw tokens, full diff, prompt, or model
  output.

High-risk operator actions:

| Action                       | Required protection                                      |
| ---------------------------- | -------------------------------------------------------- |
| replay dead-letter attempt   | checkpoint reconciliation, freshness check, audit reason |
| mark attempt stale/terminal  | CAS transition and terminal-state audit                  |
| repair missing checkpoint    | GitHub read-before-write proof                           |
| pause repo/workspace rollout | actor/reason audit and immediate posting denial          |
| override pause for replay    | explicit scoped override plus audit                      |
| hide/mark duplicate summary  | preserve comment ids and attempt evidence first          |

Tests:

- Unauthorized operator cannot replay, pause, or repair checkpoints.
- Replay from support UI still rejects stale head/base.
- Paused repository replay requires explicit audited override.
- Operator checkpoint repair cannot invent a GitHub comment id without
  read-before-write proof.
- Operator audit export redacts token/prompt/diff fixtures.

### Pause A Repository

1. Disable repository rollout for conflict fallback.
2. Confirm no new attempts are recorded for that repository.
3. Let already-started runs fail closed at config/posting exchange.
4. Do not delete workflow files during incident response.
5. Record the pause reason in support/audit notes.

### Replay A Dead-letter Attempt

Allowed only when:

- no GitHub writes escaped, or
- checkpoints prove exactly which writes escaped and retry is idempotent.

Steps:

1. Inspect attempt state and checkpoints.
2. Verify current PR head/base still match the attempt.
3. If stale, do not replay. Record stale reason.
4. If no writes escaped, create a new dispatch id and nonce.
5. If writes escaped, replay only through checkpoint-aware posting path.
6. Record operator, reason, and resulting attempt state.

### Handle Duplicate Summary

1. Do not delete comments immediately.
2. Identify which comments match stored ids and verified markers.
3. Update attempt checkpoints if a write succeeded but checkpoint was missing.
4. Hide or mark duplicate only after preserving audit trail.
5. Add a regression test for the duplicate path before re-enabling rollout.

### Handle Wrong Advisory Context Required By User

1. Do not change ReviewRouter behavior to satisfy that required context.
2. Notify/document that the context is advisory and should not be required.
3. Keep normal required ReviewRouter context separate.
4. Add setup/readiness warning if this is detectable.

### Emergency Disable

1. Disable global feature flag.
2. Disable repo/workspace rollout.
3. Stop/restart worker only if outbox continues dispatching unexpectedly.
4. Confirm config/posting endpoints deny conflict sessions.
5. Monitor for started runs trying to post after disablement.

## Cleanup And Deprecation

If conflict fallback is disabled long-term or replaced by a safer approach,
cleanup must preserve audit and duplicate prevention.

Rules:

- Do not delete attempt records as part of routine cleanup.
- Do not delete user workflow files automatically during rollback.
- Do not remove marker parsers for old summaries until old summaries are outside
  the retention/support window.
- Do not remove old protocol rejection tests when adding a new protocol.
- Do not reuse old advisory status context for a different meaning.
- If a new context is introduced, document migration and keep old context
  advisory.

Cleanup jobs:

- May prune expired nonce/session hashes after they are no longer needed for
  replay defense.
- May compact posted inline fingerprint child records into hashes only after
  support/audit window.
- May archive old attempts but must keep enough ids/hashes to explain GitHub
  writes.

Deprecation tests:

- Old summary marker remains parseable or safely ignored.
- Old runtime protocol is rejected safely.
- Archived attempts still prevent duplicate replay inside the retention window.

## PR Sequencing

Do not implement all remaining runtime work in one PR. The highest-risk bug
class is mixing checkout/model/posting before the trust boundaries are reviewed.

Recommended sequence:

| PR  | Content                                                                                 | Exit criteria                                                    |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Runtime mode parser, event/action checks, nonce masking, OIDC preflight before checkout | conflict mode cannot reach checkout without valid config session |
| 2   | Exact checkout planner and PR state validator                                           | stale head/base exits before model execution                     |
| 3   | Bounded diff builder and provider env allowlist                                         | model sees bounded diff and no posting/OIDC secrets              |
| 4   | Model output schema and finding validator                                               | model cannot control posting/status/comment ids                  |
| 5   | Posting session/proxy API without real GitHub writes                                    | scope tests prove one PR/head/base/context/session               |
| 6   | Summary posting with marker ownership and checkpoints                                   | retry after summary is idempotent                                |
| 7   | Inline comments with caps and degradation                                               | bad coordinates/rate limit degrade safely                        |
| 8   | Advisory status/check and webhook loop prevention                                       | conflict output is visible and never required-context            |
| 9   | Disposable GitHub E2E smoke and rollout docs                                            | production enablement gates are evidence-backed                  |

Stop after any PR if a boundary becomes unclear. Do not paper over uncertainty by
adding another flag inside the same unsafe path.

## Defaults To Avoid Ambiguity

Use these defaults unless a future design review explicitly changes them:

| Decision                        | Default                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Advisory output type            | commit status first, check run only if `checks: write` is intentionally added |
| Summary channel                 | issue/PR summary comment with conflict marker                                 |
| Inline channel                  | bounded individual comments or submitted `COMMENT` review only                |
| Required context behavior       | never use normal required context                                             |
| Fork PR behavior                | skip in v1                                                                    |
| Explicit workflow behavior      | unsupported/fail-closed in v1                                                 |
| Self-hosted runner behavior     | unsupported/fail-closed in v1                                                 |
| Raw App token fallback          | disabled, do not implement unless proxy/session is impossible                 |
| Base movement behavior          | stale unless current base semantics still match the attempt                   |
| GitHub ambiguous write behavior | read-before-write retry only                                                  |
| Large diff behavior             | bounded summary/degraded, no unbounded prompt                                 |
| Invalid inline coordinates      | summary-only degradation                                                      |
| Provider malformed output       | no comments from malformed output                                             |
| Feature flag disabled mid-run   | config/posting exchange fail closed                                           |
| Token key rotation              | active run exits degraded unless previous-key overlap validates safely        |
| Repository transfer mid-run     | posting fails closed until fresh attempt                                      |
| GitHub API timeout after write  | read-before-write retry only                                                  |
| Runtime temp files              | outside checkout, never under repository-controlled paths                     |
| Read source for posting auth    | primary/strongly consistent DB plus fresh GitHub state                        |
| Runtime deadlines               | phase-specific deadlines, expired sessions fail closed                        |
| Provider fallback               | disabled unless manifest/config snapshot records it explicitly                |
| Markdown rendering              | runtime-owned template, model text only in bounded sanitized slots            |
| Dispatch nonce                  | server-generated, hash-only storage, one attempt/run/purpose                  |
| Workflow concurrency            | deterministic bounded group, no user-controlled strings                       |
| Path identity                   | validated repository-relative path, preserve case, escape display             |
| Operator recovery               | scoped audited operations, no direct SQL or broad token handoff               |
| GitHub pagination/rate limits   | capped pages and budgets, degrade instead of unbounded reads/retries          |
| Webhook loop suppression        | provenance and durable ids, not marker string alone                           |
| Idempotency retention           | keep duplicate-prevention metadata through retry/replay/support window        |
| Audit content                   | ids, hashes, counts, no full diff/prompt/output                               |

Any implementation that changes one of these defaults must update this document,
tests, and rollout notes in the same PR.

## Evidence Required Per PR

Every PR in the sequence should include concrete evidence, not just code.

Required evidence:

- targeted unit test names and what risk they cover
- local command output summary
- before/after workflow snippet if workflow generation changed
- example safe error payload if error handling changed
- proof that raw nonce fixture is redacted if touching runtime logs/health
- proof that normal review tests still pass if touching shared action code
- migration compatibility note if database schema changed
- rollback behavior note if feature flag handling changed
- protocol/version compatibility note if runtime/config/posting schema changed
- resource budget impact if dispatch, diff, provider, or posting limits changed
- audit/observability changes if GitHub writes changed
- consistency/read-source note if touching posting/config authority
- operator tooling authorization note if touching recovery/runbook flows
- rendered output fixture if touching summary, inline, or status text

For posting PRs, include:

- idempotency key examples
- checkpoint transition examples
- duplicate suppression test
- ambiguous GitHub write retry test
- marker ownership spoof test
- status context collision test

Implementation PR description template:

```text
Risk area:
Plan sections touched:
Trust boundary changed:
New source-of-truth fields:
New or changed token purpose:
State transitions added:
GitHub writes added:
Idempotency key:
Failure injection covered:
Normal review regression covered:
Feature flag/rollback behavior:
External GitHub assumption verified:
```

Do not accept "not applicable" for trust boundary, rollback, or normal review
regression without a short explanation.

## Production Evidence Pack

Before production enablement, collect one reviewable evidence pack. The goal is
to make the launch decision auditable without asking reviewers to reconstruct
state from scattered logs.

Evidence pack contents:

- implementation PR links in rollout order
- commit SHA and deployed server/runtime versions
- generated workflow file path, runtime ref/SHA, and capability hash
- feature flag and repo rollout configuration snapshot
- disposable E2E run URLs and PR URLs
- redacted workflow logs showing nonce/token masking
- attempt id, dispatch id, run id, run attempt, and final state
- posting manifest hash and posting checkpoint sequence
- summary comment URL and advisory status/check URL
- audit event ids for summary, inline, status, and terminal attempt
- normal review regression test summary
- security/trust-boundary review signoff
- support/runbook link
- rollback drill result
- production readiness scorecard

Evidence pack rules:

- Do not include raw nonce, tokens, full diff, full prompt, full model output, or
  raw provider stderr.
- Every GitHub URL in the pack must map back to audit ids and attempt ids.
- If a smoke run failed and was fixed, include the failed reason code and the
  fixture/test added for it.
- The pack must state explicitly whether the rollout is dry-run, internal
  posting, limited beta, or production default.
- The pack must identify any external GitHub assumption that was verified by
  docs instead of smoke.

## Production Readiness Scorecard

Before production enablement, score the implementation against the areas below.
Anything below the threshold blocks rollout even if the happy-path demo works.

| Area                        | Minimum score | How to score 10/10                                     |
| --------------------------- | ------------: | ------------------------------------------------------ |
| identity/tenant isolation   |          9/10 | wrong workspace/repo/installation cannot start or post |
| stale-state prevention      |          9/10 | every TOCTOU guard has tests and failure injection     |
| posting idempotency         |          9/10 | post-write crash paths reconcile without duplicates    |
| normal review isolation     |          9/10 | regression matrix passes and shared paths stay typed   |
| token purpose separation    |          9/10 | runtime/posting/GitHub/provider secrets cannot mix     |
| workflow security           |          9/10 | rendered YAML and capability analyzer block bypasses   |
| runtime supply chain        |          8/10 | pinned release, version evidence, mixed-version tests  |
| data minimization           |          9/10 | no raw secrets/content in logs, DB, health, audit      |
| GitHub adapter narrowness   |          9/10 | no generic API tunnel and adapter contract tests pass  |
| rollout/rollback operations |          8/10 | canary abort tree tested and flags stop active writes  |
| external GitHub assumptions |          8/10 | disposable smoke or official-doc verification attached |
| support/user-facing clarity |          8/10 | advisory wording tested and branch protection warning  |
| consistency/read sources    |          9/10 | privileged decisions use strong reads or CAS proof     |
| deadline/cancellation       |          8/10 | expired/canceled phases fail closed or reconcile       |
| provider data contract      |          8/10 | retention, stderr, fallback, metadata are policy-bound |
| rendered markdown safety    |          8/10 | marker spoofing, mentions, limits are tested           |
| operator tooling safety     |          8/10 | recovery tools are scoped, audited, and idempotent     |
| evidence pack completeness  |          8/10 | launch evidence is linked and redacted                 |
| GitHub API resilience       |          8/10 | capped pagination, budgets, rate-limit handling tested |
| webhook loop suppression    |          8/10 | provenance prevents loops without blocking rechecks    |
| idempotency retention       |          9/10 | cleanup preserves duplicate-prevention metadata        |

Scoring rules:

- Scores are engineering confidence, not product optimism.
- A score needs evidence: tests, smoke artifacts, code references, or runbook
  entries.
- Any wrong-repo, wrong-PR, wrong-SHA, token leak, or normal-context write is an
  automatic 0/10 for the relevant area until fixed and fixture-covered.
- Do not average scores to justify rollout. A single below-threshold critical
  area blocks enablement.

## Code Review Checklist

Every runtime PR must answer these questions:

- What untrusted inputs enter this code path?
- Which durable record is the authority for each decision?
- What happens if the PR head changes after this line?
- What happens if the base branch moves after this line?
- What happens if GitHub write succeeds but the response is lost?
- Can this code path post to normal required ReviewRouter context?
- Can model output influence status, target URL, marker, or comment id?
- Can provider/model subprocess read OIDC, GitHub, nonce, or posting secrets?
- Is every retry idempotent after the last possible side effect?
- Is every logged error safe for a customer-visible support export?
- Does turning the feature flag off stop this path before any new GitHub write?

## Forbidden Shortcuts

These shortcuts are explicitly rejected for v1, even if they make the first demo
work faster:

- Reusing normal `/comment-token` for conflict posting.
- Passing `GITHUB_TOKEN`, App tokens, OIDC request token, nonce, or posting
  session into provider/model subprocesses.
- Treating `repository_dispatch.client_payload` as authority.
- Using `github.sha` as the reviewed commit in conflict mode.
- Posting to the normal required ReviewRouter context.
- Updating comments by marker string without author/app identity validation.
- Retrying GitHub writes without first checking whether the write already
  happened.
- Building shell commands with branch names, file paths, dispatch ids, PR
  numbers, or model output.
- Storing full diff, full prompt, raw model output, raw nonce, or tokens in
  attempt records.
- Adding a catch-all GitHub proxy endpoint.
- Letting a model field choose status/check context, target URL, conclusion, or
  comment id.
- Making conflict status required to compensate for missing normal review.
- Enabling forks, explicit workflows, or self-hosted runners without a new
  design review.

If a PR uses any shortcut above, block the PR.

## Implementation Checklist

Runtime contract:

- [x] Add explicit `conflict-head` runtime mode.
- [x] Reject conflict mode from non-`repository_dispatch` events.
- [x] Reject conflict mode from wrong `repository_dispatch` action.
- [x] Keep repository dispatch payload minimal, bounded, and non-authoritative.
- [x] Validate all conflict inputs.
- [x] Parse raw payloads into typed boundary objects before business logic.
- [x] Reject unknown enum values instead of defaulting to normal review.
- [x] Reject conflicting snake_case/camelCase aliases.
- [x] Mask nonce before any logs.
      Note: nonce-like strings are also blocked from runtime safe error codes,
      CLI terminal errors, shared safe payloads, and ambiguous posting summaries.
- [x] Generate nonce server-side, store only hash, and bind nonce to one
      attempt/run/purpose.
- [x] Return conflict metadata from server state, not raw payload.
- [x] Enforce conflict minimum runtime version.

OIDC and config:

- [x] Use ReviewRouter-specific OIDC audience.
- [x] Validate run identity and workflow refs.
- [x] Bind nonce to run identity.
- [x] Bind run id and run attempt with compare-and-set semantics.
- [ ] Use primary/strongly consistent reads for config and posting authority.
- [x] Keep config exchange and posting exchange as separate purposes.
- [x] Reject self-hosted runners in v1.
- [x] Re-check feature flag and repo rollout policy at config exchange.
- [ ] Re-check workflow capability version/hash at config exchange.
- [x] Store run id and run attempt on successful start.
- [x] Validate runtime ref/SHA and protocol support through capability snapshot.

Checkout and diff:

- [x] Checkout exact expected head SHA.
- [x] Disable persisted credentials.
- [x] Disable caches/artifacts for conflict data.
- [x] Validate PR state before checkout.
- [x] Build bounded diff against expected base.
- [x] Exit stale if base/head changed.
- [x] Prove branch names, paths, PR numbers, and dispatch ids are not shell
      interpolated.
- [x] Validate repository paths for traversal, control characters, symlinks,
      submodules, case collisions, and display escaping.
      Note: Git diff execution also uses literal pathspec mode and revalidates
      name-status paths before per-file binary diff calls.
- [x] Add deterministic diff ordering and manifest hash.
- [x] Handle binary, deleted, and renamed files explicitly.
- [x] Keep runtime-owned temp files outside the PR checkout.
- [x] Reject repository-local env/config/hooks from changing runtime behavior.
- [x] Enforce runtime network egress by phase-specific clients and no generic
      GitHub write client in runtime.
      Note: action-control-plane clients use fixed endpoints and reject unsafe
      endpoint path shapes, encoded traversal, protocol-relative paths, query
      strings, fragments, and same-origin mismatches.
- [x] Build prompt packets from typed bounded objects, not raw payloads.
- [x] Exclude secrets, hidden markers, posting identifiers, and unbounded diff
      content from prompt packets.
- [x] Enforce phase-specific deadlines and cancellation behavior.
- [x] Remove or redact prompt/model temp files before job completion.

Model isolation:

- [x] Add provider env allowlist for the v1 single Codex-backed conflict
      provider mode.
- [x] Exclude OIDC, GitHub, nonce, and posting secrets from the provider
      subprocess environment.
- [x] Fail closed before checkout/provider execution for non-Codex and
      multi-provider conflict configs.
- [ ] Document provider data retention and request/response metadata policy.
- [x] Validate model output schema.
- [x] Strip or reject model control fields.
- [x] Bound findings and summary sizes.
- [x] Strip marker-like hidden comments from model text.
- [x] Sanitize or bound noisy mentions.
- [x] Render markdown through runtime-owned templates with bounded sanitized
      model slots.

Posting:

- [x] Add conflict posting session/proxy.
- [x] Scope posting to repository, PR, head SHA, base ref, base SHA, and fixed
      advisory context. Summary ownership is marker-based; runtime does not pass
      arbitrary comment ids.
- [x] Add pre-post validation before session issuance.
- [x] Re-check feature flag and repo rollout policy before session issuance.
- [x] Add pre-status validation before final advisory status.
- [x] Add summary marker parser and ownership checks.
- [x] Add inline comment cap and summary-only degradation.
      Note: v1 remains summary-only. Inline comment posting is intentionally not
      implemented, so uncertain coordinates cannot create inline comments.
- [x] Add advisory status/check posting.
- [x] Add posting checkpoints.
- [x] Add two-step posting intent/commit lifecycle.
- [x] Store checkpoints server-side and make retry resume from them.
- [x] Handle ambiguous GitHub write failures by read-before-write retry.
- [x] Route all GitHub writes through narrow conflict adapter/proxy ports.
- [x] Reject arbitrary REST, GraphQL, target URL, context, target SHA, and
      comment id inputs.
- [ ] Enforce GitHub adapter pagination caps, request budgets, and secondary
      rate-limit degradation.
      Partial: summary/status lookups are capped and exhausted summary marker
      search fails closed instead of creating a duplicate; secondary rate-limit
      degradation and full per-operation budgets still need external evidence.
- [ ] Retain idempotency/checkpoint metadata through the replay/support window.

Webhook loop prevention:

- [x] Ignore conflict advisory status/check webhook as review trigger.
      Covered by generated workflow triggers not subscribing to status/check
      events for review execution.
- [x] Ignore ReviewRouter-authored conflict summary comment as interaction
      trigger.
      Note: generated interaction suppression now requires the conflict marker
      plus a bot actor, so user-copied marker text does not suppress `/rr`.
- [x] Ignore repository_dispatch webhook as review trigger.
- [ ] Capture webhook provenance and suppress loops by durable ids, actor/app
      identity, context, and marker metadata.

Tests:

- [ ] Unit tests for all runtime mode validation.
- [x] Unit tests for posting session scope.
- [x] Unit tests for pre-post stale exits.
- [x] Unit tests for marker ownership.
- [x] Unit tests for duplicate suppression.
- [x] Unit tests for attempt state transitions.
- [x] Unit tests for feature flag disabled during config and posting exchange.
- [x] Unit tests for runtime version skew.
- [x] Integration tests for action-control-plane conflict posting exchange.
- [x] Workflow template tests for no broad write permissions.
- [ ] E2E disposable repository smoke.

Docs and operations:

- [ ] Add runbook for disabling conflict fallback.
- [ ] Add operator authorization and audit rules for replay, pause, repair, and
      checkpoint recovery.
- [ ] Add health reason code list.
- [ ] Add dashboard or logs for degraded posting.
- [ ] Add telemetry cardinality/privacy budget checks.
- [ ] Document advisory status semantics.
- [ ] Document that the advisory conflict context must not be required.
- [ ] Add disposable repository smoke procedure and cleanup notes.
- [ ] Add threat model and trust boundary review to the implementation PR.
- [ ] Add tenant isolation tests for workspace/repository/installation mismatch.
- [ ] Add protocol compatibility tests for older/newer runtime versions.
- [ ] Add resource budget checks and metrics.
- [ ] Add audit events for each user-visible GitHub write.
- [ ] Add token purpose and key rotation tests.
- [ ] Add canonicalization/hash stability tests.
- [ ] Add model output schema fixtures for valid, invalid, and malicious output.
- [ ] Add UX copy tests for advisory/head-only wording.
- [ ] Add external GitHub behavior verification notes to implementation PR.
- [ ] Add failure injection tests for each GitHub write phase.
- [ ] Add manual recovery runbook entries for pause, replay, duplicate summary,
      wrong required context, and emergency disable.
- [ ] Add source-of-truth table updates for any new runtime input.
- [ ] Add deployment/mixed-version tests.
- [ ] Add data classification review for new stored/logged fields.
- [ ] Add outbox poison job tests.
- [ ] Add local simulation harness scenarios.
- [ ] Add post-launch monitoring thresholds.
- [ ] Add implementation PR template to docs or PR checklist.
- [x] Add workflow security contract tests for generated YAML and capability
      analyzer.
- [x] Add HTTP error contract tests for stable safe error responses.
- [ ] Add inline coordinate policy tests for deleted, renamed, binary, and
      truncated files.
- [ ] Add advisory conclusion policy tests.
- [ ] Add cleanup/deprecation tests for old marker/protocol behavior.
- [ ] Add TOCTOU tests for state changes between each privileged phase.
- [ ] Add transaction/race tests for OIDC start, posting session issuance, and
      write checkpoint commits.
- [ ] Add consistency/read-source tests for replica lag, stale caches, and
      cross-region duplicate starts.
- [x] Add deadline/cancellation tests for provider timeout, expired sessions,
      and pending posting intents.
      Note: local runtime covers provider timeout/cancellation and posting intent
      behavior; expired-session behavior remains covered by token/session tests and
      E2E evidence.
- [x] Add GitHub adapter contract tests and import/layer boundary checks.
- [ ] Add GitHub API budget/pagination/recovery tests for capped reads, rate
      limits, and ambiguous write probes.
      Partial: capped summary marker search and ambiguous write paths are tested;
      secondary rate-limit degradation still needs a fixture.
- [ ] Add cross-layer contract fixtures for dispatch, config, manifest, posting,
      health, workflow capability, and checkpoint records.
- [x] Add request schema tests for unknown fields and alias conflicts.
- [ ] Add parser tests for typed value objects and unknown enum fail-closed
      behavior.
- [x] Add runtime filesystem/process policy tests.
- [ ] Add normal review regression matrix tests for shared code changes.
- [x] Add runtime supply-chain tests for pinned refs and mixed-version
      fail-closed behavior.
      Note: capability-hash evidence remains a production release artifact, not a
      local-only test.
- [ ] Add dispatch payload and nonce policy tests for payload bounds, replay,
      purpose, and log masking.
      Partial: dispatch event type binding, strict payload aliases, and runtime
      nonce-mask order are covered. Runtime/CLI/control-plane safe summaries
      reject nonce-like strings; replay and full log-capture tests remain.
- [ ] Add GitHub Actions concurrency/rerun tests for duplicate starts,
      cancellation, and checkpoint resume.
- [x] Add path/unicode/file identity tests for traversal, control characters,
      case-sensitive paths, symlinks, and display escaping.
      Note: pathspec-like Git paths are covered as literal data and unsafe
      name-status paths are rejected before per-file diff.
- [ ] Add migration rollback tests for old rows, nullable new fields, and enum
      expansion order.
- [ ] Add rollout configuration consistency tests for stale caches and kill
      switch enforcement.
- [x] Add prompt packet tests for secret exclusion, injection boundaries, and
      stable metadata hashing.
- [ ] Add provider contract tests for retention-safe metadata, redacted stderr,
      and disabled fallback.
- [ ] Add rendered markdown safety tests for marker spoofing, hidden comments,
      mass mentions, and body-limit marker preservation.
      Partial: marker spoofing, hidden marker rejection, noisy mentions, and
      path escaping are covered; body-limit marker preservation remains.
- [x] Add network egress tests for phase-specific clients and rejected
      untrusted redirects.
      Note: fixed endpoint path hardening covers protocol-relative paths,
      encoded traversal, query strings, fragments, backslashes, and same-origin
      mismatches.
- [ ] Add telemetry cardinality tests and support export redaction fixtures.
- [ ] Add incident forensics tests for comment-id lookup and checkpoint
      reconciliation.
- [ ] Add operator tool authorization tests for replay, pause, checkpoint
      repair, and audited overrides.
- [ ] Add webhook provenance/loop suppression tests for conflict summary,
      conflict status, copied markers, and duplicate deliveries.
      Partial: copied-marker suppression is covered for generated interaction
      workflows by requiring marker plus bot actor; durable delivery/app/context
      provenance tests remain.
- [ ] Add idempotency retention/cleanup tests for pending intents, compacted
      fingerprints, expired sessions, and duplicate replay prevention.
- [ ] Add test fixture catalog entries for every new production incident or
      discovered edge case.
- [ ] Add canary abort decision tree to rollout notes.
- [ ] Add production readiness scorecard before production enablement.

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
16. Runtime version skew is rejected before checkout.
17. Feature flag disablement is enforced at config and posting exchange.
18. Attempt state transitions are compare-and-set or otherwise race-safe.
19. Ambiguous GitHub write retry is read-before-write and duplicate-safe.
20. Advisory context is proven distinct from the normal required context.
21. Explicit workflows, fork PRs, and self-hosted runners remain fail-closed in
    v1.
22. Tenant isolation tests prove wrong workspace/repository/installation cannot
    start or post.
23. Protocol compatibility tests prove unsupported runtime/workflow/posting
    versions fail before checkout/posting.
24. Resource budgets prevent webhook/base-push storms from creating unbounded
    dispatches or GitHub writes.
25. Audit trail can explain every summary, inline comment, and status/check using
    ids and hashes.
26. Token purpose and key rotation tests prove runtime sessions and posting
    sessions are not interchangeable.
27. Canonicalization tests prove stable hashes across retries.
28. Model output schema rejects unknown control fields.
29. UX tests prove summary/status never imply merge-result review.
30. External GitHub assumptions are re-verified before rollout.
31. Failure injection proves every post-write crash path is duplicate-safe.
32. Manual recovery runbooks exist and do not require deleting attempt records.
33. Mixed-version deployment tests prove safe rollback with flag off.
34. Data classification review proves no raw customer content is stored
    accidentally.
35. Outbox poison jobs cannot create duplicate dispatches or retry storms.
36. Local simulation harness covers stale, duplicate, wrong-tenant, and ambiguous
    write scenarios.
37. Post-launch rollback thresholds are defined before production rollout.
38. Workflow security contract tests prove generated YAML cannot run conflict
    mode with broad permissions or preflight bypass.
39. HTTP error contract tests prove runtime receives stable safe errors.
40. Inline coordinate policy tests prove uncertain coordinates degrade to
    summary-only.
41. Advisory conclusion policy tests prove stale/provider-failed runs cannot
    publish misleading success.
42. Cleanup/deprecation tests preserve old marker/protocol safety.
43. TOCTOU guard tests prove state changes between validation and write phases
    fail closed.
44. Posting intent/commit lifecycle proves no checkpoint is marked complete
    before GitHub success or reconciliation.
45. GitHub adapter contract proves conflict runtime cannot call arbitrary REST
    or GraphQL operations.
46. Request schemas reject unknown fields, conflicting aliases, and
    runtime-supplied control destinations.
47. Runtime filesystem tests prove control data is outside the PR checkout and
    repository-local config is ignored.
48. Canary abort decision tree exists and is linked from rollout evidence.
49. Normal review regression matrix passes for every shared-code change.
50. Runtime supply-chain checks prove production workflows use pinned immutable
    runtime releases or SHAs.
51. Parser tests prove unknown values fail closed and cannot default to normal
    review or broad posting behavior.
52. Migration rollback tests prove old/new rows and enum expansion remain safe
    with the feature flag off.
53. Cross-layer contract tests prove dispatch/config/manifest/posting/audit
    schemas do not drift silently.
54. Production readiness scorecard meets every minimum threshold with evidence.
55. Rollout configuration consistency tests prove stale caches cannot bypass the
    global kill switch or repo pause.
56. Prompt packet tests prove secrets, hidden markers, posting identifiers, and
    unbounded diffs are never model-visible.
57. Runtime network egress tests prove provider/model code cannot reach posting
    proxy or GitHub write clients.
58. Telemetry cardinality/privacy tests prove metrics, logs, audit, and support
    exports cannot leak raw content or destabilize metrics.
59. Incident forensics tests prove support can explain writes from ids and
    hashes without deleting evidence or reading raw content.
60. Consistency/read-source tests prove stale replicas and caches cannot
    authorize config, posting sessions, checkpoints, or operator replay.
61. Deadline/cancellation tests prove expired sessions, provider timeouts, and
    canceled posting intents fail closed or reconcile safely.
62. Provider contract tests prove provider selection, retention-sensitive data,
    stderr, fallback, and request metadata are policy-bound.
63. Rendered markdown tests prove model text cannot spoof markers, trigger mass
    mentions, hide metadata, or truncate away the runtime marker.
64. Dispatch payload and nonce tests prove payloads stay bounded,
    non-authoritative, secret-free, and replay-resistant.
65. GitHub Actions concurrency/rerun tests prove reruns and cancellations cannot
    duplicate comments or bypass stale/latest-attempt checks.
66. Path/unicode/file identity tests prove repository paths cannot escape
    checkout, collide incorrectly, poison shell commands, or spoof display.
67. Operator tool authorization tests prove manual replay/pause/repair paths are
    scoped, audited, idempotent, and cannot bypass rollout/stale checks.
68. Production evidence pack is complete, redacted, and maps GitHub-visible
    writes back to audit ids and attempt ids.
69. GitHub API budget/pagination tests prove large PRs, many comments, rate
    limits, and ambiguous responses degrade safely without unbounded reads or
    blind retries.
70. Webhook provenance tests prove conflict-created comments/statuses and
    duplicate deliveries cannot trigger review loops or suppress legitimate
    normal rechecks.
71. Idempotency retention tests prove cleanup cannot remove metadata required
    for duplicate prevention, pending-intent recovery, or support replay inside
    the replay window.
72. Cleanup/deprecation evidence proves old marker/protocol/idempotency metadata
    remains safe until the support and replay windows end.

## Most Dangerous Areas

| Area                                      | Severity | Bug likelihood | Detection difficulty | Mitigation                                                     |
| ----------------------------------------- | -------: | -------------: | -------------------: | -------------------------------------------------------------- |
| Posting token too broad                   |    10/10 |           6/10 |                 8/10 | Use scoped posting proxy/session, never generic comment token. |
| Cross-tenant or wrong-repo posting        |    10/10 |           4/10 |                 8/10 | Validate workspace/repo/installation tuple on every exchange.  |
| Stale PR state before posting             |     9/10 |           7/10 |                 7/10 | Validate before summary and before status.                     |
| Model controls posting behavior           |     9/10 |           5/10 |                 8/10 | Strict output schema and runtime-owned policy.                 |
| Unsafe checkout target                    |     9/10 |           5/10 |                 7/10 | Exact head SHA, no mutable refs, no credentials.               |
| OIDC allowlist too broad                  |     9/10 |           4/10 |                 8/10 | Conflict-specific repository_dispatch validation.              |
| Duplicate comments after retry            |     8/10 |           7/10 |                 6/10 | Posting checkpoints and fingerprints.                          |
| Ambiguous GitHub write retry              |     8/10 |           6/10 |                 8/10 | Read-before-write retry after unknown write result.            |
| User marker spoofing                      |     8/10 |           5/10 |                 7/10 | Verify stored id or app/bot author identity.                   |
| Workflow shape drift                      |     8/10 |           5/10 |                 7/10 | Capability validation at dispatch and config exchange.         |
| Runtime version skew                      |     8/10 |           5/10 |                 7/10 | Conflict minimum runtime version.                              |
| Fork PR secret exposure                   |    10/10 |           3/10 |                 7/10 | Keep fork skip and runtime revalidation.                       |
| Status/check interpreted as required      |     7/10 |           5/10 |                 5/10 | Separate context and product source-of-truth rule.             |
| Feature flag disabled while run is active |     8/10 |           5/10 |                 6/10 | Re-check flag at config and posting exchange.                  |
| Unbounded dispatch/provider/posting load  |     8/10 |           6/10 |                 6/10 | Resource budgets, backpressure, metrics, rollout caps.         |
| Token purpose/key rotation bug            |     9/10 |           4/10 |                 7/10 | Separate purposes and previous-key overlap tests.              |
| TOCTOU between validation and write       |     9/10 |           6/10 |                 8/10 | Revalidate at every privileged boundary and proxy write.       |
| DB race creates duplicate posting intent  |     8/10 |           6/10 |                 7/10 | CAS transitions, unique intent keys, pending/commit lifecycle. |
| Generic GitHub adapter escape hatch       |    10/10 |           4/10 |                 8/10 | Narrow ports and import/layer tests.                           |
| Runtime writes control files into PR tree |     8/10 |           4/10 |                 7/10 | Runtime temp dir outside checkout, no repo-local config.       |
| Runtime supply-chain drift                |     9/10 |           4/10 |                 8/10 | Pinned refs, capability hash binding, mixed-version tests.     |
| Parser silently accepts future fields     |     8/10 |           5/10 |                 7/10 | Strict schemas, typed value objects, contract fixtures.        |
| Normal review regression via shared code  |     9/10 |           5/10 |                 7/10 | Regression matrix and type-level session separation.           |
| Migration rollback breaks old rows        |     8/10 |           4/10 |                 7/10 | Expand-first migrations and rollback reader tests.             |
| Rollout cache bypasses kill switch        |     9/10 |           5/10 |                 7/10 | Fresh posting checks and global-disable override.              |
| Prompt packet leaks control/secrets       |     9/10 |           4/10 |                 8/10 | Typed prompt builder and secret/marker exclusion tests.        |
| Runtime egress reaches write APIs         |     9/10 |           4/10 |                 8/10 | Phase-specific clients and no runtime GitHub write path.       |
| Telemetry leaks content or explodes       |     8/10 |           5/10 |                 6/10 | Cardinality/privacy budget and export fixtures.                |
| Incident response destroys evidence       |     8/10 |           4/10 |                 7/10 | Forensic runbook and checkpoint-first recovery.                |
| Stale replica authorizes posting          |    10/10 |           4/10 |                 8/10 | Strong reads or CAS for privileged decisions.                  |
| Deadline leaves ambiguous side effect     |     8/10 |           6/10 |                 7/10 | Phase deadlines, pending intents, reconciliation.              |
| Provider retains or leaks repository data |     9/10 |           4/10 |                 7/10 | Provider contract and retention-safe metadata policy.          |
| Rendered markdown spoofs runtime marker   |     8/10 |           5/10 |                 7/10 | Runtime template, marker stripping, rendered body tests.       |
| Dispatch nonce replay or payload bloat    |     9/10 |           4/10 |                 7/10 | Minimal payload, hash-only nonce, one purpose/run binding.     |
| Actions rerun duplicates side effects     |     8/10 |           6/10 |                 7/10 | Concurrency contract, CAS, checkpoints, rerun tests.           |
| Path/unicode identity confusion           |     8/10 |           5/10 |                 7/10 | Central path policy, preserve case, escape display.            |
| Operator tool bypasses runtime checks     |     9/10 |           4/10 |                 8/10 | Scoped audited operations, no direct SQL/broad token handoff.  |
| Launch evidence is incomplete             |     7/10 |           5/10 |                 6/10 | Production evidence pack with redacted linked artifacts.       |
| GitHub pagination/rate-limit storm        |     8/10 |           6/10 |                 7/10 | Per-operation budgets, capped pagination, degraded outcomes.   |
| Webhook loop or false suppression         |     8/10 |           5/10 |                 7/10 | Provenance fields and durable id loop suppression.             |
| Cleanup breaks duplicate prevention       |     8/10 |           5/10 |                 8/10 | Idempotency retention and cleanup safety tests.                |

## Recommended Next Work Item

The main local code path is now implemented. The next work item should be
release/evidence hardening, not another broad code layer:

1. Run the full local verification matrix and fix any regression.
2. Run a disposable GitHub repository smoke against a real conflicted PR.
3. Attach redacted evidence for OIDC claim shape, exact head checkout,
   stale-exit behavior, summary/status posting, duplicate retry, and rollback.
4. Only after that, decide whether the feature flag can move from local/staging
   testing to a limited canary.

Do not enable production rollout from local tests alone. The remaining risk is
mostly GitHub Actions/GitHub API behavior under real repository conditions.

## Open Questions Before Coding

These questions must be answered before the corresponding phase starts. They do
not block the first OIDC/runtime parser PR unless noted.

| Question                                                                    | Blocks             | Recommended default                                          |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| Is posting implemented as pure proxy or scoped session plus proxy commands? | posting PR         | pure proxy commands first                                    |
| Do we use commit status only, or add check runs later?                      | advisory status PR | commit status only                                           |
| Is dry-run exposed by env flag, repo rollout, or runtime input?             | dry-run PR         | repo/internal rollout plus server policy                     |
| Where does runtime code live and how is it released relative to server?     | runtime parser PR  | explicit runtime version and compatibility policy            |
| How long are attempt/audit records retained?                                | posting/audit PR   | enough for duplicate prevention and support investigation    |
| How do we detect advisory context accidentally required by users?           | rollout docs PR    | best-effort setup/readiness warning, docs otherwise          |
| How are provider timeouts configured for conflict mode?                     | model runner PR    | shorter bounded timeout than normal review until proven safe |
| What is the exact inline comment cap?                                       | inline posting PR  | conservative cap, summary-only overflow                      |

Do not answer these implicitly in code. Update this plan or the implementation
PR description with the chosen answer and tests.

## Stop Conditions

Stop implementation and redesign before merging if any of these happen:

- Conflict runtime needs a broad GitHub token before model execution.
- Runtime cannot prove exact head SHA checkout.
- Posting cannot be scoped below repository-level permissions.
- Pre-post validation cannot reliably identify stale base/head state.
- A GitHub write can succeed ambiguously and retry cannot discover whether it
  already happened.
- The reusable runtime cannot reject old/unsupported conflict mode versions.
- Disposable GitHub E2E cannot prove OIDC claim shape for `repository_dispatch`.
- Any test requires weakening normal review security to make conflict mode pass.
- Tenant isolation relies on repository full name instead of immutable ids.
- Protocol compatibility is inferred from optional fields instead of explicit
  versions.
- Posting proxy needs a generic GitHub API tunnel to make progress.
- Resource budgets cannot prevent a base-push or webhook storm.
- Audit cannot explain a user-visible write without reading raw logs or full
  model output.
- Key rotation invalidates active runs in a way that causes unsafe retries.
- Workflow security contract cannot be proven from rendered YAML tests.
- Runtime needs to post a success status after stale validation failure.
- Inline comment implementation cannot distinguish uncertain coordinates from
  valid coordinates.
- HTTP errors expose raw GitHub/provider responses to runtime logs.
- Cleanup requires deleting attempts or old marker parsers before support
  retention expires.
- Correctness depends on "GitHub Actions runs only once" instead of database
  compare-and-set and idempotency keys.
- A checkpoint can be marked complete before GitHub success or reconciliation.
- Conflict runtime needs direct access to Octokit, arbitrary REST paths, GraphQL,
  or installation tokens.
- Runtime control files must be written into the repository checkout.
- Canary cannot be aborted by repo/global flag without code deploy.
- Production workflow needs a floating runtime ref for posting.
- Parser accepts unknown conflict fields that can change authority, target, or
  posting behavior.
- Code rollback cannot read conflict attempt rows created during canary.
- A shared normal-review helper must understand conflict posting fields to keep
  normal review working.
- Contract snapshots cannot explain the payload exchanged between runtime and
  server.
- Rollout disablement depends on cached config that posting exchange does not
  refresh.
- Prompt packet construction requires exposing hidden markers, posting
  identifiers, tokens, or unbounded diffs to the model.
- Provider/model code needs a generic network client that can reach ReviewRouter
  posting endpoints or GitHub write APIs.
- Metrics require high-cardinality labels such as attempt id, file path, branch
  name, or raw error message.
- Incident recovery requires deleting comments or attempt records before
  checkpoint/audit reconciliation.
- Posting-session issuance depends on a stale read replica or cache without a
  compare-and-set proof.
- Runtime cancellation can leave a GitHub write ambiguous without a pending
  intent for reconciliation.
- Provider fallback changes model/provider identity after manifest creation or
  after any posting side effect.
- Rendered markdown can remove, duplicate, hide, or spoof the runtime-owned
  conflict marker.
- Dispatch payload needs provider config, prompt, diff, tokens, posting policy,
  or other authoritative fields to work.
- Nonce storage or logging requires raw nonce after dispatch.
- Workflow concurrency or rerun correctness depends on GitHub not starting two
  runs.
- Path handling requires normalizing away Git path identity, lowercasing paths,
  or passing repository paths through shell strings.
- Operator tooling needs direct SQL, broad GitHub tokens, or unaudited overrides
  to recover from common incidents.
- Production launch cannot provide a redacted evidence pack linking GitHub
  writes to audit/checkpoint ids.
- GitHub adapter needs unbounded pagination, all-comment scans, or blind retries
  to prove ownership or duplicate status.
- Webhook loop suppression depends only on comment text or marker string without
  delivery/app/actor/context provenance.
- Cleanup has to delete pending intents or inline fingerprints before the replay
  and support windows expire.

The right failure mode is a skipped/degraded conflict review, not an unsafe
comment.

## Final Launch Checklist

Before enabling production rollout, verify and attach evidence:

- [ ] `REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK` remains off by default.
- [ ] Repo/workspace rollout switch exists and was tested.
- [ ] Global disable bypasses rollout caches at config and posting exchange.
- [ ] Posting authority uses primary/strongly consistent reads or CAS proof, not
      stale replicas.
- [x] Runtime protocol version is explicit and compatibility tests pass.
- [ ] Production runtime ref is immutable and included in capability hash.
- [ ] Workflow capability hash includes permissions, inputs, runtime ref, and
      reusable workflow path.
- [x] Dispatch payload is minimal, bounded, secret-free, and nonce is hash-only
      server-side.
- [ ] GitHub Actions rerun/concurrency behavior is tested against duplicate
      starts and cancellation.
- [x] OIDC exchange rejects generic `repository_dispatch`.
- [ ] Runtime exits before checkout on invalid dispatch, invalid nonce, old
      runtime, disabled flag, and wrong repository.
      Partial: invalid dispatch action/type, old runtime, disabled flag, and
      wrong repository are covered locally; disposable Actions evidence is still
      required for the full pre-checkout claim.
- [x] Parsers reject unknown conflict control fields and alias conflicts.
- [x] Provider/model env allowlist excludes OIDC, GitHub, nonce, and posting
      secrets.
- [x] Prompt packet excludes secrets, hidden markers, posting identifiers, and
      unbounded diff content.
- [x] Repository path/unicode handling preserves Git identity and escapes unsafe
      display characters.
      Note: literal pathspec mode prevents Git pathspec metacharacters from
      changing the reviewed file identity.
- [x] Runtime network clients cannot call GitHub writes or posting proxy from
      provider/model phase.
      Note: fixed control-plane endpoint paths are validated as same-origin
      absolute paths without traversal, encoded traversal, query, or fragment.
- [ ] Provider contract and retention behavior are documented and tested.
- [ ] Runtime deadlines and cancellation paths reconcile pending posting
      intents.
- [ ] Rendered markdown cannot spoof markers or trigger unbounded notifications.
- [x] Posting session/proxy cannot call normal review posting path.
- [x] Summary marker ownership spoof test passes.
      Note: local GitHub adapter tests cover user-copied markers, App-bot marker
      ownership, and ambiguous duplicate marker fail-closed behavior.
- [ ] Duplicate webhook and retry tests prove no duplicate summary.
      Partial: posting intent and route integration tests prove idempotent
      summary replay; duplicate webhook delivery evidence remains open.
- [x] Ambiguous GitHub write retry uses read-before-write.
- [x] Posting intent/commit tests prove ambiguous writes cannot duplicate
      comments or statuses.
- [x] Advisory status context cannot equal normal required context.
- [ ] Branch protection/ruleset docs warn not to require advisory context.
- [ ] Resource budgets and alerts are configured.
- [ ] Audit events are emitted for each GitHub write.
- [ ] GitHub adapter budgets, pagination caps, and secondary-rate-limit
      degradation are tested.
- [ ] Contract test fixtures are updated for every runtime/server schema.
- [ ] Normal review regression matrix passes.
- [ ] Migration rollback tests pass with old and new attempt rows.
- [ ] Webhook provenance/loop suppression tests pass for conflict comments and
      statuses.
      Partial: generated interaction workflow tests prove marker plus bot actor
      suppression for comments; durable webhook id/status provenance remains open.
- [ ] Idempotency retention/cleanup tests prove duplicate-prevention metadata
      survives through replay/support window.
- [ ] Telemetry cardinality/privacy budget checks pass.
- [ ] Incident forensics lookup works from comment/status ids and redacted logs.
- [ ] Operator replay/pause/repair tools are scoped, audited, and fail stale
      checks.
- [ ] Production readiness scorecard meets all thresholds.
- [ ] Production evidence pack is complete and redacted.
- [ ] Disposable E2E smoke artifacts are attached.
- [ ] Canary abort decision tree was exercised at least once in staging or
      disposable smoke.
- [ ] Rollback disables new attempts and blocks started runs before posting.
- [ ] Support/runbook copy explains "head-only conflict review" clearly.

Do not ship production enablement without this checklist. A half-enabled conflict
review is worse than the current explicit "merge result was not reviewed"
message because it can create false confidence on a PR that still cannot merge.
