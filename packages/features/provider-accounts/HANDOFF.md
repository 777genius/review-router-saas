# contract52 C1 handoff

C1 owner/binding foundation is implemented. Main qualification results are recorded
below; exact final-head review/CI are pending. This is not UI/gateway/live-review
completion or a production release.

## Identity and owned patch

Requested base: `f0c18bf7759c030f311cf21050d6a61718e9dcd4`.
Actual HEAD is **UNVERIFIED**: `git rev-parse HEAD` exits 128 because `.git`
points to unavailable `/srv/workers/jobs/review-router/account-gateway-v1/repos/saas/.git/worktrees/owner-binding-c1`.
No supplied50/51/52 files were available in this worktree; explicit task C1
requirements are the implementation contract. Primary must compare with the
approved documents and confirm the exact base before integrating.

Available pre-edit SHA256 fingerprints:

- schema.prisma: `87d0beaeadf6dc66abd81afcc3b79a73243865c5c55eec2d23d7b520ef977b14`
- pnpm-lock.yaml: `3d81c57a3ea0bdd9223592fb5021dfb049f02a50fd3ce5f68337ff812c5141cd`
- exported auth assertion source: `69a423d022a285257d0d930ec6be46409297a511d95453188149b81f67304c64`

Changed: this feature package, additive schema declarations, and new
`000116_provider_accounts/migration.sql`. Removing only C1 schema additions
reconstructs the pre-edit schema SHA256 exactly. Old migration/pool/native/
private gateway files were not written. Lockfile remains byte-identical.
No commits, index changes, pushes, deployment, credential/key/runtime-auth-file reads,
network/database/socket/provisioning or real-project smoke execution occurred.
Final file fingerprints and command outcomes are in `EVIDENCE.json`.

## Policy and storage

Pure domain -> product ports/use-cases -> Prisma adapter; public auth feature
export `assertWorkspaceAdminAllowed` is reused, with live injected
`WorkspaceAccessRepositoryPort`. Stable userId wins; a present ID never falls
back to GitHub/login roles. Absent IDs use immutable GitHub ID. The existing
local override comes from trusted composition configuration. Members can select
in their current workspace, but cannot mutate. No paid/shared-pool grants.

Connections have exactly one stable User/Workspace FK owner, enforced by SQL
XOR and immutable owner/identity/gateway-ref trigger. Safe account/operation/
profile refs, label, status and mirror CAS revision only; no credential, native
DTO, prompt, fingerprint or refresh journal. Separate bindings retain revoked
rows, enforce a unique workspace/connection pair, positive increasing revision
and `(id, workspaceId)` uniqueness for a future same-workspace config FK.
Ownership FKs use RESTRICT. Reserved `Workspace.personalOwnerUserId` has an
explicit named User relation, nonempty check and RESTRICT FK. Nothing infers,
provisions or enables personal ownership. User-owned sharing remains denied,
including when the reserved personal owner is explicitly set.

Bind/revoke preflight live admin access and owner; bind requires active gateway
status. The adapter locks the owned connection, rechecks owner/status, then
atomically creates at expected revision 0 or CAS-updates a retained binding.
Missing/stale/racing writes return safe product errors. Revocation also works
for inactive connections so they can be cleaned up. Current-workspace selection
requires an active binding, matching owner and exactly known active account.
It returns only a safe binding tuple. Reads expose no global owner list.

`./synchronization` is a separate privileged backend seam with an explicit field
allowlist and metadata CAS; it mirrors an already-qualified gateway projection.
Its revision is a local mirror version, not an account authorization epoch.
No browser route can set active in C1 because there are no routes here.

## Tests and observed results

Test regression intent was recorded before implementation, and appears beside
individual tests: member mutation/live membership removal; stable-ID fallback;
local override without foreign/personal sharing; stale CAS undoing revocation;
inactive/future gateway states; workspace-scoped selection; unsafe/nonempty PG
fixtures; real SQL XOR/transfer/FK/duplicate/revision failures and CAS races.

From repository root on Node v24.21.0:

