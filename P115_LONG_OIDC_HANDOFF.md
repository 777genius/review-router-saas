P115 worker source handoff (2026-10-05).

Primary qualification completed on an isolated Hetzner fixture: API/domain
typechecks PASS, existing authorization unit 19/19 PASS, actual HTTP/PostgreSQL
paired RED/GREEN PASS. The original code returned 401 after the former TTL;
the same test passed on this patch. Both fresh databases received all 120
unchanged migrations through SQL121 and were removed. Final formatting and
ESLint passed; the formatter preserved the changed TypeScript AST.
Evidence summary SHA256:
`c692df09cc87a0f2103f6a7c507da2917548657e52d6a0f84927bbcccb8b271b`.
The worker observations below remain historical. Independent review, current
CI and full product E2E are separate outstanding gates.
Sole authority: `.spike-inputs/contract53.md`; observed SHA256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` matches supplied digest.
Supplied source HEAD: `01e7388d72453d052235ab06d5710683f7abab33` (`.spike-inputs/manifest.json`).
Observed git HEAD: unavailable; linked `.git` targets an inaccessible/missing p80 worktree administration directory. No git/history writes.
Current file identities and reconstructed pre-edit SHA256 are retained beside the exact patch in `source-identities.json`; supplied HEAD is not claimed verified.

Changed only the four owned source/test paths and this report:

- `packages/features/review-run-control/src/application/use-cases/manage-review-run-authorizations.ts`: first captured full gateway snapshot must match approved max deadline; persist/sign expiresAt=maxExpiresAt. Ordinary TTL and restores retain existing behavior.
- `packages/features/review-run-control/src/tests/review-run-authorization.test.ts`: strengthen existing ordinary expiry case; keep renewal/mismatch tests.
- `scripts/review-action-v2-production-e2e/support/review-action-v2-e2e-harness.ts`: bounded synthetic OIDC lifetime, safe expiry/count evidence; default remains 600s.
- `apps/api/src/review-run-gateway-long-run.postgres.test.ts`: one production HTTP/SQL scenario, signed synthetic OIDC, real clocks; fixture-only server timing 5s TTL/18s deadline.
  Scenario asserts original capability after OIDC exp/former TTL, same invocation/attempt/account, one preparation, unchanged row/no renewals, and independent close/revoke/deadline denial with zero extra dispatch.
  Read-only diagnosis confirmed signing adapter:135, relay:145, preparation:113, binding SQL:74, composition:2715 (1h/6h); their expiry guards stay intact.

Actual checks: authority digest matched; all four modified TypeScript files parsed with Node `stripTypeScriptTypes` transform mode in a newly isolated disposable fixture. This is syntax evidence ONLY.
Patch handoff check: apply to a new isolated reconstruction of pre-edit owned files, verify exact bytes against all five current files, reverse and verify original bytes. This checks artifact fidelity, not runtime behavior.
Meaningful typechecks attempted: API and review-run-control tsconfig commands; both exited 127 before compiler startup (pnpm's corepack target missing). No node_modules/tsc available; no dependency/toolchain hunting or upgrades.
Targeted Vitest invocation exited 127 before test startup for the same reason. ZERO behavioral tests ran; no RED/GREEN or product E2E PASS claimed.
Disposable PostgreSQL execution unavailable: no psql/PG binaries and no Docker socket. No real-project/paid/GitHub/App probes or credential reads performed.
Raw check evidence: `/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p115-long-oidc/tmp/agent/p115-verification-ila9pgxv/verification.json`.
Exact patch/identities: `/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p115-long-oidc/tmp/agent/p115-long-oidc-artifacts/`.

Primary qualification with existing real cache, in NEW disposable source + migrated PG fixtures for EVERY run:

1. Export supplied source, apply patch; reuse locked dependencies/generated Prisma client, without package upgrades or env/credential copying.
2. `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` (includes the imported harness) and `pnpm exec tsc --noEmit -p packages/features/review-run-control/tsconfig.json`.
3. On a newly created loopback database `rr_gateway_test_p115_<unique>`, apply existing RR migrations through SQL121 using fixture-only DATABASE_URL; do not use production or db push.
4. `RR_P115_PG_TEST=1 RR_P115_FRESH_MIGRATED_DATABASE=1 RR_P115_PG_TEST_URL=postgresql://<fixture-role>@127.0.0.1:<fixture-port>/rr_gateway_test_p115_<unique> pnpm exec vitest run apps/api/src/review-run-gateway-long-run.postgres.test.ts`.
5. Run identical case on original use-case source with the harness/test patch retained and a DIFFERENT fresh DB: expected RED at long.status (401 instead of 200). Fixed source + another fresh DB must GREEN. Retain commands/results/source identities.
6. `pnpm exec vitest run packages/features/review-run-control/src/tests/review-run-authorization.test.ts`; retain existing mismatch/renewal gates. Destroy disposable fixtures after evidence capture.
   Remaining gates: meaningful typechecks, controlled HTTP/PG RED/GREEN, existing regression checks, independent exact-source review and integration acceptance.
   Full D-min/D-final/S/E/F/G remain mandatory; H sharing deferred. This packet closes no product, production, release, migration or coexistence gate.
