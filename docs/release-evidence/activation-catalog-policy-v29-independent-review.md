# Activation Catalog Policy v29 Independent Security/Release Review

## Verdict: GO

**Decision ID:** `codex:activation-policy-v29:da0d56a73f36:bd6aba234926:go`

The exact two-capture v29 candidate is reproducible and its complete normalized delta from trusted production v28 is coherent with the dedicated comment-token-custody boundary. No blocker or high-severity catalog defect remains. This GO authorizes only exact-byte mechanical promotion/publication of the candidate identified below; it is not deployment authorization.

## Immutable input and capture lineage

- Audited repository HEAD: `da0d56a73f366d3372cf3c2ebacfe431c6d21ed1`, tree `34c3b8534ece73c336af9156d55890725c628cda`, parent `a86fca6de3b0a2ed9b599e6e832e75c1162a4a8e`. Trusted v28 source `14774ef58ad81ac72890f96590102ac6d3dba328` is an ancestor.
- Capture tuple: GitHub Actions run `33020660492`, attempt `1`, artifact ID `9626432342`; artifact name at this HEAD is `activation-catalog-policy-da0d56a73f366d3372cf3c2ebacfe431c6d21ed1-1`.
- Workflow/job: `CI`, `.github/workflows/ci.yml`, `private-pg16-to-pg17-rehearsal`. Checkout, Node setup, and artifact upload use full action commits `d23441a48e516b6c34aea4fa41551a30e30af803`, `49933ea5288caeca8642d1e84afbd3f7d6820020`, and `ea165f8d65b6e75b540449e92b4886f43607fa02`. Checkout persists no credentials.
- The capture branch uses two distinct disposable identities, runs the same rehearsal twice, requires `cmp`, prints both SHA-256 values, uploads both files with `if-no-files-found: error`, and emits no production release-gate evidence.
- Source image: `postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60`.
- Target and release-authority image: `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`. This is unchanged from trusted v28, and the exact digest is present in both capture and full-rehearsal workflow branches.
- Candidate 1: `.review-input/activation-catalog-policy-candidate-1.json` — exactly `2,627,574` bytes, SHA-256 `bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62`.
- Candidate 2: `.review-input/activation-catalog-policy-candidate-2.json` — exactly `2,627,574` bytes, SHA-256 `bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62`.
- Independent byte comparison succeeded: the files are exactly equal, not merely canonically equivalent. Both parse as the exact version-1 candidate envelope with only `kind`, `version`, and the two policies.

No network was used. The run/attempt/artifact association above is the supplied immutable capture tuple; the local review independently establishes the exact bytes, equality, hashes, catalog content, checked-in workflow contract, and source commit to which the decision is bound.

## Exact digests

Canonicalization recursively sorts object keys and preserves array order, exactly matching the repository's `canonicalJson` implementation.

| Catalog | Raw candidate SHA-256 | Canonical preactivation | Canonical activated | Canonical artifact |
| --- | --- | --- | --- | --- |
| trusted production v28 | `ba51051d9407b4ca7b6b9c6ce74210f9ef70556e5df23512c4364024ef0800a9` (`2,506,590` bytes) | `sha256:95591a9df4dd88afe9a9a10118bf11b7e5ec4694748f8262de124d5f7ba7fd59` | `sha256:6c8f40abc68b063b835289d3d42f7ee07d9769baf269c5b05fb85db72c8cb3a0` | `sha256:bb528f22b531f212641ecebdb5ea8d0b851f0291a8c830d5bb41c88b348ccb57` |
| candidate v29 | `bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62` (`2,627,574` bytes) | `sha256:7d511ef69e73cb040ce164de5914f8129f956ff9a351840391b0c1937958c787` | `sha256:c2981e22c9095572a396c81acbab316ae643a5d4305a113cfeff2327f7e57c47` | `sha256:ac627f7d9bb37e15ba790082586ce3b84e8c4d19361f517ba59e0d46441d3b0c` |

The v29 canonical promoted artifact JSON is `2,627,563` bytes. If wrapped byte-for-byte by the current deterministic generated-artifact template, the resulting source would be `2,627,783` bytes with SHA-256 `bed595e7d211574bad3173fa299ef04d65e077d558ff49951cdb6d3764a697d1`. This derived source digest is not a substitute for the reviewed raw candidate digest.

Trusted v28 was recovered from the checked-in promoted artifact and cross-checked against its ready provenance and independent review. Its checked-in independent-review and reviewer-runtime files still hash to the provenance-bound values `050b952c3566c8b8792de874a4d2223e5d35ef01d28d0db74d01bfe4e0a6ac56` and `0057254b74da940ca9394d9449700d603cd6eee79090be34b8df2261f5179604`.

