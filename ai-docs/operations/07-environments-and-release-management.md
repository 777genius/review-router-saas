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
- Hosted-pool SaaS workflows are an exception to the mutable hosted-beta
  channel: they consume the exact public Action commit recorded with its
  immutable release tag and `dist/index.js` SHA-256. Before configuring SaaS,
  run `pnpm hosted-pool:action-release:verify` against a clean checkout of that
  Action commit. The verifier requires `HEAD`, the tag's peeled commit, the
  SaaS-consumed action ref, and the bundle digest to be one exact tuple.

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
2. Pin REVIEW_ROUTER_PAIRED_ACTION_REF in SaaS CI to that exact Action commit
3. Merge the pin and wait for SaaS CI on the resulting exact commit
4. Release 777genius/review-router-saas at the same v1.0.x
5. Verify both v1 tags resolve to the new exact release commits
6. Verify generated/setup PRs still use @v1 unless an exact pin was requested
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

### Release Authority schema ordering

When a candidate adds a migration under
`packages/platform/release-authority-db/migrations`, database authority moves
before code authority. After the exact protected `main` SHA passes the
`Dedicated Release Authority PG17 contract`, keep provider auto-deploy disabled
and run `.github/workflows/release-authority-migration.yml` at that SHA with
`operation=incremental-upgrade`. The protected
`production-release-authority-migration` environment is the sole production
holder of the restricted migration-issuer credential. The issuer can create a
short-lived, operation-bound login but cannot inherit database-owner authority
or mutate the authority catalog directly. A successful gate on
that exact SHA is required before deploying control, witness, or other code
whose readiness depends on the new authority catalog.

That environment must retain at least one required reviewer, prevent self
review, and allow only protected branches. The workflow verifies those settings
through the GitHub API in its repository-independent trust job and fails closed
before the issuer credential is available to any job.

Fresh provisioning is a different operation: use `operation=fresh-install`
only for a new database with no `release_authority` schema. Neither operation
falls back to the other. The normative setup, upgrade, failure, and recovery
procedure is in
[`docs/operations/private-pg17-release-rollout.md`](../../docs/operations/private-pg17-release-rollout.md).

Before running the workflow:

1. Merge the SaaS/runtime commit to `main`.
2. Confirm the matching Action tag already exists, for example:

```bash
git ls-remote --tags https://github.com/777genius/review-router.git refs/tags/v1.0.40
```

3. Resolve that tag to its immutable Action commit and update
   `REVIEW_ROUTER_PAIRED_ACTION_REF` in `.github/workflows/ci.yml` through a PR.
4. Wait for the trusted `CI` workflow on the resulting exact `main` commit to
   pass. Its
   production gate must include both `Dedicated Release Authority PG17
contract` and `Full private PG16 to PG17 rehearsal` as successful jobs.
   Each job uploads its own exact-SHA evidence artifact.
   A manual CI dispatch that enables the authority contract must set
   `release_authority_contract_baseline_sha` to the previous protected `main`
   SHA; push CI derives the same fact from the protected push event. Its
   `paired-action-release-gate` artifact must name the same Action commit as the
   release tag.
5. Confirm the GitHub `production-release` environment exists, requires at
   least one reviewer, prevents self-review, and permits protected branches
   only. `main` itself must remain protected. These are external repository
   settings; the workflow audits them and fails closed but does not create or
   repair them. Store `SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64` there and, when the
   optional production Action-ref sync is used, store its scoped
   `RENDER_API_KEY` there as environment secrets rather than repository
   secrets.

Run the GitHub Actions workflow:

```bash
gh workflow run release.yml \
  -R 777genius/review-router-saas \
  --ref main \
  -f version=v1.0.40 \
  -f create_github_release=true
```

The SaaS `Release` workflow validates:

- an inline, read-only bootstrap runs before checkout or repository code and
  proves that the dispatch workflow ref is `refs/heads/main`, the dispatch SHA
  is still current protected `main`, and `production-release` has the required
  reviewer and protected-branch policy
- the requested version is `vN.N.N`
- it is running on `main`
- local `HEAD` matches `origin/main`
- the exact tag does not already exist locally or remotely
- the version is newer than the latest existing `v1.*.*` tag
- the matching Action tag exists
- one successful trusted `CI` run exists for the exact SaaS `HEAD`, and that
  exact run contains successful, non-skipped `Dedicated Release Authority PG17
contract` and `Full private PG16 to PG17 rehearsal` jobs
- the same exact CI run owns both unexpired, digest-addressed evidence
  artifacts; each artifact manifest binds the repository, commit, run ID, run
  attempt, exact job name, and SHA-derived artifact name
- when `sync_production_action_ref=true`, production Render credentials can
  dry-run the requested Action ref override
- one `linux/amd64` hosted runtime image containing web, API, and worker builds
  from the exact release commit and publishes to GHCR
- GHCR resolves the published image to an immutable OCI manifest digest; the
  workflow uploads `hosted-runtime-image-<version>` with the exact
  commit/image URL/digest tuple used by the Render deployment gate

The repository checkout uses only the SHA emitted by that bootstrap and never
persists checkout credentials. The write-capable release job cannot start
until the `production-release` environment gate is satisfied; package, OIDC,
tag, release, and Render credentials are introduced only after bootstrap.
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

