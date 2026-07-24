# Review Action v2 cutover

This runbook activates repository-wide T0 review mutation authority. Activation
is one-way: after `v2_active`, failure recovery uses `pause`, not a return to v1.

## Preconditions

- API and worker contain the same release and migration, with both v2 flags `0`.
- The public Action release is committed, built, and represented by a validated
  external release manifest.
- Authorization and capability key rings are configured.
- Producer release attestations, provider vote lanes, and projection policy are
  configured without secrets in logs.
- Context session HMAC and replay key rings are configured on the API. The
  context gateway policy version and exact committed gateway bundle SHA-256 are
  configured identically on the API and worker.
- The production GitHub App registration grants repository `Actions: Read and
write`, and the target installation has approved that permission update.
  `Workflows: Read and write` is a different permission and does not authorize
  workflow dispatch.
- `REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256` is configured. Supply the
  plaintext credential only to the one operator shell process; do not store it in
  the shared Render environment group.

Validate configuration without printing values:

```bash
pnpm review-v2:admin env-preflight
```

## Release bundle

`release register` accepts one JSON object containing
`protocolLimitsProfileId`, `limits`, `operationalSloProfileId`, `thresholds`,
`ownerRefs`, `runbookRefs`, and `candidate`. The candidate comes from the
validated public release manifest and must use the same profile IDs.

```bash
pnpm review-v2:admin release register \
  --bundle /secure/path/review-v2-release-bundle.json \
  --confirm release
```

## Repository cutover

Use an exact `OWNER/REPO` confirmation on every mutation:

```bash
pnpm review-v2:admin cohort stage \
  --repo OWNER/REPO \
  --confirm OWNER/REPO

pnpm review-v2:admin mutation initialize-v1 \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Provision the generated T0 workflow at the full 40-character Action release SHA
through the existing workflow-provisioning application service. Verify the
default branch, all base branches of open pull requests, and all current
mergeable pull request test-merge commits whose recorded base SHA equals the
current base tip. Test merges built from an older base tip are recorded as
historical and handled by the v1 rerun drain fence. Each covered
`.github/workflows/reviewrouter-codex.yml` must be absent or valid at the exact
ref, and legacy `reviewrouter.yml` must be absent. The default branch must contain
the valid managed workflow. A conflicted pull request is accepted only after
GitHub reports `mergeable: false`; unknown mergeability fails closed.

The interaction workflow may be absent. If
`.github/workflows/reviewrouter-interaction.yml` is present on the default branch,
it must use OIDC, grant `id-token: write`, bind `reviewrouter-codex.yml`, and check
out `777genius/review-router` through an environment variable pinned to the same
full 40-character Action release SHA. Inventory preflight rejects stale,
unpinned, statically authenticated, or differently bound interaction writers.

Enable API and worker v2 composition and verify service health before closing v1
admission. Start the drain with the registered release ID:

```bash
pnpm review-v2:admin mutation begin-drain \
  --repo OWNER/REPO \
  --release PRODUCER_RELEASE_ID \
  --confirm OWNER/REPO
```

The CLI reads `v1DrainMs` from that release's registered SLO profile and refuses
a shorter override. Do not bypass or backdate the drain.

After `drainNotBefore`, activation collects and immediately revalidates a
60-second proof covering legacy admission closure, complete executable-workflow
authority inventory, exact registered Action SHA, worker configuration,
repository-scoped GitHub `actions: write` token minting, and safety policy.
Missing or unapproved dispatch permission returns
`dispatch_capability_unavailable` and leaves the authority in `v1_draining`.
Transient GitHub failures abort preflight instead of being misreported as a
permission denial:

```bash
pnpm review-v2:admin mutation activate \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Run one real review, inspect the managed check, inline findings, summary,
publication receipts, worker logs, and operator status. On any ambiguous effect:

```bash
pnpm review-v2:admin mutation pause \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Do not resume until publication reconciliation reports no `stale_visible` or
`terminal_unknown` outcomes and the resume proof is ready.

## Context-attested cross-revision reuse

Keep context reuse separate from the T0 mutation cutover. After a registered
Action release has produced accepted confined observations, enable replay in
shadow mode for one repository:

```bash
pnpm review-v2:admin cohort context-reuse shadow \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Promote only after replay telemetry shows no stale publications, fencing
violations, unconfined sessions, or material shadow disagreements:

```bash
pnpm review-v2:admin cohort context-reuse enable \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Disable attachment for one repository without changing the global enrollment
gate:

```bash
pnpm review-v2:admin cohort context-reuse disable \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Prompt-only cross-revision reuse remains disabled. These commands control only
dependency-attested context-gateway reuse.