- `node --import ./packages/features/provider-accounts/tests/register-source-loader.mjs --test packages/features/provider-accounts/tests/use-cases.test.mts packages/features/provider-accounts/tests/database-target.test.mts`: **PASS, 7 tests**.
- TypeScript syntax parsing using Node `stripTypeScriptTypes` (12 TS/MTS files), JSON manifest parsing and focused whitespace inspection: **PASS**. Syntax parsing is not a typecheck.
- `node --experimental-transform-types --import ./packages/features/provider-accounts/tests/register-source-loader.mjs --test packages/features/provider-accounts/tests/postgres.test.mts`: **SKIPPED**, opt-in absent; actual PG/full migration **NOT_RUN**.
- `pnpm --filter @reviewrouter/features-provider-accounts typecheck`: **NOT_RUN**, wrapper exits 127: pinned corepack is unavailable; node_modules absent.
- `node scripts/check-architecture-boundaries.mjs`: **NOT_RUN**, missing TypeScript dependency, exits 1 before checking.
- `git diff --check`: **NOT_RUN**, unavailable linked gitdir, exits 128. Focused whitespace check passed independently.

The lightweight source loader resolves extensionless TS and directly loads the
existing exported auth assertion source, isolating unrelated SCM/crypto adapters.
It does not replace the auth algorithm. Unit fixtures implement product ports;
actual persistence/race evidence must come from the opt-in PostgreSQL suite.
Standalone Node tests are not discovered by the root Vitest include pattern;
main CI must run the package test and PG commands explicitly.

Independent `gpt-6.1-sol/xhigh` code review completed against the final recorded
source hashes. No remaining actionable product/schema/migration defects were
identified. It found two fixture hazards, now repaired: pg can treat an empty
password string as omitted and consult ambient credentials/pgpass; omitted
options or port zero can consult ambient session/port settings. The helper now
uses a truthy empty-password callback, explicit safe session options/name/UTF8
and SSL configuration, and rejects port zero. Revised offline tests passed 7/7
in both the worker and independent review.

A new actual-adapter PG regression changes status to quarantined between live
preflight and atomic CAS, requiring denial and zero binding rows. This regression
was inspected and syntax-checked; its actual database execution is NOT_RUN.
The reviewer confirmed the CI gap: `vitest.config.ts` excludes `.test.mts`, while
`.github/workflows/ci.yml:776` runs root `pnpm test`. Main must wire the standalone
commands explicitly; CI changes remain outside this worker's ownership.
Exact-base and actual CI-run qualification remain unverified.

## Main-owned qualification and deferred work

No new libraries: package dependencies reuse pinned Prisma/adapter 7.8.0 and pg
8.23.0, verified in current package manifests/lock. **Pending:** main must run
pinned pnpm 10.33.0 lockfile registration (lock-only, ignore scripts), generate
Prisma from the full schema, validate/typecheck/build and architecture checks.
Do not hand-edit a guessed importer. Worker installed nothing.

Main supplies a **new empty** passwordless loopback database named
`rr_gateway_test_*` in a disposable cluster, with a synthetic migration-capable
role. The test refuses any preexisting non-system objects before writing, then
applies every checked-in SQL migration in sorted order and uses the actual
Prisma/auth adapters. Historic migrations create cluster-wide release roles;
this is why a disposable cluster acknowledgment is additionally required.
It never creates a database or reads ambient database credentials. Example after
main's install/generation, replacing the synthetic target with its fresh fixture:

```sh
RR_PROVIDER_ACCOUNTS_PG_TEST=1 RR_PROVIDER_ACCOUNTS_DISPOSABLE_CLUSTER=1 \
RR_PROVIDER_ACCOUNTS_PG_TEST_URL=postgresql://fixture_owner@127.0.0.1:5544/rr_gateway_test_c1 \
node --experimental-transform-types --import ./packages/features/provider-accounts/tests/register-source-loader.mjs --test packages/features/provider-accounts/tests/postgres.test.mts
```

The fixture remains inspectable; main destroys its new database/cluster after
review. Full migration/typecheck/real PG checks, exact-base qualification and
independent gpt-6.1-sol/xhigh review of exact code plus CI are required before
primary's mechanical integration commit/merge. No FAST qualification claim.

C2/C3 must compose trusted authenticated principals, existing live auth port,
Prisma repository and privileged status synchronization with the qualified
private facade/static SDK seam. Gateway owns native ID/generation, credentials
and inference. No second native manager/facade/framework was built. Routes/UI,
repo config, personal sharing/provisioning and remote gateway fence ACK are
explicitly deferred. Local-revoked selection denial is not completed remote
disable. In-flight operations still need gateway authority/fencing in C2.