## Exact inventory and canonical v28-to-v29 delta

| Phase/catalog | Roles | Memberships | Reachability | RLS inventory | Extensions | Grants | Effective principals | Effective permission leaves |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v28 preactivation | 10 | 5 | 8 | 122 | 2 | 2,944 | 10 | 4,616 |
| v29 preactivation | 11 | 6 | 9 | 125 | 2 | 3,050 | 11 | 4,985 |
| v28 activated | 10 | 5 | 8 | 122 | 2 | 3,928 | 10 | 5,600 |
| v29 activated | 11 | 6 | 9 | 125 | 2 | 4,040 | 11 | 5,975 |

Set comparison of every canonical record found no removal or changed-in-place record in either phase. Preactivation is roles `-0/+1`, memberships `-0/+1`, reachability `-0/+1`, RLS `-0/+3`, extensions `-0/+0`, grants `-0/+106`, effective leaves `-0/+369`. Activated is the same except grants `-0/+112` and effective leaves `-0/+375`.

### Topology and relation inventory

- The one new role is `reviewrouter_comment_token_custody`: `LOGIN`, `INHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, connection limit `-1`, no validity expiry. All 11 roles have the same safe attribute invariants; only `reviewrouter_activation_receipt_guard` and `reviewrouter_release_schema_owner` are `NOLOGIN`.
- The one new bootstrap membership is role `reviewrouter_comment_token_custody` to member `reviewrouter_role_bootstrap`, recorded under `{kind: "external-bootstrap-authority"}`, with `ADMIN TRUE`, `INHERIT FALSE`, `SET FALSE`. Thus bootstrap may provision the login but neither inherits nor can set to custody through this edge.
- The one new reachability record is custody's self edge (`principal=role=reviewrouter_comment_token_custody`, `usage=true`, `set=true`). No API, web, worker, effect-authority, migration, owner, or bootstrap reachability edge to custody exists.
- The six final bootstrap memberships in each phase are API, effect authority, custody, release migration, web, and worker, all with the same external grantor and `ADMIN TRUE / INHERIT FALSE / SET FALSE` options.
- The three new RLS inventory records are `HostedCodexCommentTokenMint`, `HostedCodexCommentTokenRevocationProof`, and `HostedCodexRuntimeClosure`. Each is owned by `reviewrouter_release_schema_owner`, has RLS disabled and not forced, and has no policy. Isolation is therefore enforced by the exact ACL and trigger/routine boundary described below, not by an unproven RLS assumption.
- Extension inventory is byte-identical to v28.

### Complete grant delta

The following groups exhaust all 106 common additions in each phase:

1. **PUBLIC, 6 records:** non-grantable `type:usage` only on the composite/enum types for `HostedCodexCommentTokenMint`, `HostedCodexCommentTokenMintPurpose`, `HostedCodexCommentTokenMintState`, `HostedCodexCommentTokenRevocationProof`, `HostedCodexRuntimeClosure`, and `HostedCodexRuntimeClosureState`.
2. **API/web/worker, 3 records:** one non-grantable `table:read` each on `HostedCodexRuntimeClosure`.
3. **Custody, 16 records:** non-grantable public-schema usage; non-grantable reads of `GitHubInstallation`, `HostedCodexCommentRefreshCapability`, `HostedCodexCommentRefreshUse`, `HostedCodexCommentTokenMint`, `HostedCodexInvocationGrant`, `HostedCodexPool`, `HostedCodexRepositoryBinding`, `HostedCodexRuntimeGate`, and `RepositoryConnection`; and non-grantable execution of exactly these six routines:
   - `hosted_codex_claim_comment_token_delivery(text,text,text)`
   - `hosted_codex_comment_token_authority_snapshot(text)`
   - `hosted_codex_finalize_comment_token_revocation(text,text,text,text,bigint,text,text)`
   - `hosted_codex_lock_comment_token_mint(text)`
   - `hosted_codex_lock_comment_token_runtime_gate()`
   - `hosted_codex_mutate_comment_token_mint(text,jsonb)`
4. **Schema owner, 81 records:** 36 `owner:object` records, 15 routine-execute records, all eight owner table privileges on each of the three new tables (24 records), and six type-usage records. The 36 owned objects are:
   - 15 relation objects: `HostedCodexCommentRefreshUse_mint_key`; the mint table and its `authority_idx`, `drain_idx`, `initial_grant_key`, `logical_key`, primary key, `refresh_request_key`, `revocation_queue_idx`, and `token_hash_key`; the revocation-proof table and primary key; and the closure table, `gate_revision_key`, and primary key.
   - 15 routines: the six custody-callable routines above plus `hosted_codex_comment_refresh_use_mint_guard`, `hosted_codex_comment_token_authority_revoke_enqueue`, `hosted_codex_comment_token_mint_guard`, `hosted_codex_comment_token_prepare_authority_complete`, `hosted_codex_comment_token_revocation_eligibility`, the deliberately non-callable historical successors `hosted_codex_mutate_comment_token_mint_v83` and `_v85`, `hosted_codex_runtime_closure_guard`, and `hosted_codex_runtime_gate_activation_barrier`.
   - The six composite/enum types listed in item 1.

Activated adds exactly six more non-grantable custody records and nothing else: database connect granted by `reviewrouter_role_bootstrap`, insert on `HostedCodexCommentRefreshUse`, and column update on only `HostedCodexCommentRefreshCapability.useCount`, `lastUsedAt`, `revision`, and `updatedAt`. The insert drives the existing consume trigger; the four-column update is the trigger's bounded capability-ledger update surface. Preactivation lacks all six, so custody cannot connect or perform those writes before activation.

### Complete effective-permission delta

- The new custody principal has 230 preactivation leaves: 214 PUBLIC type-usage leaves plus the 16 direct leaves above. Activated has 236, adding exactly connect, receipt insert, and four column updates.
- Each of the ten v28 principals gains the six new PUBLIC type-usage leaves (`+60`).
- The schema owner gains 75 non-type effective leaves: 36 ownership, 15 routine execute, and 24 table privileges. Its six type-usage leaves are already counted in the PUBLIC-derived `+60`, so duplicate direct/public paths do not inflate the normalized effective set.
- API/web/worker gain the three closure reads. Bootstrap gains one effective `admin:role-membership` leaf for custody.
- These components total `+369` preactivation and, with custody's six activated-only leaves, `+375` activated. There are no effective-permission removals.

## Security and authority conclusions

- **Custody boundary:** custody has no direct `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, or `MAINTAIN` on `HostedCodexCommentTokenMint`; no mint column grant; no privilege at all on `HostedCodexCommentTokenRevocationProof`; no ownership; no grant option; and no execute privilege on `_v83` or `_v85`. Mint mutation and proof finalization are confined to the latest six-routine surface. The SECURITY DEFINER custody entry points use a fixed `pg_catalog, pg_temp` search path, revoke PUBLIC, and check exact `session_user`, so acquiring the role through `SET ROLE` cannot impersonate the custody login at those entry points.
- **Bounded direct writes:** the only activated direct writes are the existing refresh-use receipt insert and its four capability accounting columns. Existing transition and deferred ledger-consistency triggers require revision progression and receipt/count agreement. No other table or column write appears in the v28-to-v29 delta.
- **API/web/worker:** their only non-type delta is read-only access to `HostedCodexRuntimeClosure`; none has a mint-table, revocation-proof, custody routine, column-write, or ownership record. The v28 runtime-gate read-only remediation remains intact.
- **Effect authority:** `reviewrouter_codex_effect_authority` has no new direct grant and gains effectively only the six PUBLIC type usages. It has no new table, column, routine, ownership, custody, or mutation authority.
- **Migration/bootstrap:** `reviewrouter_release_migration` gains only the six PUBLIC type usages. Bootstrap gains only the custody membership-admin leaf and those type usages; its final role remains non-superuser and non-`CREATEROLE`, and the custody edge is neither inheritable nor settable. The no-login schema owner owns every new securable object and remains absent from reachability.
- **PUBLIC and grantability:** in the full v29 policies PUBLIC has only one pre-existing schema-usage record and 214 non-grantable type-usage records; it has no database, table, column, sequence, routine, mutation, or ownership authority. Every newly grantable record is an `owner:object` fact for the no-login schema owner. The one non-ownership grantable record in the full catalogs—schema-owner database connect from bootstrap—is unchanged from trusted v28.
- **Phase symmetry:** role, membership, reachability, RLS, extension, ownership, routine, PUBLIC, runtime-read, and custody read/execute additions are identical in both phases. The only phase asymmetry is the exact six activated-only custody leaves required to connect and consume refresh authority. No activated-only privilege appears for API, web, worker, effect authority, migration, bootstrap, PUBLIC, or the owner.

