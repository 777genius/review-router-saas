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
v1       - stable moving major channel, default for production setup PRs
v1.0.x   - immutable exact release tag, conservative pinned customer option
main     - live development channel, opt-in only for dogfood or emergency testing
```

Rules:

- Never default production customer workflows to `main`.
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
- the exact tag does not already exist locally or remotely
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

Only after those gates pass, it creates `v1.0.x`, force-moves `v1`, and creates
the GitHub Release.

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

Codex OAuth rotating workflows are pinned to a full Action commit SHA, and the
SaaS control plane validates that exact ref during GitHub OIDC prelease. This is
intentional: a workflow that silently switches to an untrusted Action commit
must fail closed instead of receiving checkout/comment/writeback tokens.

Use the sync command after pushing a new `777genius/review-router` Action commit:

```bash
pnpm ops:sync-action-ref
```

By default, the command:

- resolves `777genius/review-router@refs/heads/main` to a 40-character SHA
- updates `REVIEW_ROUTER_ACTION_REF` on `reviewrouter-web`,
  `reviewrouter-api`, and `reviewrouter-worker`
- writes `REVIEW_ROUTER_ALLOWED_ACTION_REFS` as a short rolling window that
  includes the new SHA and the previous SHA
- triggers Render deploys for the three services

Useful variants:

```bash
pnpm ops:sync-action-ref --dry-run
pnpm ops:sync-action-ref --action-ref 777genius/review-router@<40-char-sha>
pnpm ops:sync-action-ref --no-deploy
pnpm ops:sync-action-ref --allowlist-window 3
```

`REVIEW_ROUTER_ALLOWED_ACTION_REFS` is a rollout safety window, not a channel.
Every value must be `owner/repo@40-char-sha` and must use the same Action
repository as `REVIEW_ROUTER_ACTION_REF`. Remove old SHAs by running the command
again with `--allowlist-window 1` after customer workflows have converged.

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

Critical flags:

```text
REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE
REVIEW_ROUTER_ALLOWED_ACTION_REFS
REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS
REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING
REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS
REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK
```

Flags must fail closed for security-sensitive features.

`REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS` is a comma-separated exact-match
blocklist for known-bad installed Action versions, for example
`v1.0.0,main-bad-sha`. It should be used as an emergency stopgap and followed
by a fixed release or workflow update PR.

`REVIEW_ROUTER_ALLOWED_ACTION_REFS` is a comma-separated full-SHA allowlist used
only for trusted rollout overlap during pinned Codex OAuth rotating releases.
