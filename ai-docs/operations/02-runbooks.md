# Runbooks

## Review v2 Worker Recovery

Keep due and recovery schedulers disabled until the repository reaches the
approved rollout phase. Monitor the release-bound completion-process SLOs. A due
worker claims by ID/owner/`bigint` term; stale acknowledgement is ignored.
Recovery uses bounded keyset full passes over finalized artifacts and is
independent of outbox dead letters. `terminal_unknown` blocks snapshot advancement
until reconciliation or audited manual terminalization.
These runbooks are written for local/private beta. They must stay
metadata-only: do not paste provider secrets, raw webhook payloads, repository
code, pull request diffs, prompts, or model responses into tickets or logs.

## App-First Repository E2E

Run this gate before every SaaS organization rollout and after changes to the
GitHub App, workflow provisioning, rotating provider setup, Action runtime, or
control-plane Action ref. Use only a clearly disposable repository.

Before opening the review fixture PR, enroll that disposable repository with
`review-v2:admin cohort stage` and `mutation initialize-direct-v2`. Never bypass
the T0 authority gate by reverting the workflow to rotating schema v1.

```bash
REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1 \
REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER=OWNER \
REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME=rr-codex-rotating-e2e \
REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF=OWNER/review-router@FULL_40_CHAR_SHA \
pnpm subscription-runtime:live-e2e
```

The production gate is complete only when all of these are proven:

1. the production GitHub App creates the setup PR
2. `.github/workflows/reviewrouter-codex.yml` is client-triggered T0 schema v2,
   calls the immutable `reviewrouter-t0-reusable.yml`, uses the
   repository-scoped `provider_instance_id`, OIDC `id-token: write`, and
   `REVIEWROUTER_CODEX_AUTH_JSON`
3. `.github/workflows/reviewrouter.yml`, `pull_request_target`, rotating schema
   v1/direct mode, direct `CODEX_AUTH_JSON`, and review publication through
   `github.token` are absent
4. two real pull requests complete rotating writeback without leaking auth or
   producing artifacts
5. every ReviewRouter advisory and inline finding has the exact author
   `${GITHUB_APP_SLUG}[bot]`; `github-actions[bot]` fails the gate
6. the actual check-run context is recorded before required checks are changed

Do not use `spike:github:fresh-repo:e2e` as SaaS rollout evidence. It exercises
the historical direct workflow and cannot prove App-first publication identity.

If setup fails, verify App installation selection and accepted permissions,
then rerun repository sync. If review fails, inspect the safe Action summary,
the exact control-plane/Action ref match, provider generation, and App comment
token issuance. Never repair rotating OAuth by copying `CODEX_AUTH_JSON` or by
pinning a legacy Action release.

Delete a one-off disposable repository after the rollout batch. Reusable named
canaries may be retained only when their purpose and owner are recorded.

## GitHub Webhook Failing

Check:

1. webhook secret matches GitHub App settings
2. delivery exists in `GitHubWebhookDelivery`
3. signature verification error logs
4. event type supported
5. job enqueue result

## Setup PR Not Created

Check:

1. repo selected and installation active
2. GitHub App has contents/pull_requests permissions
3. default branch exists
4. existing setup PR already open
5. repo-level provisioning lock not stuck
6. `WorkflowProvisioning.errorSummary`

## Repo Missing From Dashboard

Check:

1. installation has access to repo
2. installation sync job ran
3. GitHub API rate limit
4. repository archived/deleted/renamed
5. workspace mapping correct

## Provider Setup Confusing

Check:

1. provider type selected in config
2. setup source shown correctly
3. docs link shown
4. workflow references expected secret names
5. fork PR warning shown for public repos

## Wrong Codex Setup PR Generated

Use this when a setup PR for a Codex repository creates
`.github/workflows/reviewrouter.yml` or references `CODEX_AUTH_JSON`.

Production Codex must always use the rotating workflow:

1. `.github/workflows/reviewrouter-codex.yml`
2. `mode: codex-oauth-rotating`
3. `auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}`
4. action ref: `777genius/review-router@main` unless an explicit rollback ref is configured

Do not merge a Codex setup PR that uses `REVIEW_AUTH_MODE=codex-oauth`,
`CODEX_AUTH_JSON`, `OPENAI_API_KEY`, `reviewrouter-reusable.yml`, or
`.github/workflows/reviewrouter.yml`. That is the legacy path and must be
regenerated after reconnecting the repository with Codex OAuth rotating.

Expected recovery:

1. close the bad setup PR or replace its branch with the rotating workflow
2. confirm repository config uses provider auth mode
   `codex_subscription_oauth_rotating`
3. rerun setup from the dashboard
4. run the local/prod smoke against the affected repo

Do not repair rotating Codex by running `gh secret set
REVIEWROUTER_CODEX_AUTH_JSON` directly. Use the generated setup command or
`scripts/reseed-codex-rotating-auth.sh`; otherwise the repository secret can be
newer than the confirmed generation and live review can fail as an older queued
secret generation.

### Recover a fetched setup with an unknown confirmation result

