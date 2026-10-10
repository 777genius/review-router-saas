P112 S operator grants — Refs490 — 2026-10-05

Normative authority: `.spike-inputs/contract53.md`, SHA-256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` (verified).
Supplied source identity: `dab31ce2d0ae3274edc742c64bb8922867e71c20` from the manifest.
Observed Git identity: unavailable; `.git` points to an absent/unmounted p80 worktree metadata directory. File hashes are retained with the checks.

The trusted server-only `ACCOUNT_GATEWAY_OPERATOR_WORKSPACE_ID` designates an opaque Workspace.id. Unset configuration denies foreign use while ordinary own BYOK continues.
`changeOperatorWorkspaceAccountGrant` requires actual live operator membership, excludes login overrides, and rechecks/locks that membership in the Prisma transaction.
One ordinary consuming binding is the explicit grant record. Existing XOR ownership, canonical accountRef, unique binding pairs and independent revisions remain authoritative.
Recipient admins can detach an existing operator use, but cannot create or reauthorize foreign use. Paid entitlement and arbitrary foreign/user ownership grant nothing.
Runtime capture, admission and original-snapshot liveness accept only current active, fence-free explicit operator bindings; the canonical account identity and account-global occupancy path remain unchanged.
Revoke retains immediate local denial plus the stable durable binding fence. The server adapter performs bounded exact SDK fence delivery/readback through existing reconciliation and exposes scoped recovery.
Continuation audit fixed operator revoke depending on Gateway GET/catalogue availability: revocation now commits local denial first, and a concurrently acknowledged exact fence reports applied truthfully. The actual-PG fixture also checks scoped revoke after global disable.
Accounts lists paginate explicit grants with safe metadata and `canManage: false`. Owner controls remain owner scoped; granted selection compares live independent revisions around Gateway reads.
Owner reconnect/disable retain the existing Gateway authEpoch authority across all uses. No schema, SDK, kernel, native, issuer, migration or release changes were made.

Changed paths (all manifest-owned):

- `packages/features/provider-accounts/src/domain/provider-account.ts`
- `packages/features/provider-accounts/src/application/ports/provider-account-repository-port.ts`
- `packages/features/provider-accounts/src/application/use-cases/workspace-account-bindings.ts`
- `packages/features/provider-accounts/src/infrastructure/prisma/prisma-provider-account-repository.ts`
- `apps/api/src/review-run-runtime-snapshot.ts`
- `apps/api/src/review-action-v2-production-composition.ts`
- `apps/web/src/server/account-gateway-accounts.ts`
- `apps/web/app/dashboard/account-gateway-account-actions.ts`
- `apps/web/app/dashboard/account-gateway-account-controls.tsx`
- `apps/api/src/account-gateway-operator-grants.postgres.test.ts`
- `P112_OPERATOR_GRANTS_HANDOFF.md`

Checks: existing provider-account Node tests 31/31 PASS; `tsc --noEmit -p packages/features/provider-accounts/tsconfig.tests.json` PASS; Gateway run-access tests 37/37 PASS; changed TypeScript formatting PASS.
API and Web `tsc --noEmit` were run against real generated Prisma/SDK contracts. Both remain blocked by missing `@777genius/subscription-runtime` dist exports and consequential errors in hosted-account-pool; no owned-file diagnostics remain.
The new single PostgreSQL qualification and existing C3 PostgreSQL test were SKIPPED, not passed: Docker has no daemon socket, and no local PostgreSQL installation or supplied disposable database is available.
The new fixture covers signed synthetic identity/live role loss, X/Y canonical admission, paid/ungranted denial, unauthorized grants, delayed exact fence ACK/recovery, old/new-ID denial, recipient detach, ordinary BYOK, foreign/user denial and owner global disable.
It exercises actual RR SQL/Prisma and controlled Gateway HTTP when enabled; it does not assert new native/kernel capacity or provider qualification.

Primary qualification: provision a NEW disposable loopback PostgreSQL cluster, apply the existing full migrations, then run:
`RR_S_OPERATOR_GRANTS_PG_TEST=1 RR_S_OPERATOR_GRANTS_DISPOSABLE_CLUSTER=1 RR_S_OPERATOR_GRANTS_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/rr_gateway_test_s_p112 node node_modules/vitest/vitest.mjs run apps/api/src/account-gateway-operator-grants.postgres.test.ts`
The fixture refuses ambient DB credentials, passwords, remote hosts and non-disposable names; delivery touches only its newly created binding pairs. Dispose of that cluster after retaining evidence.
Evidence directory: `/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p112-operator-grants/tmp/agent/p112-checks/`.
`git diff --check` could not run because linked metadata is unavailable. No add, commit, push, deploy, production session/secret write or live-provider probe occurred.
Goal status: BLOCKED after the same qualification blockers were verified across three consecutive goal turns. Primary must supply the disposable migrated PG fixture and missing runtime exports; implementation and evidence remain intact for Project Integration.
Previous goal turn: progress (revoke availability fix). This audit confirms exact source hashes unchanged and no live qualification process to wait for; completion is unproven until the pending gates pass.
