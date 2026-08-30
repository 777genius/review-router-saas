# ReviewRouter activation catalog policy v29 independent review

## Decision

**Verdict: GO**

- Stable decision ID: `RR-V29-CODEX-GO-7459B6D4-B138EB3E-20260830`
- Decision scope: exact-byte mechanical promotion of the two identical reviewed capture candidates into the checked-in v29 activation-catalog policy trust root.
- P0 blockers: none.
- P1 blockers: none.
- P2 findings: two pre-promotion convergence requirements, recorded below. They are expected fail-closed conditions in the unpromoted source and do not authorize a mixed or partial promotion.

This verdict does not authorize deployment, database activation, a production or real-project rehearsal, a merge, push, tag, release, provider call, or any other external-state mutation.

The governing material reviewed for this decision was `AGENTS.md`, `ai-docs/operations/07-environments-and-release-management.md`, `docs/operations/private-pg17-release-rollout.md`, and `docs/adr/ADR-private-pg17-release-authority.md`, together with the activation-policy contracts, capture/promotion scripts, migration runner, target gates, witness/final-evidence consumers, migrations described below, and their focused tests. The release contract requires local verification before deploy and treats the checked-in reviewed artifact, compact environment digests, target transition receipt, witness, and final evidence as a single fail-closed authority chain.

## Exact inputs and provenance

### Audited source

- Required and observed source commit: `7459b6d4fd8aab5c377547246292faf3376d98cb`.
- Commit tree: `82afdc3e48799f1a95a62282acdb097bb9d0bc1a`.
- Commit subject: `merge: synchronize release gate branch with main`.
- Commit timestamp: `2026-08-30T10:02:20+03:00`.
- Requested source branch: `fix/pg17-rehearsal-role`.
- Local audited checkout branch: `review/activation-policy-v29-audit-r3` at the exact required commit.
- Canonical local transport: `/reviewrouter-v140-source-remote.git`.
- The transport's `refs/heads/fix/pg17-rehearsal-role` and the checkout's `refs/remotes/origin/fix/pg17-rehearsal-role` both resolve to the exact required commit.
- The repository is shallow, with the required commit as its shallow boundary. `git cat-file` identified it as a valid commit object and `git fsck --full --strict` reported no object or reference error.
- The transport configuration records that it was seeded from the canonical replay source for the exact GitHub SHA. Because network use was prohibited, this review verifies the locally supplied canonical transport, object, tree, branch reference, and object integrity; it does not make a fresh GitHub API claim or extrapolate ancestry beyond the shallow boundary.

The working tree was clean before this report was created. No source, policy, migration, workflow, generated artifact, or configuration file was changed by the review.

### Capture locator and semantics

- Workflow run: `33303681159`.
- Attempt: `1`.
- Artifact ID: `9729775403`.
- Expected artifact name contract: `activation-catalog-policy-${github.sha}-${github.run_attempt}`.
- The run/attempt/artifact tuple is the supplied immutable capture locator. Network access was prohibited, so the remote run metadata was not re-queried. The locally seeded artifact bytes were verified independently as described below.

At the audited commit, `.github/workflows/ci.yml` defines the capture under `private-pg16-to-pg17-rehearsal`. It uses pinned checkout and setup actions, frozen dependency installation, pinned digest-qualified PostgreSQL 16.13 and 17.5 images, and `REVIEWROUTER_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY=1`. The capture identities incorporate both `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`; the job performs two independent disposable rehearsals, compares the results byte for byte, prints their SHA-256 values, and uploads both candidates with `if-no-files-found: error` and 14-day retention.

`scripts/rehearse-private-pg17-rollout.mjs` enforces disposable source and target identities, a container-created target distinct from the source, exact image references, server-attested target identity, PostgreSQL 17, the expected database, and `session_user = reviewrouter_release_migration`. The capture transaction records preactivation, applies the runtime ACL transition, records activated, and rolls the transition back. Capture-only execution exits before service staging, activation, or canary work. The migration receipt's `postCatalogDigest` is carried into `liveCatalogDigest`.

No network, Docker daemon, database, production system, secret, API key, or real user project was accessed in this review.

### Host-seeded candidates

| Input | Mode | Bytes | Raw SHA-256 |
| --- | ---: | ---: | --- |
| `/reviewrouter-v140-input-20260830/activation-catalog-policy-candidate-1.json` | read-only | `2651682` | `b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28` |
| `/reviewrouter-v140-input-20260830/activation-catalog-policy-candidate-2.json` | read-only | `2651682` | `b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28` |