A setup manifest that reached `fetched` has a bounded 24-hour response-recovery
window independent of its short issue/fetch TTL. Issued-never-fetched manifests
still expire on the short TTL. Before `gh secret set`, the installer stores a
0600 repo-scoped retry marker and ReviewRouter transactionally admits the exact
payload metadata (generation hash, account fingerprint, exact byte size, and
payload/installer version). The first valid claim wins; only that same claim is
idempotent. ReviewRouter never receives plaintext auth.

A repository operator with write, maintain, or admin access must reopen the
Codex provider setup in the dashboard, stop every prior installer and runtime
writer, read the warning, check the explicit acknowledgement, and choose
**Recover and issue forced reseed**. The equivalent authenticated CLI API is
`POST /api/codex-rotating/cli/setup-recovery` with the repository, a stable
operator-generated `recoveryRequestId`, and the exact acknowledgement
`all_prior_installers_and_writers_are_stopped`. Retry a dropped fetch, prepare,
PUT, or confirmation response with the same command and unchanged dedicated
auth during the response-recovery window. The installer reuses the exact
compact payload and proves the same durable claim. If local retry state/auth is
missing or differs, or the recovery window has closed, it refuses login and
refuses any GitHub write; use a versioned secret and manual operator recovery.
If ReviewRouter already consumed the byte-identical confirmation, prepare
returns `already_confirmed`; the installer closes its local retry marker without
redispatching the old payload, because the provider may already have advanced
to a newer generation.
Never infer an external PUT outcome from a timeout, elapsed grace period, or
absent response. A different request ID conflicts while recovery is active.
The recovery ledger and payload claim store only safe identifiers and metadata,
never plaintext.

Do not use setup recovery for `codex_rotating_identity_quarantined`. Authorized
operators can inspect safe quarantine details through
`GET /api/dashboard/codex-rotating/setup-recovery?workspaceId=...&repositoryId=...`.
Repair the repository/provider binding through the identity migration operator
lane; recovery deliberately cannot rewrite the provider's immutable workspace,
repository, canonical provider ID, auth mode, or secret name.

If a live smoke fails with a provider usage-limit or capacity error, do not
rewrite the GitHub secret manually. Reseed through the generated command using a
known non-limited Codex session, then rerun the smoke. Quota-limited sessions
are an account-capacity condition and should not be diagnosed as an OAuth
generation-contract failure.

## Codex Rotating Action Ref Mismatch

Use this when a GitHub Actions run fails with `action_repository_mismatch`,
`codex_rotating_workflow_action_ref_mismatch`, or a safe error that says the
workflow/action repository does not match the selected repository.

Why it happens:

1. Codex OAuth rotating workflows must match the configured ReviewRouter Action
   ref, normally `777genius/review-router@main`.
2. The SaaS API validates the workflow source at GitHub's `workflow_sha` before
   issuing checkout, comment, or secret writeback tokens.
3. The workflow file and Render config can diverge if a rollback or smoke ref is
   applied only on one side.
4. The correct behavior is fail closed. Fix the configured action ref instead
   of bypassing owner, provider, or schema checks.

Normal recovery:

```bash
pnpm ops:sync-action-ref --dry-run --no-deploy
pnpm ops:sync-action-ref --wait
```

Expected sync output:

1. `actionRef` is `777genius/review-router@main` unless an explicit rollback ref was passed
2. `allowedActionRefs` contains only full SHA refs
3. services are exactly `reviewrouter-web`, `reviewrouter-api`, and
   `reviewrouter-worker`
4. deploy ids are printed for all three services
5. with `--wait`, each requested deploy reaches `live`

Post-sync verification:

```bash
curl -fsS https://api.reviewrouter.site/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://reviewrouter.site
pnpm ops:sync-action-ref --dry-run --no-deploy
```

The final dry-run should show the same `actionRef` and
`allowedActionRefs` that are already live. If the failing PR intentionally used
a rollback SHA, rerun the sync with that explicit ref:

```bash
pnpm ops:sync-action-ref \
  --action-ref 777genius/review-router@<40-char-sha>
```

Rollback:

1. If the new Action commit is bad, publish a fixed Action commit on `main` or
   temporarily sync a known-good full SHA.
2. Keep temporary rollback SHAs in `REVIEW_ROUTER_ALLOWED_ACTION_REFS` during
   the transition.
3. After workflows converge, shrink the window:

```bash
pnpm ops:sync-action-ref --allowlist-window 1
```

Do not store provider auth JSON, API keys, PR diffs, prompts, or model output in
Render env while debugging. The action-ref sync only changes
`REVIEW_ROUTER_ACTION_REF` and `REVIEW_ROUTER_ALLOWED_ACTION_REFS`.

## Rotate GitHub App Private Key

Steps:

1. create new private key in GitHub App settings
2. update deployment secret
3. deploy/restart API/worker
4. verify installation token minting
5. revoke old private key
6. record audit/ops event

## Outbox Dead Letter Or Stuck Processing

Check:

1. dashboard `Operational queue` section for the workspace
2. `OutboxEvent.status`, `lastErrorCode`, and `safeLastErrorSummary`
3. worker logs for redacted safe error summaries
4. GitHub App permissions or external state if the error is permission-related
5. whether the worker is running with at least one registered handler