## Migration intent alignment

- `000083_hosted_codex_comment_token_mint_protocol` introduces the three relations, types, closure barrier, guarded mint state machine, authority snapshot/lock, security-definer mutation/finalization, revocation proof, and narrow custody ACL. It revokes generic application mutation on mint/closure and all application access to the proof.
- `000084_harden_comment_token_custody` adds the DB-clock-fenced delivery claim, interposes the current mutation wrapper, retains the old implementation as `_v83`, revokes generic API/web/worker access to the mint table, revokes custody/PUBLIC from `_v83`, and grants only the wrapper/claim surface.
- `000085_comment_token_gate_lock_result` changes the gate-lock routine from a void projection to a boolean result without widening its identity or authority; it again revokes PUBLIC and grants custody only.
- `000086_comment_token_custody_r18_remediation` adds server-derived revocation scheduling and its queue index, makes authority-triggered revocation acquire the global gate first, adds the live-row prepare-authority guard and narrow mint lock, interposes the current mutation wrapper while retaining `_v85`, and explicitly revokes custody and PUBLIC from `_v85`. The final catalog exactly reflects the intended latest-wrapper-only execution boundary.

The catalog-neutral parts of these migrations—new columns, constraints, triggers, and function bodies under an unchanged routine identity—do not appear as separate normalized ACL records, but their final securable objects, owners, and execution ACLs do. No unexplained role, membership, relation, ownership, routine, PUBLIC, or effective-authority drift remains.

