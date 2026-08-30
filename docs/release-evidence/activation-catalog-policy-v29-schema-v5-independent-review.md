# Schema-v5 exact provenance review artifact

## Decision

- Verdict: **GO**
- BLOCKER: **0**
- HIGH: **0**
- MEDIUM: **0**
- Reviewer run ID: `rr-pr245-r253-schema-v5-provenance-review`
- Decision ID: `RR-PR245-SCHEMA-V5-GO-79C8496D-B138EB3E-20260830`
- Reviewed at: `2026-08-30T14:26:32Z`

## Exact identities

| Identity | Exact value |
|---|---|
| Merge/current-main baseline | `ee46dfbacd25d8e0f18f5cffb5a5d0b4d78f3385` |
| `captureBaseCommit` for this capture | `79c8496d64b63c129e19331ee328666f714d82b1` |
| `independentReview.baseCommit` | `79c8496d64b63c129e19331ee328666f714d82b1` |
| `auditedHead` | `79c8496d64b63c129e19331ee328666f714d82b1` |
| Audited tree | `1cdb05db1f73eb2bf294d774d517fff533ca24bc` |
| Workflow run | `33315824201` |
| Run attempt | `1` |
| Job | `99268972795` |
| Artifact ID | `9733425691` |
| Artifact name | `activation-catalog-policy-79c8496d64b63c129e19331ee328666f714d82b1-1` |

Terminology is deliberate: `ee46dfba…` is only the merge/current-main comparison baseline and second parent of the audited merge. It must not be emitted as `captureBaseCommit` or `independentReview.baseCommit`. Both provenance fields bind the exact capture-producing source commit, `79c8496d…`.

## Candidate bytes

| Candidate | Bytes | Raw SHA-256 |
|---|---:|---|
| [candidate 1](/mnt/volume_ams3_1784742570542/evidence/rr-pr245-79c8496d-schema-v5-candidate/activation-catalog-policy-candidate-1.json:1) | `2,651,682` | `b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28` |
| [candidate 2](/mnt/volume_ams3_1784742570542/evidence/rr-pr245-79c8496d-schema-v5-candidate/activation-catalog-policy-candidate-2.json:1) | `2,651,682` | `b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28` |

`cmp` returned equality. Independent parsing established strict UTF-8 round-trip, no duplicate keys, no floating-point or unsafe-integer tokens, and exactly the root keys `kind`, `version`, `policies`, and `liveCatalogDigest`. Kind is `reviewrouter-activation-catalog-policy-artifact-candidate`; version is `2`.

## Pinned images, source hashes, and canonical digests

- PostgreSQL 16 source: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`
- PostgreSQL 17 target: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`
- Live catalog projection source SHA-256: `39e855060bfc186c6fb92fe1cd5c72410f8f72802200da49d6c1fe45eb6ed5f4`
- Normalization source SHA-256: `7b23d64a1f2160398cdeb9194b0a3f3583e5566a1b20a0b2009caaf7ddbe0da1`

| Canonical value | Digest |
|---|---|
| Live catalog / release transition | `sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d` |
| Preactivation policy | `sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b` |
| Activated policy | `sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b` |
| Promotable artifact | `sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf` |

Independent recursive key-sorted canonicalization reproduced all three policy/artifact digests. Canonical byte lengths were `1,178,551` preactivation, `1,472,913` activated, and `2,651,577` for the artifact envelope.

The candidate live digest exactly matches `canonicalReleaseMigrationArtifact.postCatalogDigest` at [release-migration-transition.ts](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/release-rollout/src/domain/release-migration-transition.ts:139). The migration runner independently recomputes the installed catalog and rejects a receipt mismatch at [run-codex-rotating-release-migration.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/run-codex-rotating-release-migration.mjs:5358). The capture then copies that receipt value into `liveCatalogDigest` at [rehearse-private-pg17-rollout.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:446).

## Capture provenance

The workflow uses two distinct run/attempt-derived disposable identities, digest-pinned images, byte comparison, SHA-256 output, SHA-pinned checkout/setup/upload actions, and fail-on-missing artifact upload at [ci.yml](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/.github/workflows/ci.yml:136).

The source enforces:

- A container-created target distinct from the source and a valid disposable identity at [rehearse-private-pg17-rollout.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:396).
- Database/system/recovery-witness attestation before projection at [rehearse-private-pg17-rollout.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:3728).
- PostgreSQL 17, database name, exact session user, zero projection violations, and disposable marker checks at [run-codex-rotating-release-migration.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/run-codex-rotating-release-migration.mjs:2173).
- Preactivation capture, runtime ACL application, activated capture, and forced inner rollback at [run-codex-rotating-release-migration.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/run-codex-rotating-release-migration.mjs:343), plus an outer transaction rollback at [line 5371](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/run-codex-rotating-release-migration.mjs:5371).
- Capture-only return before service staging and target activation at [rehearse-private-pg17-rollout.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:3813).

The two official outputs are therefore deterministic exact-byte captures and the capture path stops before staging or activation.

## Schema-v5 provenance finding