## Migration risk and rollback

Additive nullable Workspace column and new tables/enums/indexes/triggers; existing
rows need no backfill. New authority references intentionally prevent deleting
referenced User/Workspace/connection rows. Binding tombstones prevent application
ABA. Apply SQL migration, not schema push, to retain XOR/immutability/revision
constraints. Full historical migration compatibility is unverified locally.

Prefer a forward fix. For rollback, first disable future C1 composition/writers
and preserve safe product rows for recovery, then main can remove bindings,
connections, guard functions, enums and the reserved Workspace FK/index/column
in dependency order. Dropping these loses product mapping/revocation history;
gateway accounts/credentials remain outside RR. Never rewrite older migration
hashes or alter pool tables. Rollback and actual PG deployment are NOT_RUN.

## Primary qualification update - 2026-10-03

The main controller verified the guarded base and created owner commit
`1a9fa9c8` in PR 488. Fresh sandbox qualification used Node 24.21.0 and pnpm
10.33.0: frozen installation, full Prisma generation/validation, feature type
check/build, architecture and seven Node cases passed. The minimally generated
lock importer adds 16 lines; every previous parsed lock authority is preserved.

The first full-migration fixture failed on historical CONCURRENTLY SQL because
pg sends an entire file in one implicit transaction. Primary changed only the
fixture to actual passwordless psql with explicit isolated target/session
options. A NEW PostgreSQL 17.10 cluster applied all 115 SQL files and passed all
six real adapter/SQL scenarios; zero skipped cases. Historical SQL is unchanged.
Dedicated exact-head CI 37104443106 and the existing self-host E2E job passed.
That existing self-host receipt is not a new gateway/provider review receipt.

Full CI found the additive migration absent from current checkout catalogs.
The corrected explicit checksum/exclusion preserves all historical manifests
and historical96. All 205 affected existing catalog tests now pass. Final
source lint, feature typecheck/build and seven Node cases pass on the repaired
candidate; five SQL-error predicates use unknown with structural narrowing and
display-name validation retains the same control-character rejection. Existing
Prettier formatting is applied to the new module. The coherent PR is slightly
above the 2,000-line target because real full-migration tests and their required
formatter expand the same invariant; splitting its SQL/auth/CAS boundary would
leave an unqualified intermediate feature. No additional product surface added.

Current independent xhigh/default review covers the prior exact head. A final
exact-code review and final complete CI must pass before merge. No UI, browser
route, remote fence acknowledgement, provider call, production migration or
legacy-pool change is qualified by this checkpoint.

## C1 R1/P1 and R2/P2 input lifetime repair - 2026-10-03, attempt 2

Worker scope is exactly three existing production files, two existing test files,
and this handoff within `packages/features/provider-accounts`. The application
bind/revoke entry points synchronously capture the workspace, connection,
expected revision and each nested actor scalar. Selection captures workspace,
binding and each actor scalar. Every public Prisma repository/synchronization
operation now explicitly copies its allowed scope/revision/state/metadata fields
before validation or its first await. All later authorization, lock, query, CAS
and return-selection reads use that single snapshot. No caller-owned actor or
upstream descriptor is retained. Existing auth algorithm, stable-ID policy,
local override, metadata allowlist, errors and SQL behavior are preserved.

R1 evidence uses the actual exported auth use-case and its live role-query gate;
only auth/storage ports are fixtures. Nine regressions cover bind, revoke and
selection with stable identity, GitHub identity and the existing local override.
While the live query is suspended they mutate both request and retained nested
actor, then replace the actor. They assert original identity/tenant/IDs/revision
and exact scoped storage calls, including selection's second auth call when the
first live membership read returns no role. The foreign fixture can succeed, so
old code demonstrably returns tenant B after authorizing A.