`cmp` returned equality. Both files decode as strict UTF-8 JSON; an independent duplicate-key and number-shape pass found no duplicate object keys, floating-point values, or integers outside the JavaScript safe-integer range. Both have exactly the candidate root keys `kind`, `liveCatalogDigest`, `policies`, and `version`, with kind `reviewrouter-activation-catalog-policy-artifact-candidate` and version `2`.

## Digests and normalization

The v29 values independently recomputed from each candidate are:

| Meaning | Digest |
| --- | --- |
| Raw candidate bytes | `sha256:b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28` |
| Captured live catalog / migration receipt binding | `sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d` |
| Canonical preactivation policy | `sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b` |
| Canonical activated policy | `sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b` |
| Canonical promoted artifact | `sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf` |

Canonicalization recursively sorts object keys, retains array order, serializes with JSON stringification, and hashes the resulting UTF-8 bytes without whitespace or a trailing newline. Each phase passed the audited source's pending-capture normalization profile. The promoted-artifact digest was recomputed over the version-1 artifact envelope with only `kind`, `version`, and the two normalized policies; it is not a hash of either raw candidate file.

For comparison, the checked-in reviewed v28 trust root has preactivation digest `sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59`, activated digest `sha256:6c8f40abc68b063b835289d3d42f7ee07d9769baf269c5b05fb85db72c8cb3a0`, and canonical promoted-artifact digest `sha256:bb528f22b531f212641ecebdb5ea8d0b851f0291a8c830d5bb41c88b348ccb57`. The reviewed v28 candidate was 2,506,590 bytes with raw SHA-256 `ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9`.

The v29 `liveCatalogDigest` exactly equals the audited source's `canonicalReleaseMigrationArtifact.postCatalogDigest`. The migration runner separately recomputes the installed live catalog digest and refuses a receipt mismatch. This binds the captured policy to the release migration content rather than merely to the capture filename.

## v28-to-v29 normalized delta

No v28 normalized fact was removed. The phase-by-phase inventory is:

| Inventory | v28 pre | v29 pre | Delta | v28 activated | v29 activated | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Roles | 10 | 11 | +1 | 10 | 11 | +1 |
| Memberships | 5 | 6 | +1 | 5 | 6 | +1 |
| Reachability facts | 8 | 9 | +1 | 8 | 9 | +1 |
| Row-security relations | 122 | 126 | +4 | 122 | 126 | +4 |
| Extensions | 2 | 2 | 0 | 2 | 2 | 0 |
| Direct grant/ownership facts | 2,944 | 3,082 | +138 | 3,928 | 4,072 | +144 |
| Effective-permission leaves | 4,616 | 5,026 | +410 | 5,600 | 6,016 | +416 |

The exact v29 role inventory is `reviewrouter_activation_permit_installer`, `reviewrouter_activation_receipt_guard`, `reviewrouter_activation_receipt_reader`, `reviewrouter_api`, `reviewrouter_codex_effect_authority`, `reviewrouter_comment_token_custody`, `reviewrouter_release_migration`, `reviewrouter_release_schema_owner`, `reviewrouter_role_bootstrap`, `reviewrouter_web`, and `reviewrouter_worker`. The six memberships are bootstrap administration of API, effect authority, comment-token custody, release migration, web, and worker; every edge has `adminOption=true`, `inheritOption=false`, and `setOption=false`. The nine reachability entries are self-only for permit installer, receipt reader, API, effect authority, comment-token custody, release migration, bootstrap, web, and worker. The NOLOGIN receipt guard and schema owner have no reachability entry.

The structural additions are identical in both phases:

- Role `reviewrouter_comment_token_custody`: LOGIN and INHERIT, but not superuser, BYPASSRLS, CREATEDB, CREATEROLE, or REPLICATION; `validUntil` is null and connection limit is `-1`.
- One bootstrap membership for the custody role, granted by external bootstrap authority with `adminOption=true`, `inheritOption=false`, and `setOption=false`. The bootstrap identity can administer provisioning but cannot use or SET ROLE into custody through that membership.
- One custody self-reachability fact. All nine login principals can use and set only themselves; no reachability path to `reviewrouter_release_schema_owner` exists.
- Four schema-owner relations: `HostedCodexCommentTokenMint`, `HostedCodexCommentTokenRevocationProof`, `HostedCodexRuntimeClosure`, and `ReviewProviderScopeConcurrencyControl`.
- Seven new public-schema types and the migration-79/comment-custody routine and index surface associated with those relations.

