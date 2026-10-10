# Bounded C3 Accounts source handoff

Supplied base: 58ea6a69f3bad2e1e9d724db9f331125e4c86902 (.spike-inputs/manifest.json agrees).
Observed HEAD/status/diff: NOT_RUN; linked .git target is missing/inaccessible:
/srv/workers/jobs/review-router/account-gateway-v1/workspaces/p49-accounts-source/.git/worktrees/p50-accounts-ui.
Sole norm: ai-docs/architecture/53-account-gateway-implementation-contract.md;
observed SHA256 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
50/51/52 were consulted only as nonnormative context; manifest/SDK inputs stayed frozen.
Supplied SDK candidate bdba815f83e326726441ddbe7ade51d7d2974e07;
observed archive SHA256 b6a4b79a1e026e585a23118c6661dd995fa124b061de86f2c0ca18ad71bf74a9.
The accepted tarball/path is unchanged. Its observed package.json version is 0.1.0
(the prompt supplied 0.2.0; embedded Get Modular dependencies are 0.2.0). No SDK rewrite.

Changed owned paths (navigation is intentionally untouched):

- apps/web/src/server/account-gateway-accounts.ts
- apps/web/src/server/account-gateway-accounts.integration.test.ts
- apps/web/app/dashboard/account-gateway-accounts-section.tsx
- apps/web/app/dashboard/account-gateway-account-controls.tsx
- apps/web/app/dashboard/account-gateway-account-actions.ts
- apps/web/app/dashboard/dashboard-workspace-page.tsx
- apps/web/app/dashboard/dashboard-section.ts
- apps/web/package.json
- pnpm-lock.yaml
- packages/features/provider-accounts/src/application/ports/provider-account-repository-port.ts
- packages/features/provider-accounts/src/infrastructure/prisma/prisma-provider-account-repository.ts
- C3_ACCOUNTS_HANDOFF.md

Accounts/setup now includes server-loaded workspace MiMo/OpenRouter API-key controls,
25-row pages, approved profiles/status, rename/reconnect/disable and C1 binding create/resolve.
Existing subscription controls remain. Gateway OAuth is explicitly unavailable pending F.
Own BYOK uses existing live admin authority with no paid/operator-pool grant dependency.
A signed server-issued workspace/user locator is rechecked against current stable session,
Workspace.id and existing live admin assertion before every management HTTP read/effect.
Owner/operation namespaces derive from Workspace.id, never login/slug; only UUID v4
nonces and approved internal connection IDs enter from the browser. No foreign opRef API.
Credential ingress bypasses React Query; fields clear before await. Safe queries/mutations
have typed keys, deliberate stale times, exact page invalidations and no automatic retries.
Session storage retains at most eight safe nonces before submission, surviving tab reload.
Pending/unknown has readback only and no invented account/state or mirror synchronization.
Applied receipts require owned/profile-checked current GET metadata before C1 CAS updates.
Mirror snapshots precede GET; stale mutation/mirror CAS refuses and newer CAS is preserved.
Disable revokes the local C1 binding first; remote fence/transport cleanup/erasure remain
unresolved. The UI never equates pending or acknowledged disable with credential erasure.
Server-only configuration (no values read by this worker):
REVIEW_ROUTER_ACCOUNT_GATEWAY_MANAGEMENT_ORIGIN;
REVIEW_ROUTER_ACCOUNT_GATEWAY_MANAGEMENT_TOKEN;
REVIEW_ROUTER_ACCOUNT_GATEWAY_ACCOUNTS_CONTEXT_SECRET (at least 32 characters);
REVIEW_ROUTER_ACCOUNT_GATEWAY_MIMO_PROFILE_ID;
REVIEW_ROUTER_ACCOUNT_GATEWAY_OPENROUTER_PROFILE_ID.
Profile IDs are explicit server allowlist entries intersected with SDK API-key catalogue.
The context signing secret can rotate without changing owner/operation namespaces.

Checks:

- PASS: contract/archive/all three frozen SDK-source digests match manifest.
- PASS: Node 24.21.0 --check on new server/actions/integration .ts and both edited C1 .ts files.
  Syntax only: this is NOT typechecking, React/Next validation, or runtime qualification.
- PASS: owned-path baseline comparison/trailing-whitespace inspection; lock changes only
  six Web importer lines for the existing SDK tarball and provider-accounts workspace edge.
- NOT_RUN: pnpm --filter @reviewrouter/web typecheck; pinned node_modules/tsc absent.
- NOT_RUN: focused PG/HTTP integration, browser/Next build, git diff --check, base verification.
  No dependency installation, Corepack loop, credentials access or live provider probe.

Primary: use pinned dependencies/generated Prisma and a NEW disposable migrated loopback PG.
Run (replace the URL placeholder with that disposable credential-free target):

```sh
RR_C3_ACCOUNTS_PG_TEST=1 RR_C3_ACCOUNTS_DISPOSABLE_CLUSTER=1 \
RR_C3_ACCOUNTS_PG_TEST_URL='<loopback-rr_gateway_test_URL>' \
pnpm exec vitest run apps/web/src/server/account-gateway-accounts.integration.test.ts
```

