# Release And Git Flow

This file is the source of truth for ReviewRouter git flow, deploy sequencing,
and release tags. Keep `README.md`, `AGENT.md`, and `AGENTS.md` as links to this
file instead of duplicating the process there.

## Repositories

ReviewRouter has two release-coupled repositories:

- `777genius/review-router` - customer GitHub Action and reusable workflow entrypoint.
- `777genius/review-router-saas` - SaaS control plane and trusted conflict-runtime checkout.

Generated reusable workflows use the same ref for both layers:

```text
uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1
runtime_ref: v1
```

For conflict review, `runtime_ref` is also used to checkout
`777genius/review-router-saas`. That means compatible releases must keep the two
repos on matching exact tags, for example `v1.0.39` in both repositories.

## Channels

```text
main     - live Action channel, default for hosted beta setup PRs
v1       - stable moving major channel, conservative customer option
v1.0.x   - immutable exact release tag, conservative pinned customer option
```

Rules:

- Hosted beta customer workflows default to `main` so Action fixes ship without regenerating customer setup PRs.
- Never force-move immutable exact tags such as `v1.0.39`.
- Move `v1` only through the release workflows, except for a documented emergency rollback.
- Do not move `v1` for breaking workflow inputs, protocol breaks, or untested runtime changes.
- Release both repositories with the same exact version when generated workflows can use that ref in both places.
- Do not use the legacy local `pnpm release:sync-major` helper for normal releases.

## Daily Git Flow

Default flow:

```text
branch/worktree -> local checks -> commit -> PR -> CI -> merge to main -> deploy or release
```

Working rules:

- Use a separate branch or worktree for non-trivial changes.
- Keep commits focused and use conventional commit messages.
- Do not mix unrelated refactors into release or hotfix commits.
- Do not deploy on every small change. Batch coherent fixes, run checks, then deploy.
- Before deploy or release, verify the exact commit that will ship.
- If the tree is dirty with unrelated work, do not stage or revert it. Commit only the intended files.
- Prefer PRs into `main`. Direct pushes are only for an explicitly approved urgent operator action.

Recommended local checks before pushing SaaS changes:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm runtime:smoke
git diff --check
```

For narrow documentation-only changes, `git diff --check` plus a targeted review
is acceptable. Use judgment, but do not skip relevant checks for runtime changes.

Recommended local checks before pushing Action runtime changes:

```bash
npm run typecheck
npm test -- --runInBand
npm run build
git diff --check
```

The Action repo commits bundled `dist/` output. If a change affects runtime
code, rebuild and commit the bundle.

For hosted beta `@main` customers, SaaS action runtime changes must also be
synced into the public Action repo before they can be picked up by customer
workflows:

```bash
git -C ../review-router-action switch main
git -C ../review-router-action pull --ff-only origin main
pnpm action:artifact:check
pnpm action:sync-public-runtime -- --write
```

Then commit and push the resulting public Action repo changes to
`777genius/review-router@main`. Customer workflows using
`uses: 777genius/review-router@main` pick up that commit on their next run.

The `Sync Public Action Runtime` GitHub workflow performs this automatically
after a successful SaaS `CI` run on `main`. It requires one cross-repository
credential because the default `GITHUB_TOKEN` is scoped to
`777genius/review-router-saas` and cannot push to `777genius/review-router`.

Preferred credential:

- `REVIEW_ROUTER_ACTION_SYNC_SSH_KEY`: a write deploy key scoped only to
  `777genius/review-router`.

Fallback credential:

- `REVIEW_ROUTER_ACTION_SYNC_TOKEN`: a fine-grained PAT or GitHub App token
  with `Contents: write` on `777genius/review-router` and permission to push
  `main`.

## Release Order

For a new public/stable runtime release:

```text
1. Release 777genius/review-router at v1.0.x
2. Release 777genius/review-router-saas at the same v1.0.x
3. Verify both v1 tags resolve to the new exact release commits
4. Verify generated/setup PRs still use @v1 unless an exact pin was requested
```

Why the Action repo goes first:

- SaaS release workflow checks that the matching Action tag already exists.
- Customer workflows call the Action/reusable workflow first.
- Conflict runtime then checks out the SaaS runtime using the same `runtime_ref`.

## Action Runtime Release

Repository: `777genius/review-router`.

Before running the workflow:

1. Pick the next exact version, for example `v1.0.40`.
2. Update:
   - `package.json` version to `1.0.40`
   - `package-lock.json` root versions to `1.0.40`
   - `scripts/install.sh` `LATEST_RELEASE_TAG` to `v1.0.40`
3. Rebuild committed bundles with `npm run build`.
4. Run relevant local checks.
5. Commit to `main`.
6. Wait for CI on `main` or let the release workflow run its own gates.

Run the GitHub Actions workflow:

```bash
gh workflow run release.yml \
  -R 777genius/review-router \
  --ref main \
  -f version=v1.0.40 \
  -f create_github_release=true
