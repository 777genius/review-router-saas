# Review Action v2 cutover

This runbook activates repository-wide T0 review mutation authority. Activation
is one-way: after `v2_active`, failure recovery uses `pause`, not a return to v1.

For a self-hosted Compose deployment, run every `review-v2:admin` operation
through the `rr_admin` container wrapper in the
[self-hosted end-to-end guide](./review-router-self-hosted-end-to-end.md).

For a hosted deployment, run the CLI in a dedicated one-off maintenance job
with the exact API runtime environment. Do not launch `pnpm review-v2:admin`
inside a serving web instance: package-manager and CLI startup can exceed a
small instance's memory budget, recycle the web process, and briefly return
502 responses. The maintenance job may invoke the already-built entrypoint
directly to avoid package-manager overhead:

```bash
node scripts/run-with-env.mjs \
  node --conditions=production \
  apps/api/dist/review-action-v2-operator-cli.js \
  env-preflight
```

Keep the plaintext operator credential only in the maintenance process
environment. Require `env-preflight` to report `ready: true` before a mutating
command, and remove the job after the operation. Never export production
database or signing material into a developer shell as a substitute for the
one-off job.

## Preconditions

- API and worker contain the same release and migration. A server-dispatched
  rollout keeps both v2 flags `0` until its controlled cutover. A self-hosted
  client-triggered Direct V2 deployment instead uses the strict T0 flag set in
  the self-hosted guide and must keep intent ingress and dispatch disabled.
- The public Action release is committed, built, and represented by a validated
  external release manifest.
- Authorization and capability key rings are configured.
- Producer release attestations, provider vote lanes, and projection policy are
  configured without secrets in logs.
- Context session HMAC and replay key rings are configured on the API. The
  context gateway policy version and exact committed gateway bundle SHA-256 are
  bound to the immutable producer release. They are not shared API/worker
  environment variables.
- Managed-dispatch mode requires repository `Actions: Read and write`, and the
  target installation must approve that permission update. `Workflows: Read and
write` is a different permission and does not authorize dispatch.
- Client-triggered Direct V2 accepts the narrower `review-only` App profile. It
  requires the canonical schema-2 workflow and must keep intent ingress,
  intent admission, and server-side dispatch disabled.
- `REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256` is configured. Supply the
  plaintext credential only to the one operator shell process; do not store it in
  the shared Render environment group.

Validate configuration without printing values:

```bash
# Self-hosted Compose:
rr_admin env-preflight

# Other deployment compositions:
pnpm review-v2:admin env-preflight
```

## Release bundle

Generate and validate a release manifest from the exact committed Action
revision. Legacy Context Gateway v3 metadata produces manifest v2 and cannot
claim investigation capability. Investigation metadata v2 produces manifest v3
only when Context Gateway v4 is primary, v3/v4 support is explicitly
authenticated, and the `review_investigation_v1` coverage-profile and policy
hashes match the checked golden fixture. The verifier hashes both committed
entrypoints; a missing or modified context gateway bundle fails the release:

```bash
pnpm protocol:release-manifest \
  --action-repo /path/to/review-router \
  --target-branch RELEASE_BRANCH \
  --expected-head ACTION_COMMIT_SHA \
  --output /secure/path/review-action-v2-release-manifest.json

pnpm protocol:release-manifest:check \
  --manifest /secure/path/review-action-v2-release-manifest.json \
  --action-repo /path/to/review-router
```

Treat the verifier output and the database registration candidate as different
typed projections of the same release. Remove the verification-only
`saasSourceCommit`, `supportedContextGatewayPolicyVersions`, and
`canonicalizerDigest` fields before placing the verifier output under
`candidate`. Keep `canonicalizerDigest` in the runtime producer attestation:
authorization validates it there, while the `ProducerRelease` database model
does not own that field. Never pass the verifier object to `release register`
unchanged.