The opt-in test uses actual SDK HTTP + actual C1 Prisma/PG and existing safe target validation;
red means mutation-before-auth/foreign connection, stale CAS, invented pending account,
credential in response/mirror, replay after lost ACK, or missing local binding denial.
It does not qualify real sessions/context signing in Next, browser cache behavior or providers.

Primary owns commit/integration and separate exact-source gpt-6.1-sol/xhigh/default review.

Primary qualification, 2026-10-04 UTC:

- PASS: pinned full Web TypeScript check, formatting and architecture boundary check.
- PASS: actual C3 SDK HTTP + Prisma/PostgreSQL scenario: 1 passed, 0 failed, 0 skipped.
  New isolated PostgreSQL 17.10 loopback fixture, all 120 SQL migrations applied;
  exact container removed successfully after the run. No live provider or user data.
- PASS: local git diff --check. Product copy simplified to user-facing connection behavior.
- Evidence: p63-source-checks.json, p63-accounts-pg-receipt.json and
  p63-accounts-pg-results.json in the existing hosted qualification results directory.
- NOT_RUN: real Next session/browser, provider, CI tools/final-answer/App publication.

Remaining: Models multi-repository batch; actual disposable browser/HTTP/PG qualification;
D-min/D-final real tools/final/App publication, measured memory/capacity/retention/cleanup;
S operator pool, E actual OpenRouter, F OAuth custody/refresh, G explicit legacy retirement.
H personal sharing remains deferred. No migration, SDK/kernel/native/relay/Action changes,
GitHub mutation, commit/push, deployment, production credential use or full-goal qualification.

## P68 finite P64 P1 repair — 2026-10-05 UTC

Supplied candidate: d388f4884e82d8ca3d27c6fde48dd53840da304e.
PASS: all seven owned preimages match .spike-inputs/manifest.json; frozen P64
review digest matches; norm 53 remains exact SHA256
66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
Git HEAD/status/base verification is unavailable: linked gitdir target is missing.
No prior qualification receipt above qualifies this delta.
Changed exactly the seven manifest paths: Accounts adapter + existing integration
scenario, Accounts repository port + Prisma adapter, two navigation assertion
files, and this handoff. Navigation changes only the two expected accessible
labels to current "Accounts / Workspace provider accounts"; assertions retained.
Accounts now rechecks live session/admin before local denial and before remote
POST. The consumer-owned denial seam locks C1's owned connection row, checks
mirror expectedMetadataRevision under that lock, and retains revoked+pending.
Absent binding is inserted active at revision 1 then revoked with independent
binding/policy revisions 2 and pending fence in the SAME Prisma transaction.
Initial C1 CAS uses the same connection lock: bind-first is subsequently revoked;
disable-first rejects stale bind(0). No committed active gap in absent denial.
Revoked pending retry preserves the exact operation/required revision; other
revokes advance both counters and retain monotonic required policy authority.
No mirror writes, invented remote disabled state, ACK, erasure or cleanup proof.
Interactive expectedRevision and owner checks remain unchanged. C1 resolve and
C2 snapshot/admission use existing selectBinding, denying revoked/pending rows
(inspected, not executed here); no fake actor or API/relay change.
Existing single actual SDK HTTP + Prisma/PG scenario now covers pending and
lost-disable-ACK unknown before binding, a held real HTTP initial-bind GET,
subsequent bind(0), exact-revision pending denial, C1 grant/resolve denial,
reload readback, active unchanged mirror and exact retained fence on retry.
Expected old-source RED: findConnectionBinding returns null after pending
unbound disable; assertion "P64 RED: absent binding must become retained local
denial" fails. Without that assertion, released GET permits active bind(0).
NOT_RUN: RED/GREEN PG, two CI tests, full Web meaningful typecheck, architecture,
lint/format and independent gpt-6.1-sol/xhigh/default exact-source review.
Pinned node_modules (SDK/Prisma/tsc/Vitest/ESLint) are absent; no install attempts,
ambient credentials/runtime/provider access or smoke/deploy/commit occurred.
Primary gates with actual pinned dependencies before integration/merge:

- pnpm --filter @reviewrouter/web typecheck (includes changed TS contracts/test).
- pnpm architecture:check; focused ESLint + Prettier on six changed source files.
- pnpm exec vitest run apps/web/app/dashboard/dashboard-section-tabs.test.tsx apps/web/app/dashboard/dashboard-shell.test.tsx
- Run existing integration command above, new disposable loopback PG17.10,
  all 120 migrations, old source + new test RED then corrected source GREEN;
  require 1 PASS, 0 skip, retained receipts and exact fixture cleanup.
- Independent 6.1 xhigh/default source review; no FAST. Controller owns Git.
  Sourceguard + exact preimages/unified patch exported outside the source tree:
  /srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p68-accounts-denial/tmp/agent/p68-accounts-denial-artifacts
  Full D-min/D-final/S/E/F/G remain; H sharing deferred. No release qualification.

Primary qualification 2026-10-05: full pinned API/Web TypeScript, architecture,
focused ESLint and both existing navigation suites PASS. Existing label control
regex replaced with equivalent character-code check to satisfy ESLint. Actual
NEW disposable PG17.10/all120 migrations: old d388 source plus new scenario RED
on absent denial assertion; corrected source GREEN, 1 PASS/0 skips. Both exact
containers removed. Independent current source review and CI pending. Checkout
qualification is separate and currently not accepted. No provider/App E2E claim.