All 126 row-security inventory entries have RLS disabled, forced RLS disabled, and no policies. That is an explicit exact-catalog invariant, not an omission: 120 are owned by `reviewrouter_release_schema_owner`, four by the activation-receipt guard, and two bootstrap objects by `reviewrouter_role_bootstrap`. Any enabled RLS, policy, owner drift, or unmodeled relation changes the canonical policy and fails the gate.

The extension inventory is unchanged: `pgcrypto` is attributed to normalized bootstrap authority and `plpgsql` to external provider authority. Direct facts partition as 1,035 ownership, 1,831 explicit privilege, and 216 PUBLIC facts before activation; activated has the same 1,035 ownership and 216 PUBLIC facts plus 2,821 explicit privilege facts.

The preactivation +138 direct facts consist of:

- 7 PUBLIC type-USAGE facts;
- 6 application read facts: API, web, and worker each receive SELECT on runtime closure and provider-scope concurrency control;
- 16 custody facts: 6 routine EXECUTE, 1 schema USAGE, and SELECT on 9 tables;
- 4 release-migration routine EXECUTE facts for provider-scope status, activation, close, and verification;
- 105 schema-owner facts: 45 object ownership facts, 21 routine EXECUTE facts, 32 table privilege facts, and 7 type-USAGE facts.

Activated adds the same facts plus six custody runtime facts: database CONNECT, INSERT on `HostedCodexCommentRefreshUse`, and column-scoped UPDATE on `useCount`, `lastUsedAt`, `revision`, and `updatedAt` of `HostedCodexCommentRefreshCapability`.

The larger effective-permission delta is accounted for by the new custody principal and the seven new PUBLIC types becoming effective for every principal. It does not conceal a new role-membership path. Effective-permission leaves total 5,026 preactivation and 6,016 activated.

## Phase transition and effective authority

Between v29 preactivation and activated, roles, memberships, reachability, row-security inventory, extensions, ownership, and PUBLIC authority are unchanged. Exactly 990 direct/effective runtime facts are added and none removed:

- API and web each gain database CONNECT, 7 sequence USAGE, 13 column UPDATE, 97 table DELETE, 105 table INSERT, and 104 table UPDATE facts.
- Worker gains database CONNECT, 7 sequence USAGE, 13 column UPDATE, 97 table DELETE, 106 table INSERT, and 105 table UPDATE facts.
- `reviewrouter_codex_effect_authority` gains only database CONNECT.
- Custody gains only the six facts described above.

PUBLIC has exactly one schema-USAGE and 215 type-USAGE facts, with no database CONNECT, table privilege, routine EXECUTE, or grant option. Of 1,036 grantable facts, 1,035 are owner-derived authority and the remaining fact is schema-owner database CONNECT. No application, custody, release-migration, or effect-authority privilege is grantable.

Sensitive-principal totals and boundaries are:

- `reviewrouter_comment_token_custody`: 231 effective leaves before activation and 237 after. Before activation it has 6 bounded routine executions, schema USAGE, 9 table SELECT facts, and 215 PUBLIC type usages, but no database CONNECT. After activation it additionally receives only CONNECT, one refresh-use INSERT, and four refresh-capability column UPDATEs.
- `reviewrouter_release_migration`: 238 leaves in both phases: 6 column reads, database CONNECT, 12 bounded routine executions, 3 schema usages, 1 table read, and 215 type usages. It has no ownership, table DML, role administration, or grant option.
- `reviewrouter_codex_effect_authority`: 217 leaves before activation and 218 after; it gains only database CONNECT and retains one purpose-specific routine EXECUTE. It has no table authority.
- `reviewrouter_release_schema_owner`: 2,308 effective leaves and the inherent authority necessary to own the public-schema release objects, but it is NOLOGIN and absent from membership and reachability edges.
- `reviewrouter_role_bootstrap`: 265 effective leaves and six provisioning memberships with admin option, while every such membership has SET and INHERIT disabled.

For completeness, exact effective-leaf counts for every principal are:

