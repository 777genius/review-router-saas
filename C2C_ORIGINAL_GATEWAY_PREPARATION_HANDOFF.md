# Original Gateway preparation: bounded source handoff

Supplied source: 0d29516f6d9505961f569db45ffdf81721045955; observed Git identity UNAVAILABLE (linked metadata target inaccessible).
One Git lock probe reported GIT_LOCK_PROBE_INACCESSIBLE before source writes; Git operations stopped. No add/commit/push/reverts.
Full unchanged .spike-inputs/53-account-gateway-implementation-contract.md SHA256: 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0 (verified).
Source changes only (576 changed LOC across 12 owned paths); primary must qualify its existing pinned cache. No new tests or SDK/platform expansion; no relay/UI/provider/paid/admin/credential/workflow/deploy/release work.

Changed owned paths:

- apps/api/src/review-run-runtime-snapshot.ts; apps/api/src/review-run-gateway-preparation.ts; apps/api/src/prisma-review-run-gateway-execution-binding.ts
- packages/features/review-run-control/src/domain/review-run-runtime-snapshot.ts; packages/features/review-run-control/src/application/ports/review-run-gateway-execution-binding-port.ts; packages/features/review-run-control/src/index.ts
- packages/platform/db/prisma/schema.prisma; packages/platform/db/prisma/migrations/000121_review_run_gateway_execution_binding/migration.sql
- scripts/lib/render-schema-handoff-policy.mjs; scripts/check-codex-rotating-migration-rehearsal-historical96.test.ts; scripts/codex-rotating-release-migration-workflow.test.ts; this handoff

ServerApprovedReviewRunGatewayPolicy is an explicit backend constructor argument: profile allowlist + all five SDK-validated caps, copied/frozen before admission. Missing policy denies new gateway captures; non-gateway captures and legacy pin reads remain supported.
Domain keeps detached finite positive safe-integer allowance data with no transport/SDK imports. Legacy gateway pins without caps cannot prepare/attach; no defaults or mutable-policy budget recalculation.
Existing serializable admission recapture still compares complete canonical pins, including original caps/IDs/deadline. Preparation uses only saved complete c.Prepare and actual verified owner/head/attempt, checks current local authority, makes one private HTTP call, and rechecks expiry after awaits.
createReviewRunGatewayPreparation binds one authorization/verified identity; prepare restores attached safe facts without HTTP. recoverSameOperation explicitly reacquires the ORIGINAL operation; no automatic retry, inference, new ID/account or reset. ExecutionClient/control credential stay private in backend functions, never in returned facts.
Safe attachment stores bindingVersion/operationId/executionRef/accountRef/actual Gateway authorizationEpoch/original deadline only; original snapshot supplies the remaining admission fields. Gateway epoch is never synthesized from C1 revisions.
Prisma adapter locks connection -> binding -> existing authorization, compares complete verified tuple/private snapshot, checks original binding through the transactional reader and fresh DB time, and CAS-attaches NULL once. Identical restores; conflicting selections deny. No public mapper/claims/outbox changes.
SQL121 bounds canonical safe fields, rejects extra/bearer fields, insertion with a preattached result, reset/replacement/owner drift, missing/fractional caps and inactive/expired first attachment. UTC expiry comparisons are session-timezone independent. Legacy NULL remains NULL; renewal/terminal state changes retain selected facts.
SQL120 unchanged SHA256: 6ced2dc41f736a2c6e42d6edafc4e9f753622fa157baff09ea962da9d81bd369 (verified).
SQL121 SHA256: c00f5df0b3971477cdf666b3259e173aec2df0d150e3335507617242742967e6.
Current 120-file manifest: sha256:5f01c4416620cf984ffa5fee8dbb26bcf171ae3a89ec4e4b8615e4c7c8461c64; managed92/frozen predecessors preserved. Current checkout admission/canonical catalog read PASS (120 files, latest121; managed92).

Checks: Node --check PASS on changed API/domain/port/catalog/test-tail sources. These are syntax checks, NOT typechecking.
Typechecks, Prisma validation, Vitest, migrated PG/OIDC/current-HTTP qualification NOT_RUN: source-only checkout has no node_modules/tsc; pnpm wrapper fails because its configured corepack binary is absent. No installs/workarounds attempted.
Historical reader check FAIL: render_historical96_checkout_rejected:count. Its exact unowned path scripts/lib/render-historical96-checkout.mjs must allow checkout count120 and exclude000121 while retaining the immutable historical96 manifest; the existing owned test tail now expects121.
Required unowned integration: apps/api/src/review-action-v2-production-composition.ts must accept server-approved policy through backend composition and pass it to ProductionReviewRunRuntimeSnapshot. Its current policy-less construction intentionally denies new gateway admission. Compose the private preparation factory/Prisma attachment after existing verified RR admission; do not add a public capability response.
Other worker's manage-review-run-authorizations.ts, review-run-authorized-event.ts and existing PG scenario were not edited. Run the primary's scenario extension only after that nonoverlapping repair is terminal.

