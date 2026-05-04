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