On Node 24.21.0, final tests against an isolated copy of the pre-edit production
sources: **6 existing pass, 9 new FAIL**, exit 1 (tenant-B results; override
selection fails after adopting B's actor). On repaired workspace:

```sh
node --import ./packages/features/provider-accounts/tests/register-source-loader.mjs \
  --test packages/features/provider-accounts/tests/use-cases.test.mts \
  packages/features/provider-accounts/tests/database-target.test.mts
```

**PASS 16/16**, zero skips. These are actual auth algorithm/application tests,
not actual Prisma or PostgreSQL execution. Syntax parsing of all 12 feature
TS/MTS files and focused whitespace inspection also passed; parsing is not a
typecheck. The opt-in PG command was run without opt-in and **SKIPPED** its root
case. Actual Prisma/PG execution of these new R2 regressions is **NOT_RUN**.

R2 regressions extend the existing full-migration PG suite at the actual Prisma
adapter boundary. A test-only Proxy gates transaction admission and delegates
unchanged arguments to the real Prisma client. It mocks no persistence, CAS,
row locks or return values and adds no production hook. For each adapter a
revoked/disabled revision-2 row exists in A and B. A validated stale revision-1
request is changed to B/revision 2/active during admission; it must still reject
and both rows must remain revision 2 and revoked/disabled. A second fresh request
must update only A with its original state and metadata to revision 3, return A,
and leave B unchanged. This verifies state, scope, revision, safe metadata
scalars and return reads independently of application snapshots.

Main owns remaining qualification in a new dedicated sandbox: confirm base
`96b0b8b3`, run pinned formatter/lint, Prisma generation, feature typecheck/build,
architecture and fresh full-migration PG. No node_modules or available
Prettier/ESLint/TypeScript/Prisma/pg resolution exists here; no install was run.
Before running repaired PG, keep the new tests and reverse only the three
production edits in a separate baseline checkout using
`production-baseline.patch`; require both new actual-adapter subtests to fail,
then restore production repairs and run against a second new empty disposable
PG database/cluster. Reusing the first populated database fails the deliberate
empty-fixture guard. Never infer PG qualification from the skip receipt or the
historical qualification above. Independent exact-patch model review and heavy
checks are **NOT_RUN** in this attempt; no FAST claim.

Git HEAD/base and Git lock absence are **UNVERIFIED**: `.git` points to unavailable
`/srv/workers/jobs/review-router/account-gateway-v1/workspaces/source-c1-catalog-96b0b8b3/.git/worktrees/owner-binding-c1-input-repairs`.
`git diff --check` exits 128; a negative lock-path probe cannot prove lock absence
when that gitdir is unavailable. Main must verify HEAD and index locks before
integration. No Git index/commit/push operation was attempted. No kernel/native,
catalog, SQL/schema, auth, lockfile or workflow edit was made; no credential,
provider, install, production or real-project launch occurred.

Exact before/after SHA256 guards, the complete owned patch, a production-only
reverse patch, an isolated original-source fixture, and failure/pass logs are at:

`/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-owner-binding-c1-input-repairs/tmp/agent/input-lifetime-evidence/`

Use `verify-patch.py` from that directory against main's dedicated base checkout
before applying `input-repairs.patch`. It checks the requested base, source
fingerprints, index lock and `git apply --check` without editing Git or sources.
Workspace edits remain intact for the Project Integration controller. Overall
qualification remains pending main's actual PG and pinned checks.

## Primary input-lifetime qualification - 2026-10-03

Guard58303820 on exact96b0b8b3 was applied in a new standalone hosted sandbox. Pinned pnpm10.33/Node24.21 frozen install, full Prisma generation, existing formatter/lint, feature typecheck/build and architecture passed. All16 auth/fixture cases passed, zero skips. The same new auth cases on unchanged96b production produced9 behavioral failures with7 prior cases passing.

Two separate new PostgreSQL17.10 clusters applied all115 actual migration files with psql. Old production plus the new actual-Prisma tests produced exactly two nested R2 failures (binding CAS/state/scope and metadata CAS/state/scope); five existing nested scenarios passed. The repaired candidate passed all7 nested scenarios plus root (8/8), zero skips. An incorrect main receipt-name assertion stopped after the valid BEFORE failures; primary corrected only the receipt assertion and resumed the unrun AFTER phase on its separate new cluster, without replaying or relabeling the populated old fixture.

Guarded producer output and primary formatting are distinct. This evidence qualifies the actual input lifetimes; a final owner commit, full exact-head CI and independent xhigh/default review still must pass. No routes/UI/native/provider/OIDC/publication or production migration is enabled.