Recovery:

1. fix the underlying cause first
2. for `dead_letter`, click `Retry` in dashboard or call the maintenance use case
3. for stale `processing`, let worker recovery requeue it after `REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS`
4. run the worker and verify the event reaches `processed`
5. check audit for `outbox.retry_requested` when manual retry was used

Do not manually edit payload JSON in production. If payload migration is needed,
ship an explicit versioned migration or a new handler version.

## Balanced Memory Operational Checks

Use this after changing memory storage, dashboard memory actions, interaction
commands, export, retention, diagnostics, or workflow memory wiring.

Local verification:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm architecture:check
pnpm spike:memory:e2e
```

Expected result:

1. migrations apply to a fresh temporary Postgres database
2. action session OIDC exchange succeeds
3. maintainer/admin memory writes succeed and member/author writes fail closed
4. raw code, diffs, prompts, model output, and raw conversations are rejected
5. confirmed repository/workspace memory appears in the scoped action bundle
6. disabled, expired, deleted, cross-repository, and cross-workspace memory does not appear in the bundle
7. delete redacts memory body/source and confirmed origin suggestion body/source
8. export includes active, disabled, and expired memory only
9. export excludes deleted rows, embeddings, raw source excerpts, and source hashes
10. audit, outbox, usage telemetry, and diagnostics contain ids, hashes, counts, status, and versions only
11. workspace flag `balanced_memory=false` returns an empty degraded runtime bundle and `memory_disabled` for new writes

Real GitHub memory smoke:

```bash
REVIEW_ROUTER_GITHUB_MEMORY_E2E=1 \
  REVIEW_ROUTER_GITHUB_MEMORY_E2E_PR=<open-disposable-pr-number> \
  pnpm spike:github-memory:e2e
```

Expected target state:

1. use existing disposable repository `777genius/review-router-saas-e2e`
2. do not create a new GitHub repository unless isolation is explicitly required
3. the disposable repository default branch contains `.github/workflows/reviewrouter-interaction.yml`
4. `/rr remember repo <marker>` creates a confirmed repository memory item
5. natural-language remember creates a pending suggestion, and `/rr remember mem_suggestion_*` confirms it
6. the confirmed item appears in a later scoped action memory bundle
7. `/rr forget mem_*` removes it from future bundles
8. bot comments do not trigger a new interaction run
9. PR author/member denial is either verified with a second non-maintainer actor or covered by `pnpm spike:memory:e2e`

Latest production evidence, 2026-05-16:

- disposable repo PR: <https://github.com/777genius/review-router-saas-e2e/pull/4>
- marker: `rr-memory-smoke-1778965736933`
- direct save run: <https://github.com/777genius/review-router-saas-e2e/actions/runs/25973002113>
- natural-language suggestion run: <https://github.com/777genius/review-router-saas-e2e/actions/runs/25973014137>
- suggestion confirmation run: <https://github.com/777genius/review-router-saas-e2e/actions/runs/25973027526>
- forget/delete run: <https://github.com/777genius/review-router-saas-e2e/actions/runs/25973034902>
- final smoke status: `passed`

The smoke runner is intentionally opt-in because it posts PR comments and
triggers GitHub Actions. Use `REVIEW_ROUTER_GITHUB_MEMORY_E2E_PREFLIGHT_ONLY=1`
to validate repository/workflow readiness without posting comments. The
preflight also rejects stale workflows/runtimes that do not expose the memory
candidate and command endpoints, so it fails before side effects if the action
runtime has not been updated.

Emergency disable:

1. set `REVIEW_ROUTER_MEMORY_ENABLED=0|false|off` or `REVIEW_ROUTER_DISABLE_MEMORY=1|true|on` on API and web services
2. restart services so `MemoryPolicyConfigPort` composition picks up the flag
3. verify action memory bundle responses are empty/degraded and new writes return `memory_disabled`
4. keep dashboard delete/disable/export available for authorized cleanup of existing memory
5. unset the flag only after `pnpm spike:memory:e2e` and production smoke checks pass

If memory bundle requests fail:

1. review continues without memory because memory bundle fetch is non-blocking
2. check action session validity, workspace id, repository id, and memory feature entitlement
3. inspect support diagnostics counts, not memory bodies
4. confirm search index degradation falls back to canonical storage
5. check worker logs for safe memory outbox handler summaries

If export returns `memory_export_too_large`:

1. do not increase sync response size in the dashboard route
2. use the JSON manifest counts to estimate scope only when available
3. build or enable an async admin export workflow with expiring storage before supporting larger exports
4. keep deleted rows, embeddings, raw source excerpts, and source hashes excluded
5. audit only export id, counts, checksum, format, and safe status metadata

If a user requests deletion:

1. disable runtime exposure immediately through dashboard delete or the normalized interaction command
2. verify deleted memory no longer appears in action bundles
3. verify source/body redaction on the canonical memory item and linked confirmed suggestion
4. let terminal retention prune hard-delete old deleted/expired rows
5. do not paste memory body, source comments, code, diffs, prompts, or model output into support tickets
