# Bounded runtime pin review fixes

Supplied source: `184c052e101b75cb826f566ecdc75d4c9d906fb6`; observed Git identity unavailable (linked metadata target missing).
One Git lock probe failed before source writes; all subsequent work used files only. No Git mutations, commits or pushes.
Read full unchanged contract53; SHA256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` matches.
Read accepted REQUEST_CHANGES report; SHA256 `c46eef7160c2a938bf99036b8a92da5d22e3b0c49a28af9fec7108616552eef0` matches.

P1 restoration: the shared creation-event projection always uses admitted version 1 and excludes mutable row version from its input contract. Both adapters retain their existing exact payload, scope, creation-time and nonce/immutable-identity checks; replay returns the current row without inserting another event.
P1 expiry: after the actual liveness read, fresh time checks token expiry, current row expiry, maximum expiry and pinned deadline before returning valid. Expiry returns `expired`, including at the maximum; binding revocation still returns `revoked`. Renewal rules are unchanged.
The SAME PG scenario retains no-extension renewal and adds TTL extension to version 2, same/fresh nonce restoration, actual synthetic OIDC restoration, old-token claim drift, and terminal version 3 restoration. One original event and exact snapshot/deadline remain asserted.
The SAME actual binding-read wrapper now crosses token expiry below the maximum and still crosses the maximum. It asserts that the real original-binding read was live before advancing the test clock; the renewed token avoids unrelated claim drift.
Comments immediately before extensions state the observed source regressions: nonexistent version-2 event lookup and valid-after-short-expiry resolution. Red/green execution is NOT_RUN here.

Changed files:

- `packages/features/review-run-control/src/application/integration-events/review-run-authorized-event.ts`
- `packages/features/review-run-control/src/application/use-cases/manage-review-run-authorizations.ts`
- `apps/api/src/review-run-runtime-snapshot.postgres.test.ts`
- `C2C_RUNTIME_PIN_REVIEW_FIXES_HANDOFF.md`

Unchanged consumers of the shared fix:

- `packages/features/review-run-control/src/infrastructure/prisma/prisma-review-run-authorization-repository.ts`
- `packages/features/review-run-control/src/infrastructure/memory/in-memory-review-run-control-store.ts`

Source patch: `/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-runtime-pin-two-fixes/tmp/agent/runtime-pin-two-fixes-artifacts/runtime-pin-two-fixes.patch`.
Available checks: input hashes PASS; Node 24 `--check` syntax checks PASS on all three changed TS files; source patch contexts and unchanged adapter bytes checked. Syntax checking is not typechecking.
NOT_RUN nearest typechecks: `pnpm exec tsc --noEmit -p packages/features/review-run-control/tsconfig.json` and `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`; TypeScript, Vitest, Prisma and workspace node_modules are absent. No installs performed.
NOT_RUN real PG: primary executes `pnpm exec vitest run apps/api/src/review-run-runtime-snapshot.postgres.test.ts` with `RR_C2C_PG_TEST=1`, `RR_C2C_MIGRATED_DISPOSABLE_DATABASE=1`, and its migrated disposable loopback `RR_C2C_PG_TEST_URL`. Existing database guards are unchanged.
Risk: behavioral and type-contract verification awaits primary execution. No full53/product acceptance or readiness claim; no agents, provider calls, runtime smokes, workflows, deployments or credential reads.

Primary qualification after terminal raw ee0358f5 was preserved/unqualified:
project-pinned formatter applied, unchanged scanner preserved raw; realPG17.10
all119SQL through120 applied on disposable tmpfs with uniquecontainer IDs.
Same expanded actual PG scenario BEFORE old184 production fails original
version2 creation-event lookup; AFTER revised production1/1PASS zeroSkip,
including short token expiry belowmaximum and unchanged original authority.
Test sourceSHA09957bf754c139d92c203755c0b07d870043109f766bbf7f23361281b745993d.
RunControl/API strict typechecks PASS; nearest existing authorization/repository
contract suites PASS. Each disposable PG removed cleanup0; no realprovider.
CI historical through79 fixture currentPrisma omitted ONLY SQL120field from
returned selection; realsamehistoricalDB31/31PASS zeroSkip and typesPASS,
previouscurrentCI31failed missingcolumn. Historical79 semantics unchanged.
Independent exactsource delta review/currentCI still required; no merge/productclaim.
