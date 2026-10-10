# C2b gateway configuration handoff

Source delivery only; integration qualification is pending.
Supplied root: `64f843e20d9f9b58d7feb17d300c2fc005afa69c`.
Observed Git identity: UNVERIFIED. First non-login `/bin/sh` command exited128:
linked metadata points outside the sandbox to unavailable source-integration-64f843e2.
The single writable probe reported `.git` read-only; no repair/repeated Git probe,
add, commit, push, reset, deployment, provider call or credential read occurred.
Requested lane: gpt-6.1-sol/high/default, NO FAST; controller provenance unverified.
Normative full53 bytes were read and its observed SHA256 matched:
`66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.
Dfinal/S/E/F/G remain unqualified; H is deferred. This is not Dmin or relay,
provider, App publication, UI or platform readiness.

Changed source:

- review-providers: the two owned domain files and their two nearest tests.
- review-config: existing domain/parser and Prisma adapter, existing domain test,
  plus gateway-configuration.postgres.test.ts at the actual persistence boundary.
- Prisma schema and new119; scoped workspace columns derive from actual parents.
- Only current/full migration-catalog readers and their existing boundary tests.
- This handoff. No dependency, lock, generated client or provider-account behavior changes.

`codex_account_gateway` requires flat safe binding/profile references; other modes
forbid them. Codex remains the agent. Gateway models/reasoning/fast/agentic settings
survive normalization; primary equals the first ordered provider. No legacy
coercion is added. Catalog UI authModes/defaults remain unchanged. Metadata requires
no secrets. Runtime types carry safe refs; env output has only safe settings,
without refs, grants, token, private URL, native ID or new execution capability.

Both primary version and ordered provider rows store the selection. Composite
parent FKs enforce workspace derivation, including root repository ownership.
Composite binding FKs deny foreign SQL
selection and substituted parent scope. SQL checks enforce mode/kind and null/ref
shape. Legacy rows backfill from parents with null pointers, retaining settings.
Parent/version FKs retain legacy CASCADE deletion semantics; binding FKs retain
RESTRICT to preserve selected binding identity. Primary actual-PG BEFORE proved
the candidate's global RESTRICT broke legacy clear; the repair restores that flow.
Existing admitted runs must use their retained runtime snapshots per53, not mutable
configuration lookup. Legacy pool switching leaves explicit gateway selections intact.

Save retains existing Serializable transactions, scope guards and expectedVersion
CAS. Same-transaction selection requires active same-workspace binding, no pending
fence, workspace-owned active mirror and matching profile; personal ownership is
denied. Read/refetch does not revalidate or erase disabled/revoked history.
The mirror is not gateway execution authority and never mints grants. Subsequent
relay admission must independently check live gateway/kernel and qualified model,
profile, policy, binding revisions and execution envelope.
Continuation audit closed the forged-root-parent SQL gap with the existing
RepositoryConnection(id, workspaceId) key and a focused direct-SQL PG regression.

Observed checks on Node24.21.0:

- Syntax checks of 14 changed TS/MJS source/test files: exit0. Syntax/type stripping
  is not typechecking and not evidence of domain/Prisma/SQL behavior.
- Actual catalog readers: exit0; full118 ends at new119, historical96 is unchanged,
  managed projection remains92. The existing reader verifies historical96 digest.
- Typechecks, Prisma validate/generate and focused Vitest tests: NOT_RUN.
  Invocations exited127 before execution: pnpm shim's corepack path is unavailable;
  no node_modules/compiler/psql is available here. No disposable PG was run.
- The real-PG test is written, NOT_RUN. It uses the existing guarded empty loopback
  DB/disposable-cluster convention, psql for historical CONCURRENTLY/enum SQL,
  actual Prisma adapters and a fresh client. No mocked Prisma/source-string SQL
  assertions substitute for persistence proof. No optional-tool install/retry ran.

Primary qualification commands after restoring the existing pinned dependencies:

```sh
pnpm --filter @reviewrouter/platform-db db:generate
pnpm exec prisma validate --schema packages/platform/db/prisma/schema.prisma
pnpm --filter @reviewrouter/features-review-providers typecheck
pnpm --filter @reviewrouter/features-review-config typecheck
pnpm exec vitest run packages/features/review-providers/src/tests/provider-catalog.test.ts packages/features/review-providers/src/tests/provider-runtime-plan.test.ts packages/features/review-config/src/tests/review-configuration.test.ts packages/features/review-config/src/tests/prisma-current-scope-writers.test.ts
pnpm exec vitest run scripts/lib/render-historical96-checkout.test.ts scripts/lib/render-schema-handoff-policy.test.ts scripts/check-codex-rotating-migration-rehearsal-historical96.test.ts scripts/codex-rotating-release-migration-workflow.test.ts
RR_REVIEW_CONFIG_GATEWAY_PG_TEST=1 RR_REVIEW_CONFIG_GATEWAY_DISPOSABLE_CLUSTER=1 RR_REVIEW_CONFIG_GATEWAY_PG_TEST_URL=postgresql://DISPOSABLE_USER@127.0.0.1:DISPOSABLE_PORT/rr_gateway_test_c2b_batch pnpm exec vitest run packages/features/review-config/src/tests/gateway-configuration.postgres.test.ts
```

The PG URL is illustrative: primary supplies its explicitly disposable empty PG
fixture. The test refuses passwords, ambient credentials, remote hosts and query
options. It covers backfill, default/override/primary/ordered roundtrip, fresh-client
read, foreign/substituted SQL scope, null/mode/ref checks, missing/revoked/fenced/
personal/mirror-state/profile denial, exact ACK/rebind, stale CAS and retained history.

Exact delivery artifacts (preimages, patch, before/after hashes, copied full53,
observed logs and check classifications):
`/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-gateway-config-c2b-nonlogin/tmp/agent/c2b-artifacts/`
Apply repair.patch only to matching preimages. Project Integration owns Git and
actual build/empty-PG qualification; no component readiness is inferred here.

## Primary qualification 2026-10-04

Primary candidate based on64f843e2: full49-project typecheck plus spikes PASS; nearest UI/form/provider52PASS, config/API78PASS, actual fresh PostgreSQL17.10 persistence/runtime-reader1PASS, catalog165PASS, all zero skipped. Existing legacy delete and actual CI-reader failed BEFORE, pass AFTER. Migration119 checksum and full118-file checkout manifest match actual SQL, historical96 unchanged. Lock graph retained with10 importer additions. Changed format/ESLint passed before catalog checksum repair. Component proof only; actual Codex/MiMo CI tools/final/parser/same-head App remains unproved. Independent exact-source review and mandatory exact-head CI still required.