| Principal | Preactivation | Activated |
| --- | ---: | ---: |
| `reviewrouter_activation_permit_installer` | 222 | 222 |
| `reviewrouter_activation_receipt_guard` | 306 | 306 |
| `reviewrouter_activation_receipt_reader` | 221 | 221 |
| `reviewrouter_api` | 342 | 669 |
| `reviewrouter_codex_effect_authority` | 217 | 218 |
| `reviewrouter_comment_token_custody` | 231 | 237 |
| `reviewrouter_release_migration` | 238 | 238 |
| `reviewrouter_release_schema_owner` | 2,308 | 2,308 |
| `reviewrouter_role_bootstrap` | 265 | 265 |
| `reviewrouter_web` | 339 | 666 |
| `reviewrouter_worker` | 337 | 666 |

## Comment-token custody and schema-owner boundary

Migrations `000083` through `000086`, the release migration runner, the capture projection, and the exact policy agree on the custody boundary:

- Custody may read exactly nine operational tables: GitHub installation, repository connection, hosted pool, repository binding, invocation grant, comment refresh capability/use, comment token mint, and runtime gate.
- Custody may call exactly six schema-owner SECURITY DEFINER routines: claim a delivery, read an authority snapshot, finalize revocation, lock the mint, lock the runtime gate, and mutate the mint.
- Those routines use a fixed `pg_catalog, pg_temp` search path, check exact `session_user = reviewrouter_comment_token_custody`, and are revoked from PUBLIC.
- Custody has no direct INSERT, UPDATE, or DELETE on comment token mint; no access to revocation proof, runtime closure, or provider concurrency control; no sequence privilege; no ownership; no role administration; and no grant option.
- The older hidden v83/v85 routines remain schema-owner-only and are not executable by custody.
- The append-only revocation proof, closure/activation barrier, gate-before-mint locking order, live-relationship completeness trigger, and bounded stale-recovery path are present in migrations 83-86 and reflected by the captured object/ACL surface.

This separates token orchestration from table ownership and proof finalization while keeping the owning role unreachable from every runtime login role.

## Migration 000079 and provider-scope ACL convergence

Both migration directories with ordinal `000079` were treated as separate, full-name migration identities by the audited migration boundary. The provider-lane migration was inspected in full.

`000079_remove_account_wide_provider_lane_serialization/migration.sql` preserves the old equal-provider-vote one-active invariant until explicit scope activation, using shared/exclusive advisory fencing. `ReviewProviderScopeConcurrencyControl` begins closed. PUBLIC is revoked; API, web, and worker receive SELECT only; release migration receives no table DML.

Its five schema-owner SECURITY DEFINER routines have fixed search paths. Status, activate, close, and verify require exact `session_user = reviewrouter_release_migration`; the snapshot routine is deliberately not executable by that role. Activation verifies the exact expected index definition before dropping it and flipping the control bit transactionally. Close and verify restore/accept the unique index only after duplicate scopes are drained. Partial or unexpected topology fails closed.

The release runner performs provider-scope routine ACL convergence after blanket routine revocation: it requires exactly five matching routines, grants EXECUTE on only the four operator routines, revokes snapshot execution, and verifies owner, SECURITY DEFINER status, search path, PUBLIC ACL, exact release ACL, absence of release table DML, and absence of a membership path to the schema owner. The candidate contains exactly those four new release-migration EXECUTE facts.

## Policy consumers and gates

The following audited consumers form a coherent fail-closed chain:

- `packages/features/release-rollout/src/domain/activation-catalog-policy-normalization.ts` defines strict shape, ordering, role, membership, reachability, row-security, grant, and effective-permission normalization.
- `scripts/capture-private-pg17-activation-catalog-policy.mjs` and `scripts/rehearse-private-pg17-rollout.mjs` bind disposable capture, server attestation, rollback-only phase capture, byte equality, and the migration receipt digest.
- `packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation.ts` and `scripts/promote-private-pg17-activation-catalog-policy.mjs` bind fixed input paths, byte length, raw hash, root shape, normalization, phase digests, artifact digest, source/run provenance, and reviewer evidence hashes.
- `activation-catalog-policy-contract.ts` strictly clones and deep-freezes the checked-in generated artifact and verifies its reviewed canonical digests and provenance.
- `activation-catalog-policy-config.ts` requires both preactivation and activated environment digests.
- Release-control composition compares both canonical digest and canonical policy bytes, then injects only the checked-in reviewed policies into the permit.
- The target activation invariant checks the live preactivation catalog against the permit, applies runtime ACLs, checks the live activated catalog in the same transaction, and records both policy digests plus the four principal-inventory digests in the receipt.
- Release-witness composition, the witness domain, trusted-rollout schema v8, and final evidence bind the same two policy digests through completion.

