# Review Action v2 Contract Handoff Runbook

Use a dedicated public Action worktree on a feature branch. Never target `main`.

## 1. Verify Canonical SaaS Output

```bash
pnpm protocol:check
pnpm protocol:handoff:test
```

Record immutable fences:

```bash
export SAAS_HEAD="$(git rev-parse HEAD)"
export ACTION_REPO="/absolute/path/to/public-action-worktree"
export ACTION_BRANCH="$(git -C "$ACTION_REPO" branch --show-current)"
export ACTION_BASE="$(git -C "$ACTION_REPO" rev-parse HEAD)"
```

Both SHAs must contain exactly 40 lowercase hexadecimal characters.

## 2. Dry-Run and Export

```bash
pnpm protocol:export-public \
  --action-repo "$ACTION_REPO" \
  --target-branch "$ACTION_BRANCH" \
  --expected-head "$ACTION_BASE" \
  --expected-saas-head "$SAAS_HEAD"
```

Review the handoff, then write it:

```bash
pnpm protocol:export-public \
  --action-repo "$ACTION_REPO" \
  --target-branch "$ACTION_BRANCH" \
  --expected-head "$ACTION_BASE" \
  --expected-saas-head "$SAAS_HEAD" \
  --write
```

Build the public Action with its repository-owned command. Commit only the
generated v2 directory and rebuilt `dist/index.js` with the intended runtime
changes. Run the public Action test and bundle gates before continuing.

## 3. Emit Final Release Manifest

After the Action worktree is clean:

```bash
export ACTION_RELEASE="$(git -C "$ACTION_REPO" rev-parse HEAD)"
export RELEASE_MANIFEST="$(mktemp -d)/review-action-v2-release.json"

pnpm protocol:release-manifest \
  --action-repo "$ACTION_REPO" \
  --target-branch "$ACTION_BRANCH" \
  --expected-head "$ACTION_RELEASE" \
  --output "$RELEASE_MANIFEST"
```

Do not write the release manifest into the public Action repository. Its commit is
an input to the manifest.

## 4. Cross-Repository Check

```bash
pnpm protocol:release-manifest:check \
  --manifest "$RELEASE_MANIFEST" \
  --saas-repo "$(pwd)" \
  --action-repo "$ACTION_REPO"
```

Only the checked release manifest may be passed to producer-release registration.
Registration and capability rollout are later units and are not performed by these
commands.

## Failure Recovery

- Stale expected HEAD: stop, inspect new commits, and rerun with a newly reviewed
  base. Never relax the fence.
- Unmanaged target: move handwritten code out of the generated directory. Do not
  delete it through the exporter.
- Dirty source or bundle: regenerate, review, and commit through the owning
  repository first.
- Different existing release output: allocate a new artifact path. Release
  manifests are immutable.
- Wrong branch or `main`: create a new feature branch and repeat the export.