```

The Action `Release` workflow validates:

- the requested version is `vN.N.N`
- it is running on `main`
- local `HEAD` matches `origin/main`
- the exact tag is absent, or already points to the same SaaS `HEAD` for a safe
  rerun
- the version is newer than the latest existing `v1.*.*` tag
- package metadata and installer fallback match the requested version
- dependencies install cleanly
- lint, typecheck, tests, and build pass
- committed release artifacts are clean after build

Only after those gates pass, it creates `v1.0.x`, force-moves `v1`, and creates
the GitHub Release.

## SaaS Runtime Release

Repository: `777genius/review-router-saas`.

Before running the workflow:

1. Merge the SaaS/runtime commit to `main`.
2. Wait for the `CI` workflow to pass on the exact commit.
3. Confirm the matching Action tag already exists, for example:

```bash
git ls-remote --tags https://github.com/777genius/review-router.git refs/tags/v1.0.40
```

Run the GitHub Actions workflow:

```bash
gh workflow run release.yml \
  -R 777genius/review-router-saas \
  --ref main \
  -f version=v1.0.40 \
  -f create_github_release=true
```

The SaaS `Release` workflow validates:

- the requested version is `vN.N.N`
- it is running on `main`
- local `HEAD` matches `origin/main`
- the exact tag does not already exist locally or remotely
- the version is newer than the latest existing `v1.*.*` tag
- the matching Action tag exists
- a successful `CI` run exists for the exact SaaS `HEAD`
- when `sync_production_action_ref=true`, production Render credentials can
  dry-run the requested Action ref override

Only after those gates pass, it creates `v1.0.x`, force-moves `v1`, and creates
the GitHub Release. Hosted beta production keeps `REVIEW_ROUTER_ACTION_REF` on
`777genius/review-router@main` by default. Normal release invocation:

```bash
gh workflow run release.yml \
  -R 777genius/review-router-saas \
  --ref main \
  -f version=v1.0.40 \
  -f create_github_release=true \
  -f sync_production_action_ref=false