The capture projection also rejects unmodeled authority and unexpected roles or grantors before normalization. Consequently an order-only, owner, ACL, membership, RLS, routine-security, or effective-authority change cannot silently reuse these digests.

Targeted static syntax checks passed for the rehearsal, capture, promotion, and release-migration runner modules. The candidate passed the pending v29 capture normalizer for both phases. Runtime or integration tests requiring dependency installation, PostgreSQL, or Docker were intentionally not run under this offline review constraint.

## Findings and blockers

### P0

None.

### P1

None.

### P2-1: checked-in promotion expectations are intentionally still v28

The production promotion expectation and canonical profile still describe the reviewed v28 artifact (10 roles), while the pending capture profile describes v29 (11 roles). Therefore the current promotion command correctly rejects these v29 bytes. The authorized mechanical promotion must update the fixed byte/hash/digest expectations, exact pending-to-production normalization profile, provenance, reviewer evidence bindings, and generated artifact as one reviewable batch. A partial update is not authorized and must remain fail-closed.

### P2-2: rehearsal digest authorization is stale and fail-closed

The audited source's `rehearsalActivationCatalogPolicyAuthorization` still contains v26 digests `sha256:b95cc2c1fdd94b64056f6d8cd9316d361dce87a8a6a8064c8db51db65a886e68` and `sha256:118834866426337911d13e47f2752f2f982c1393792668036e359b0062117c6f`, while even the checked-in trust root is v28. The direct authorization check returns `activation_catalog_policy_digest_mismatch`, and its current unit test preserves those old constants. This does not enlarge authority; it prevents the ordinary rehearsal path from proceeding. Before any post-promotion rehearsal or release decision, the same exact-byte promotion batch must converge this authorization and test to the reviewed v29 preactivation and activated digests. No rehearsal, activation, or deployment is authorized while it is stale.

## Residual risks

- This is a source-and-artifact review. It did not independently query GitHub for run `33303681159` or artifact `9729775403`; the remote locator must continue to be bound through the repository's promotion provenance checks.
- No live PostgreSQL catalog was queried. Safety depends on the already-audited capture transaction and the target's exact pre/post canonical catalog checks being used without bypass.
- The canonical format preserves array order. Any regeneration or formatting/substitution of the raw capture is outside this decision even if it appears semantically equivalent.
- SECURITY DEFINER correctness still depends on deploying exactly the audited migration tree and on retaining exact owners, fixed search paths, session-user checks, PUBLIC revocations, and activation gates.
- GO is invalidated by any change to either candidate byte stream, the audited source SHA, live-catalog digest, migration set, normalization code/profile, role topology, promotion envelope, or any canonical digest listed here.

## Exact-byte mechanical promotion authorization

Subject to both P2 convergence requirements being completed in one mechanical, reviewable batch, this decision authorizes only promotion of the exact candidate byte stream of length `2651682` and raw SHA-256 `b138eb3ece6553d505debff1dc978a9b6fd8ea854cf70c037c05e364b3d0aa28`, captured twice identically, from audited source `7459b6d4fd8aab5c377547246292faf3376d98cb` and locator run `33303681159`, attempt `1`, artifact `9729775403`.

The promotion must reproduce exactly:

- live catalog digest `sha256:6ecfc9b47b47a6351f72c6f9793df3f408b2b33a275158f5499b09c10a6c048d`;
- canonical preactivation digest `sha256:87266972e7979bb15464f470f1cb94c1cf8fee3f8ec62d36c8c866328e52925b`;
- canonical activated digest `sha256:cc35c6b43fe8b117a492705eeaf2ab9a9ac0e05f98546fa32ac9d340df89867b`; and
- canonical promoted-artifact digest `sha256:5d7a98bf13e65ab8071691086efb792699b994961caadf435ee9fd4845c2f1cf`.

Any other bytes, digest, source commit, capture locator, normalization result, policy delta, regenerated capture, manual policy edit, or partial/mixed v26-v28-v29 state is **NO-GO** and requires a new independent decision. This authorization ends at production of the exact checked-in promotion diff; it grants no authority to merge, push, tag, deploy, activate, or mutate any database or external system.