`release register` accepts one JSON object containing
`protocolLimitsProfileId`, `limits`, `operationalSloProfileId`, `thresholds`,
`ownerRefs`, `runbookRefs`, and `candidate`. The candidate comes from the
validated public release manifest, including its context gateway policy and
entrypoint digest, and must use the same profile IDs. The validation output also
records the authenticated supported-policy list. An investigation candidate
carries a nested capability identifier, coverage-profile hash, and policy hash;
legacy candidates use a null investigation profile and cannot open or reuse
investigation context evidence. Do not enter investigation hashes manually;
they are derived from the committed Action metadata and checked golden fixture.
The registration candidate is the normalized domain shape, not the raw generated
manifest: it must contain an explicit `reviewInvestigationProfile` object (or
explicit `null` for a legacy release). Raw flattened
`reviewInvestigationCapability`, `reviewInvestigationCoverageProfileHash`, and
`reviewInvestigationPolicyHash` fields are rejected. `canonicalizerDigest`
belongs to the producer attestation assembled from the same validated manifest,
not to the database registration candidate.

Promote all release wiring as one operational change. Database registration by
itself is insufficient: the exact Action ref must also be trusted by the hosted
runtime and the exact producer attestation must be present in both API and
worker configuration. Preserve still-active rollback refs and attestations
until their runs drain. A canary is allowed only after all three projections
agree on release ID, Action commit, runtime commit, schema digest, entrypoint
digests, Context Gateway policy, and investigation capability hashes.

Projection policy compatibility is versioned independently from the current
deployment default. Finalization accepts only policy versions supported by the
publishing domain and persists the exact version from the producer envelope; it
must not relabel an older producer as the current policy. Remove a legacy policy
only after every registered producer using it has been retired and its in-flight
authorizations have drained.

Publication operation identity is scoped to its publication attempt. This lets
two executions publish the same projection without colliding in the operation
ledger. Existing projection-scoped operation IDs remain restorable through the
explicit `LegacyProjectionV1` compatibility path. Roll this out reader-first:
deploy API and worker support for both versions while new attempts still use
`LegacyProjectionV1`, then switch the shared write version to `AttemptScopedV2`
only after both services run the compatibility release. A request conflict must
reload the winning attempt identity and retry once. Remove the legacy path only
after all pre-cutover publication attempts have reached a terminal state and
passed retention.

```bash
pnpm review-v2:admin release register \
  --bundle /secure/path/review-v2-release-bundle.json \
  --confirm release
```

If a release is registered with the wrong immutable metadata, do not edit or
delete its database row. Keep it out of the attestation registry and revoke it
through the domain command before registering a corrected release ID:

```bash
pnpm review-v2:admin release revoke \
  --release INCORRECT_PRODUCER_RELEASE_ID \
  --confirm INCORRECT_PRODUCER_RELEASE_ID
```

Revocation is irreversible. The confirmation must exactly match `--release`;
the CLI rejects generic confirmation values so a pasted or mistyped target
cannot be revoked accidentally.

## Repository cutover

There are two mutually exclusive entry paths:

- Existing identities, including every identity present during migration v7,
  are conservatively fenced as `v1_open` and use drain/activate.
- A repository onboarded after v7 may use `initialize-direct-v2` only when it
  has never issued a legacy mutation capability and the canonical schema-2
  workflow inventory and all other proof facts pass.

Use an exact `OWNER/REPO` confirmation on every mutation:

```bash
pnpm review-v2:admin cohort stage \
  --repo OWNER/REPO \
  --confirm OWNER/REPO

pnpm review-v2:admin mutation initialize-v1 \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

For an eligible fresh client-triggered repository, use this instead of
`initialize-v1`:

```bash
pnpm review-v2:admin mutation initialize-direct-v2 \
  --repo OWNER/REPO \
  --confirm OWNER/REPO
```

Migration leaves the global emergency stop active. After staging the intended
repository cohort, explicitly open it:

```bash
pnpm review-v2:admin emergency global open --confirm global
```

Global T0 policies remain allowlisted, so this does not enroll unstaged
repositories. Restore the global kill switch immediately when containment is
required:

```bash
pnpm review-v2:admin emergency global stop --confirm global
```

Legacy admission and direct initialization serialize on the same
repository-scoped database lock. Never reset or delete the authority row to
force direct initialization.

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
repository-scoped execution authority, and safety policy. Managed dispatch
requires GitHub `actions: write`; client-triggered schema 2 proves its narrower
execution authority from the canonical workflow inventory. Missing or
unapproved managed-dispatch permission returns
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