## Capture-only profile cannot promote

The pending 11-principal normalization profile is deliberately used only by `capture-private-pg17-activation-catalog-policy.mjs`. It is not exported from the package entry point. Capture-only execution requires a syntactically bounded disposable identity and verifies that the target is a newly created target container distinct from the source. It runs through release migration and phase-transition proof, cleans rehearsal-only objects, captures the two phases, and returns before service staging/activation and before the normal postconditions.

That capture exception does not bypass production promotion:

- The capture workflow branch is mutually exclusive with the full rehearsal/release-evidence steps and only uploads candidate files.
- The production canonical principal and membership lists remain v28's 10/5 topology. Production artifact loading and the promoter use `productionActivationCatalogPolicyNormalizationProfile`, not the pending profile.
- The promoter is still bound to the v28 opt-in string, exact `2,506,590`-byte size, v28 raw hash, v28 phase/artifact digests, ready v28 provenance, and hash-pinned v28 independent-review evidence. This v29 candidate fails the first exact size/hash bindings and, independently, the current production 10-role normalization.
- Mechanical promotion of v29 therefore still requires an explicit production-profile update and new exact v29 expectation, provenance, and independent-review bindings. Capture-only code cannot silently replace or authorize the production trust root.

## Verification performed

- Exact `stat`, SHA-256, and byte comparison of both supplied candidates.
- Independent JSON parsing and canonical hashing using an implementation cross-checked against repository `canonicalJson`.
- Full set delta over every role, membership, reachability, RLS, extension, grant, and effective-permission record in both phases.
- Mechanical assertions for all counts, safe role flags, membership options/grantor, reachability, phase symmetry, PUBLIC/grantability, custody ACL, runtime/effect-authority deltas, old-wrapper exclusion, and prohibited authority; all passed.
- Source inspection of migrations `000083` through `000086`, capture and promotion code, production/pending normalization profiles, v28 artifact/provenance/review, and the exact capture workflow/image/action pins.

## Blockers

None.

## Residual risk and authorization boundary

- The decision is invalidated by any change to HEAD, run/attempt/artifact identity, action or image pins, either candidate byte, candidate length/hash, canonical phase/artifact digest, or the reviewed promotion implementation.
- This catalog proves the final disposable PostgreSQL role/ACL shape and its reproducibility. It does not prove live production database state, provider credential custody, deployment configuration, or safe execution of a production rollout.
- The dedicated custody credential and bootstrap administrator remain security-critical. They must not be replaced by an API/web/worker/effect credential, a new role-reachability shortcut, or a broader ACL.

**GO only for exact-byte mechanical promotion/publication of the `2,627,574`-byte activation catalog v29 candidate whose SHA-256 is `bd6aba2349266bb8165c64d309ba537c0d63846c58c425b040ed408f857ebe62`, with canonical preactivation `sha256:7d511ef69e73cb040ce164de5914f8129f956ff9a351840391b0c1937958c787`, activated `sha256:c2981e22c9095572a396c81acbab316ae643a5d4305a113cfeff2327f7e57c47`, and artifact `sha256:ac627f7d9bb37e15ba790082586ce3b84e8c4d19361f517ba59e0d46441d3b0c`. This is not deployment authorization and does not authorize merge, push, tagging, runtime activation, production database mutation, regeneration, or byte substitution.**