```

If the workflow fails after publishing the exact tag, rerun with the same
version only when that exact tag already points to the same SaaS `GITHUB_SHA`.
The workflow allows that recovery path and still fails closed if the tag points
anywhere else.

Set `sync_production_action_ref=true` only for a deliberate rollback or smoke
override.

## Post-Release Verification

Verify both stable tags:

```bash
git ls-remote --tags https://github.com/777genius/review-router.git refs/tags/v1 refs/tags/v1.0.40
git ls-remote --tags https://github.com/777genius/review-router-saas.git refs/tags/v1 refs/tags/v1.0.40
```

Expected:

- `777genius/review-router@v1` points to the Action `v1.0.x` commit.
- `777genius/review-router-saas@v1` points to the SaaS `v1.0.x` commit.
- both GitHub Releases exist and are not draft/prerelease.
- new setup PRs that use stable mode still generate `@v1` and `runtime_ref: v1`.
- exact pinned mode generates the new `v1.0.x`.

If production Render deploy is part of the batch, deploy after the SaaS commit
has passed CI and after the relevant runtime release is validated. Check Render
logs after deploy for startup errors, webhook errors, and action session/config
errors.

## Production Action Ref Sync

Codex OAuth rotating workflows must match the configured ReviewRouter Action
ref, normally `777genius/review-router@main`. The SaaS control plane validates
that ref during GitHub OIDC preflight. This is intentional: a workflow that
silently switches to an untrusted Action ref must fail closed instead of
receiving checkout/comment/writeback tokens.

Normal hosted beta production should keep `REVIEW_ROUTER_ACTION_REF` on
`777genius/review-router@main`. Use the sync command only to restore that value
or for a deliberate full-SHA rollback, dogfood Action commit, emergency
correction, or rollout-window maintenance:

```bash
pnpm ops:sync-action-ref
```

By default, the command:

- writes `777genius/review-router@main`
- updates `REVIEW_ROUTER_ACTION_REF` on `reviewrouter-web`,
  `reviewrouter-api`, and `reviewrouter-worker`
- keeps `REVIEW_ROUTER_ALLOWED_ACTION_REFS` as a short full-SHA transition
  window when explicit rollback refs are present
- triggers Render deploys for the three services

When `--action-ref 777genius/review-router@v1` or an exact tag such as
`@v1.0.40` is provided, the command writes that hosted ref directly. Use a full
SHA for rollback refs that must also stay in `REVIEW_ROUTER_ALLOWED_ACTION_REFS`.

Useful variants:

```bash
pnpm ops:sync-action-ref --dry-run
pnpm ops:sync-action-ref --action-ref 777genius/review-router@main
pnpm ops:sync-action-ref --action-ref 777genius/review-router@<40-char-sha>
pnpm ops:sync-action-ref --no-deploy
pnpm ops:sync-action-ref --wait
pnpm ops:sync-action-ref --allowlist-window 3
```

Post-sync production checks:

```bash
curl -fsS https://api.reviewrouter.site/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://reviewrouter.site
pnpm ops:sync-action-ref --dry-run --no-deploy
```

`REVIEW_ROUTER_ALLOWED_ACTION_REFS` is a rollout safety window, not a channel.
Every value must be `owner/repo@40-char-sha` and must use the same Action
repository as `REVIEW_ROUTER_ACTION_REF`. Remove old SHAs by running the command
again with `--allowlist-window 1` after customer workflows have converged.

If a PR run fails with `action_repository_mismatch` immediately after an Action
runtime bump, run the sync command before rerunning the PR. The failure means the
OIDC guard worked: the workflow source and configured production action refs
were temporarily out of sync.

## Rollback

Rollback options, safest first:

1. Disable the risky feature flag or block the bad exact runtime version.
2. Roll back the SaaS app deployment in Render if the deployed app is bad.
3. Publish a fixed `v1.0.x` release and move `v1` forward through the release workflows.
4. Emergency only: move `v1` back to the last known-good exact tag in both repos.

Emergency rollback is the only normal exception to "do not move `v1` manually".
If used, record the incident, the old and new SHAs, and follow up with a fixed
release workflow run. Never rewrite exact `v1.0.x` tags.

Helpful emergency checks:

```bash
git ls-remote --tags https://github.com/777genius/review-router.git refs/tags/v1 refs/tags/v1.0.39
git ls-remote --tags https://github.com/777genius/review-router-saas.git refs/tags/v1 refs/tags/v1.0.39
```

## Database Release Rule

Release order for database-backed changes:

```text
1. merge reviewed Prisma migration
2. run migrate deploy in staging
3. run staging smoke tests
4. deploy compatible app/worker code
5. run production migrate deploy
6. deploy production app/worker code
```

Do not deploy application code that depends on a schema change before
`migrate deploy` has succeeded in that environment.

## Environments

Use separate environments:

```text
local
staging
production
```

Recommended:

- separate GitHub Apps for staging and production
- separate webhook secrets
- separate databases
- separate OAuth app/client secrets if applicable
- staging uses test org/repos only

## Feature Flags

## Review Action v2 Release Order

Deploy the typed 426 bridge first. Then deploy additive migrations and disabled
SaaS readers, export the generated contract to a public Action feature branch,
rebuild/commit `dist/index.js`, and register the exact final Action/runtime/schema
digests. For an allowlisted repository: preflight all decisions and credentials,
enter `v1_draining`, wait the release-bound drain window, prove no legacy/static
writer, then activate the new mutation epoch as the final command. Failure after
activation pauses v2 and reconciles effects; it never reopens v1. See
[ADR-028](../decisions/028-revision-aware-review-evidence.md).

### Durable T0 request ingress cutover

Use this order. Do not combine the steps into one blind configuration update:

1. Apply migration `000033_review_request_dispatch_lanes` while all new writers
   remain disabled. Its preflight must find no duplicate/expired active provider
   lane and no duplicate pending/source-run intent identity.
   Then apply `000034_review_request_dispatch_reconciliation`. Its preflight must
   find zero intents in legacy `dispatching`; if any exist, stop and reconcile
   them with the old runtime before retrying the migration. The migration smoke
   gate seeds one legacy `dispatching` intent in a disposable PostgreSQL database,
   requires this preflight failure, and verifies that enum, columns, types,
   indexes, and the fixture row are unchanged after transaction rollback.
2. Deploy the API, worker, and exact public Action commit with intent ingress and
   admission requirement disabled.
3. Install the generated T0 workflow pinned to that full Action SHA. Verify it has
   `workflow_dispatch`, `review_request_id`, `pr_number`, `review_head_sha`, the
   deterministic run name, and exact-head checkout. The interaction workflow may
   remain only when it uses OIDC and is pinned to the same immutable runtime SHA;
   a stale interaction runtime or a legacy review workflow blocks activation.
4. Register the immutable producer release/attestation and verify provider vote
   lane, signing key, GitHub App `actions: write` permission, installation
   approval, and workflow dispatch path.
5. Enable `REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED=1`, then
   `REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED=1`, and prove the worker handles
   both external and internal ingress event versions.
6. Set `REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY=1` only after a disposable
   repository dispatch returns a run ID and exact head.
7. Enable `REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED=1`. The API must refuse
   startup unless steps 5 and 6 are already true.
8. After persisted intents dispatch and bind to OIDC runs correctly, enable
   `REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED=1` for the cohort.

Dispatch recovery is deliberately asymmetric:

- Persist `reconciling_dispatch` before the single GitHub workflow dispatch POST.
- A returned run ID binds the intent directly; a lost/unknown response is resolved
  only by bounded workflow-run lookup and never by repeating that POST.
- Retry with a new request identity only after a definite no-effect result and
  within `REVIEW_ROUTER_REVIEW_V2_INTENT_MAX_DISPATCH_ATTEMPTS`.
- Terminalize an unresolved dispatch or missing OIDC authorization at its
  persisted deadline, then release the PR lane. Best-effort cancellation targets
  only the exact known workflow run.
- Keep the dispatch resolution window shorter than the authorization window. The
  production defaults are 5 minutes and 30 minutes respectively, allowing normal
  hosted-runner queue delay without treating it as an unknown POST outcome.

Rollback before step 8 disables ingress first and drains persisted intents through
the still-enabled worker. After intent-required admission or v2 mutation authority
is active, pause the cohort and reconcile state; never route those runs back to an
unfenced legacy writer. A dead-lettered ingress event requires explicit recovery,
not replay through the same webhook idempotency key.

Critical flags:

```text
REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE
REVIEW_ROUTER_ALLOWED_ACTION_REFS
REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS
REVIEW_ROUTER_HOSTED_MAX_CHANGED_LINES
REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS
REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK
REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED
REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED
REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY
REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED
REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED
REVIEW_ROUTER_REVIEW_V2_INTENT_DISPATCH_RESOLUTION_TIMEOUT_MS
REVIEW_ROUTER_REVIEW_V2_INTENT_AUTHORIZATION_TIMEOUT_MS
REVIEW_ROUTER_REVIEW_V2_INTENT_MAX_DISPATCH_ATTEMPTS
```

Flags must fail closed for security-sensitive features.

`REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS` is a comma-separated exact-match
blocklist for known-bad installed Action versions, for example
`v1.0.0,main-bad-sha`. It should be used as an emergency stopgap and followed
by a fixed release or workflow update PR.

`REVIEW_ROUTER_HOSTED_MAX_CHANGED_LINES` is the positive-integer,
server-authoritative ceiling for an admitted review. It defaults to `250000`.
The API verifies exact pull-request facts and persists the admission decision
before issuing an OIDC nonce or provider lease. A repository-level
`REVIEW_ROUTER_MAX_CHANGED_LINES` may be stricter, but it cannot raise or
disable this hosted ceiling.

`REVIEW_ROUTER_ALLOWED_ACTION_REFS` is a comma-separated full-SHA allowlist used
only for trusted rollout overlap during pinned Codex OAuth rotating releases.