Primary qualification, using existing pinned dependencies: regenerate Prisma; pnpm --filter @reviewrouter/features-review-run-control typecheck; pnpm --filter @reviewrouter/api typecheck; pnpm exec vitest run scripts/check-codex-rotating-migration-rehearsal-historical96.test.ts scripts/codex-rotating-release-migration-workflow.test.ts.
Apply all120 SQL to the existing disposable PG17.10 fixture; set its existing RR*C2C_PG_TEST_URL (loopback rr_gateway_test_c2c*\* database, no password), then RR_C2C_PG_TEST=1 RR_C2C_MIGRATED_DISPOSABLE_DATABASE=1 pnpm exec vitest run apps/api/src/review-run-runtime-snapshot.postgres.test.ts. Require zero skips; use actual current private /internal/v1/run-access HTTP and configured server-only control credential, without printing it.
Extend that existing real PG/OIDC scenario, not mock/source-string tests. Minimal approved profile fixture: mimo-responses-v1; illustrative TEST-only caps {requests:2,concurrency:1,requestBytes:4096,outputBytes:8192,tokens:128}; exact owned gateway account/binding and original max deadline. These numbers are not qualified production defaults.
Observable failures it must catch:

- Settings/policy mutation, concurrent admission or renewed/restored OIDC must never replace original five caps/profile/IDs/deadline; real serializable admission must deny a changed recapture.
- Unconfigured policy, malformed/partial/fractional/unbounded caps, caps-less legacy pins, foreign/head/attempt/snapshot mismatch, revoked/pending/unknown binding and expired authority must produce zero fresh preparation calls/attachments.
- An actual applied HTTP selection must attach once on the existing authorization; selected account and Gateway epoch must match the HTTP result/admission, with epoch deliberately distinct from C1 revisions; bearer must be absent from DB/claims/outbox/safe return.
- Competing SQL/CAS attachments must yield one selected tuple; identical readback restores, different execution/account/epoch/deadline/operation conflicts; raw SQL insert/reset/extra-key/owner-drift and legacy retrofit must reject.
- Loss after HTTP/before attachment must not trigger an internal second call; explicit same-operation recovery must restore the same selected tuple/attachment and original deadline. Unknown/invalid/expired gateway result cannot attach.
- Actual awaited reads/HTTP/attachment crossing the shorter current authorization expiry or original maximum must deny; non-UTC SQL sessions must enforce the same UTC instant; renewal and reconnect/revoke must preserve immutable selected identity.
  Qualification and unowned joins remain pending: no full E2E/readiness claim. Actual relay/Action/tools/final/parser/App is the immediate next lane. D-final/S/E/F/G remain required; H deferred.

## Primary qualification, 2026-10-04

The preceding worker handoff is historical; primary completed its stated joins without SDK changes.
Production composition now reads explicit server-only REVIEW_ROUTER_ACCOUNT_GATEWAY_POLICY with all five caps; absent policy remains deny.
Existing PG/OIDC scenario extended at the real migrated SQL + loopback HTTP boundary: same-operation recovery, write-once selection, distinct actual epoch, private capability exclusion.
Run Control and API pinned typechecks PASS. Actual PG17.10 all120 SQL and the existing scenario PASS1/1 zero skips (v10); earlier v9 failed on a policy-less fixture reader and is retained.
Current nearest catalog tests PASS122/122 zero skips; real historical-through79 fixture PASS31/31 zero skips after omitting both additive private columns in its existing queries.
Prettier formatted TS/MJS; its aggregate exit2 was only the unsupported Prisma parser, not a whole-format PASS. Prisma generation PASS.
Source review and full current CI remain required. HTTP endpoint was a controlled loopback fixture, not live Gateway inference or product E2E.
Next bounded relay must retain ExecutionClient privately and compose run-scoped execute/status/close; safe preparation DTO stays unchanged.
Actual CI tools -> MiMo -> nonempty final -> parser -> same-head App publication remains UNPROVED; full D-final/S/E/F/G required, H deferred, no release.