The two PostgreSQL gates intentionally do not run for pull requests, including
fork pull requests. They run together on the trusted push to `main`, so an
ordinary low-risk PR does not duplicate the expensive real-PostgreSQL work.
They may also be run manually from `main`, but both workflow-dispatch inputs
must be enabled in the same run for that run to qualify. A successful CI run
that skipped either job is not release evidence. The release verifier also
fails closed for a stale commit, a job or artifact from another run, a failed
job, a missing artifact, an expired artifact, or artifact bytes whose provider
digest or exact manifest does not match.

If the trusted push run failed for infrastructure reasons, dispatch a new CI
run on the exact `main` commit with both PostgreSQL inputs enabled. Do not
bypass the verifier with a generic green CI run or locally created JSON. No
hosted or GitLab runtime image build, package publication, tag movement,
GitHub Release, or downstream production deploy may start until the verifier
accepts the exact run and both immutable artifacts. The `GitLab Runtime Image`
workflow applies the same gate before GHCR login or image construction for
both automatic `workflow_run` publication and manual dispatch.

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

General workflows and rotating Codex workflows use separate release contracts:

- `REVIEW_ROUTER_ACTION_REF` may remain
  `777genius/review-router@main` for the general workflow channel.
- `REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF` is mandatory and must be an exact
  `owner/repo@40-character-SHA`.
- `REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS` is a bounded,
  same-repository list of old exact SHAs still needed by active namespaces or
  queued/in-progress runs. The primary SHA is trusted automatically.

Rotating T0 rendering, installer URLs, OIDC source verification, and runtime
writeback must never fall back to the mutable general channel. A workflow that
switches to an untrusted ref fails closed before receiving checkout, comment,
or writeback capability.

The general ref sync remains available for non-rotating workflows:

```bash
pnpm ops:sync-action-ref
```

By default, that command:

- writes `777genius/review-router@main`
- updates `REVIEW_ROUTER_ACTION_REF` on `reviewrouter-web`,
  `reviewrouter-api`, and `reviewrouter-worker`
- does not change the rotating primary or rotating overlap list
- triggers Render deploys for the three services

When `--action-ref 777genius/review-router@v1` or an exact tag such as
`@v1.0.40` is provided, the command writes that general hosted ref directly.

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

For a rotating A -> B release, use this fail-closed order:

1. Keep primary A and deploy a trusted overlap containing B to every web/API
   instance. Wait for all exact deployments to be live.
2. Change the rotating primary to B for new setup candidates while retaining A
   in the overlap. Update the installer descriptor as one release tuple at the
   same time: `REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION`,
   `REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL`, and
   `REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256`. The immutable installer URL
   must contain B's exact Action SHA, even when the script digest did not change
   between releases. Deploy web, API, and worker only after every value in the
   tuple has been staged; a partial tuple intentionally blocks setup issuance.
3. Do not rewrite an active A namespace in place. Existing namespaces remain
   pinned to their already-attested Action SHA; migrate them only through a
   fenced drain and fresh setup/namespace activation.
4. Retain A while any repository namespace, queued/in-progress workflow, or
   unexpired mutation lease can reference it. Default-branch fast-forwards do
   not invalidate a queued workflow when its claimed revision remains a
   verified ancestor and its exact workflow attestation still matches.
5. Remove A only after two inventories show zero live references and the
   maximum queue/lease window has elapsed. Never prune by a fixed list length.

The current namespace schema stores one exact active workflow attestation.
Allowlisting A and B does not make an in-place A -> B rewrite safe: overwriting
the attestation strands queued A, while retaining it blocks B. Concurrent
in-place migration requires a future bounded attestation-history schema; until
then, drain and allocate a fresh namespace.

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
REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF
REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS
REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS
REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS
REVIEW_ROUTER_HOSTED_MAX_CHANGED_LINES
REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS
REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH
REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED
REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED
REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES
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

Hosted release convergence keeps all three rotating OAuth flags at exact `0`.
Setup issuance and new-work admission enable only on exact `1`. New-work also
requires a nonempty explicit repository cohort; an empty cohort never means
"all" while admission is enabled. Follow the fenced bridge/canary/widening
state machine in
[`08-codex-rotating-serialization-cutover.md`](./08-codex-rotating-serialization-cutover.md).

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

Action terminal outcomes must be user-readable in the PR and in the Actions
step summary. `skipped`, stale/superseded, partial, and provider-lane-busy
states should explain the human reason, whether a model call was started, and
whether the result is approval evidence. Service markers such as
`reviewrouter:summary:*` may exist only inside hidden HTML comments or protocol
payloads, never as visible PR text.

Token telemetry is metadata-only. Action logs may include provider name,
provider status, prompt token count, completion token count, and total token
count. Logs, comments, checks, health reports, and support diagnostics must not
include prompts, diffs, model responses, Codex auth JSON, refresh tokens, access
tokens, or provider secrets.

For rotating Codex OAuth, do not run `gh secret set
REVIEWROUTER_CODEX_AUTH_JSON` directly. That bypasses the generation contract
and can make queued workflows restore an older secret generation. Use
`scripts/reseed-codex-rotating-auth.sh` so the reseed follows the expected
rotating-auth write path.

`REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS` is the comma-separated
full-SHA overlap used only for rotating namespace releases. It never authorizes
a branch/tag and never changes the exact Action SHA pinned in an active
namespace.
