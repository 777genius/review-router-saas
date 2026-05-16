# Runbooks

These runbooks are written for local/private beta. They must stay
metadata-only: do not paste provider secrets, raw webhook payloads, repository
code, pull request diffs, prompts, or model responses into tickets or logs.

## Fresh Repository E2E Smoke

Use this before showing the MVP to a new tester or after changing GitHub App,
workflow provisioning, provider setup, action runtime config, or action version
resolution.

Setup-only smoke:

```bash
node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

Full review smoke with Codex OAuth seeding and an intentional blocking finding:

```bash
REVIEW_ROUTER_FRESH_E2E_MODE=review node scripts/run-with-env.mjs pnpm spike:github:fresh-repo:e2e
```

Useful overrides:

```bash
REVIEW_ROUTER_FRESH_E2E_OWNER=777genius
REVIEW_ROUTER_FRESH_E2E_REPO_NAME=rr-saas-fresh-e2e-manual
REVIEW_ROUTER_FRESH_E2E_VISIBILITY=public
REVIEW_ROUTER_FRESH_E2E_INSTALL_TIMEOUT_MS=90000
REVIEW_ROUTER_ACTION_REF=777genius/review-router@main
```

Expected setup-only result:

1. disposable repo is created
2. ReviewRouter GitHub App installation is discovered
3. repositories sync into the local database
4. setup PR is created and mergeable
5. setup PR is merged
6. workflow probe reports `present` and `expectedActionRefFound=true`

Expected full-review result:

1. setup-only result succeeds first
2. `scripts/seed-codex-auth.sh` writes `CODEX_AUTH_JSON` directly to the disposable repo Actions secret
3. intentional auth-bypass PR is opened
4. GitHub Actions run starts for workflow `ReviewRouter`
5. run fails intentionally because a critical finding is found
6. inline review comment is present on `auth.js:5`

Cleanup:

The script never deletes GitHub repositories automatically. Delete disposable
repos manually if needed:

```bash
gh repo delete OWNER/REPO --yes
```

Do not add automatic deletion to the beta script unless the operator explicitly
accepts the `delete_repo` scope tradeoff.

## Fresh Repository E2E Failed

Use the JSON object printed by the script first. It includes the target repo,
setup PR URL, review PR URL, run URL, and safe error summary when available.

If App installation is not found:

1. check the GitHub App is installed for the owner or selected repository
2. check the App has `contents`, `workflows`, `pull_requests`, `issues`, and `metadata` permissions
3. wait one minute and rerun, because GitHub installation visibility can lag
4. run `node scripts/run-with-env.mjs pnpm spike:github:list-installations`

If setup PR is not mergeable:

1. open the setup PR URL from script output
2. check branch protection and required checks on the disposable repo
3. verify `.github/workflows/reviewrouter.yml` is the only intended file
4. rerun with a fresh disposable repo name if GitHub mergeability stays `UNKNOWN`

If workflow probe says missing after merge:

1. confirm setup PR was merged into the default branch
2. confirm default branch is `main`
3. confirm the workflow file path is `.github/workflows/reviewrouter.yml`
4. check the expected action ref in `.env.local` or `REVIEW_ROUTER_ACTION_REF`
5. run the repo health smoke against the same repo:

```bash
REVIEW_ROUTER_TARGET_REPO=OWNER/REPO \
  node scripts/run-with-env.mjs pnpm spike:repo-health:e2e
```

If full review does not start:

1. confirm Actions are enabled on the disposable repo
2. confirm the review PR branch exists
3. open the Actions tab and filter by workflow `ReviewRouter`
4. check whether GitHub skipped the workflow because the PR is from a fork

If full review starts but has no inline comment:

1. open the run URL and inspect the action summary
2. confirm `CODEX_AUTH_JSON` was seeded in the target repo, not the SaaS repo
3. confirm the action ref points to a runtime that includes current ReviewRouter fixes
4. confirm the expected fixture still changes `auth.js` line 5
5. rerun the full-review smoke once to exclude transient Codex/provider failure

If Codex auth fails:

1. run `codex` locally and confirm the current machine is still logged in
2. run `bash scripts/seed-codex-auth.sh --dry-run` with the target repo env
3. reseed the repo or org selected-repo secret with `scripts/seed-codex-auth.sh`
4. do not paste `auth.json` into logs or the SaaS dashboard

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