The old decision was not reused. Current [activation-catalog-policy-provenance.json](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/release-rollout/src/domain/activation-catalog-policy-provenance.json:1) is schema version `5`, status `blocked`, explicitly invalidates the prior decision, and binds the two new reviewed-source hashes.

The v5 contract at [activation-catalog-policy-provenance-contract.ts](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/release-rollout/src/domain/activation-catalog-policy-provenance-contract.ts:56) requires a separate ready-provenance update containing exact candidate captures, images, four digests, reviewed sources, fresh review identifiers and evidence hashes, timestamps, and commit bindings. It also requires `independentReview.baseCommit === captureBaseCommit`.

Although the policy bytes equal the currently generated artifact, readiness remains blocked through [activation-catalog-policy-contract.ts](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/release-rollout/src/domain/activation-catalog-policy-contract.ts:24). Thus byte equality cannot revive the old review.

Any later trust-promotion change for this decision must separately update and verify:

- `captureBaseCommit`, `independentReview.baseCommit`, and `auditedHead` to `79c8496d64b63c129e19331ee328666f714d82b1`;
- the fresh run/job/artifact locator and distinct capture labels;
- this reviewer run ID and decision ID;
- immutable hashes of the persisted review and reviewer evidence;
- the schema-v5 ready provenance object and corresponding exact promotion expectations.

## Four-file delta review

The complete `ee46dfba…79c8496d` delta is exactly:

- `scripts/rehearse-private-pg17-rollout.mjs`: `+263/-2`
- `scripts/rehearse-private-pg17-rollout.test.ts`: `+156/-4`
- `scripts/run-codex-rotating-release-migration.mjs`: `+146/-27`
- `scripts/run-codex-rotating-release-migration.test.ts`: `+81/-12`

No workflow, candidate parser, promotion code, live-catalog projection, normalization source, provenance contract, promotion expectation, or release-transition source changed between the baseline and audited head; their Git blob identities are equal on both commits.

The runtime changes are fail-closed hardening:

- Source migrations now prove the production-shaped authority branch was selected at [rehearse-private-pg17-rollout.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:825).
- Rehearsal injects an unrelated grant-option/delegated ACL chain, requires canonical removal, exercises all four bounded operator transitions inside a rollback, and rechecks the boundary at [line 3207](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/rehearse-private-pg17-rollout.mjs:3207).
- Provisioning now canonicalizes all five routines, removes every non-owner EXECUTE chain with `CASCADE`, grants only the four operator functions, and checks exact owner, SECURITY DEFINER, search path, grantor, grantability, and ACL counts at [run-codex-rotating-release-migration.mjs](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/scripts/run-codex-rotating-release-migration.mjs:4323).

The two test-file changes only assert these boundaries. No delta hunk can substitute capture bytes, alter canonicalization/projection sources, bypass readiness, or cause capture-only execution to reach staging or activation.

## Semantic review

Both phases passed the exact normalization contract at [activation-catalog-policy-normalization.ts](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts:17). Effective permissions were independently reconstructed from direct/PUBLIC grants, reachability, and membership administration with zero discrepancy.

- Both phases contain 11 exact roles, 6 bootstrap-administration memberships, 9 self-only reachability facts, 126 row-security relations, and 2 extensions.
- Receipt guard and schema owner are NOLOGIN. No role is superuser, BYPASSRLS, CREATEDB, CREATEROLE, or REPLICATION; all connection limits are `-1`.
- Memberships have `adminOption=true`, `inheritOption=false`, and `setOption=false`. No login principal can reach the schema owner.
- All 126 row-security entries are disabled, unforced, and policy-free.
- PUBLIC has only one schema-USAGE and 215 type-USAGE facts, with no grant option.
- Activation adds exactly 990 direct/effective facts and removes none: API `327`, web `327`, worker `329`, effect authority `1`, custody `6`. No role, membership, reachability, ownership topology, extension, RLS, or PUBLIC authority changes by phase.
- Release migration receives exactly the four provider-scope operator routine executions, not snapshot execution or control-table DML.

There is no account-wide concurrency cap. The migration’s shared advisory lock is explicitly only a cutover fence; before activation it serializes equal provider-vote identities, not unrelated identities or inference leases, at [migration.sql](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/platform/db/prisma/migrations/000079_remove_account_wide_provider_lane_serialization/migration.sql:64). After scoped activation, lookup is bounded by workspace, repository connection, SCM repository identity, pull request, and provider invocation key at [prisma-review-execution-store.ts](/mnt/volume_ams3_1784742570542/worktrees/rr-pr245-r253-schema-v5-provenance-review/packages/features/review-executions/src/infrastructure/prisma/prisma-review-execution-store.ts:262).

## Verification boundary

The worktree remained clean. Exact hashes, Git commit/tree identity, complete four-file diff, independent JSON parsing/canonicalization, normalization semantics, effective permissions, source bindings, and JavaScript syntax were checked read-only.

**This GO is admissible only as trust evidence for a separate exact-byte promotion of the reviewed candidate into the schema-v5 trust root. It is not itself a promotion instruction and does not authorize merge, commit, push, deploy, tag, release, database activation, production mutation, or any other external-system change.**

Review runtime: approximately `6m 43s`.