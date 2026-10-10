# Initial gateway account picker — bounded C3 handoff

Supplied base: `01e7388d72453d052235ab06d5710683f7abab33` (`.spike-inputs/manifest.json`).
Observed HEAD: NOT_VERIFIABLE; linked `.git` points to unavailable p80-server-source metadata.
Git status/HEAD/locks cannot be verified; no history/index operation was performed.
Norm53 SHA256 verified: `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.
Preimages are the observed supplied worktree bytes, not a verified Git checkout receipt.

Changed only these owned paths:

- `apps/web/src/server/account-gateway-accounts.ts`: scoped binding display ID.
- `apps/web/app/dashboard/dashboard-workspace-page.tsx`: authorized RSC page forwarding.
- `apps/web/app/dashboard/repository-policy-editor.tsx`: shared account/model selection and guards.
- `apps/web/app/dashboard/repository-policy-editor.test.tsx`: form behavior regressions.
- `apps/web/src/server/account-gateway-accounts.integration.test.ts`: existing PG projection assertion.
- `GATEWAY_PROVIDER_PICKER_HANDOFF.md`: this handoff.

Bounded C3 closure plan implemented:

1. Extend safe binding projection with `id` from the existing workspace/connection lookup.
2. Load `loadAccountsBootstrap(workspaceId)` for Models/repositories RSC first paint; pass only its safe page.
3. Forward choices through both repository editors and WorkspaceReviewConfigForm into ReviewConfigForm.
4. Choose auth, account, then matching-profile model explicitly; changing auth does not bind an account.
5. Keep existing saves and batch per-target authorization/CAS; qualify this patch through primary CI/UI gates.

Only active accounts with active, unfenced bindings and known profile models are selectable.
An empty gateway selection disables submission and the submit handler prevents saving it.
Refresh preserves the selected tuple; revoked, disabled, unbound, mismatched or unavailable choices block saving.
Saved refs/model remain in existing hidden fields, including when visible choices are unavailable.
Denied/unavailable bootstrap yields no eligible choices with meaningful copy; no fallback selection.
The first page is explicitly limited when nextCursor exists; off-page saved selections are retained and blocked.
Existing direct providers, requiredHealthy/agreement/multi-provider controls and backend checks are preserved.
IDs/display are not authority; final workspace binding/profile/fence checks remain in the existing repository adapter.
No new dependencies, route, mutation, cache layer, native descriptor or credential readback.

Regression evidence: preimage auth handler returned immediately for gateway and offered it only when saved.
New UI observations cover initial workspace/repository selection, empty/model-cleared submit denial, profile models and refresh denial.
Existing whitespace/ultra and auth-switch tests retained; existing real PG case now asserts exact scoped binding projection.
Patch size: 204 production added lines; 110 test added lines (before handoff).
Ran: Norm53 digest/preimage hashing, whitespace/newline checks, full source diff inspection and zero-fuzz patch dry-run.
NOT_RUN: nearest UI Vitest, full web TypeScript contracts, ESLint; installed/cached dependency metadata is absent.
UNAVAILABLE: attempted Git diff whitespace check failed on the inaccessible linked metadata; local added-line check passed.
Required pins for primary qualification: TypeScript 6.0.3, Vitest 4.1.10, @types/node 22.19.17.
NOT_RUN: PG integration; primary must supply an explicit NEW disposable migrated fixture, never ambient DB.
Primary commands: `pnpm exec vitest run apps/web/app/dashboard/repository-policy-editor.test.tsx`;
`pnpm --filter @reviewrouter/web typecheck`; ESLint on the five changed source/test files; `git diff --check`.
Then run the existing accounts PG integration with its explicit disposable-fixture opt-in.

Guarded patch and SHA256 preimage/result manifest:
`/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p97-provider-picker/tmp/agent/provider-picker-artifacts/provider-picker.patch`
`/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p97-provider-picker/tmp/agent/provider-picker-artifacts/preimages.json`
Apply only after checking every preimage hash and exact-source review/CI; no fuzzy application over another worker's edits.
Remaining actual gates: primary UI rendering/account selection/refresh, authorized batch partial-result/CAS scenarios, scoped PG readback.
Primary owns live D-min and D-final canary/batch qualification; P95 private-service review remains independent.
D-min/D-final/S/E/F/G remain required and unqualified by this patch; H is deferred. No live/paid/App/deploy effects launched.
Worker preparation is complete; primary goal remains ACTIVE. Initial hosted qualification found one discriminated-union TypeScript error and one unset legacy-secret mock. Both are corrected in the separately qualified candidate; original output and initial failing evidence retained. Final exact-source independent review/CI and live qualification remain required.

Primary qualification: pinned web TypeScript, ESLint, format and diff PASS; existing UI suite 39 PASS/0 FAIL. Old UI with the same two initial-choice cases: 2 FAIL because the gateway option is absent. NEW disposable PostgreSQL 17.10 with all 120 current SQL migrations: existing Accounts integration 1 PASS/0 FAIL, exact scoped binding ID assertion included. Containers stopped; zero provider/App effects. Original failed qualification attempts are retained. Independent source review and full CI remain pending.

## P101 - final P99 P2 repair, qualified by primary

Final independent P99 report80e0681d requires a single provider when gateway auth is present.
The form now rejects unsupported mixed/multiple gateway saves, blocks Add provider while gateway is selected,
and disables/explains gateway auth in direct multi-provider configurations.
Saved tuples remain available for explicit removal or direct-auth repair; runtime restriction is preserved.
Three parameterized observable UI cases cover mixed/multiple selection, repair, direct add/remove and save.
Primary corrected fixture identities to use distinct provider models; repeated identical models already violate
the existing strict configuration contract. All original failed evidence is retained.
Pinned TypeScript6.0.3, ESLint, Prettier and diff PASS. Existing UI42PASS/0FAIL.
SAME three regression cases with the old339781 production form:3FAIL because unsupported saving remains enabled.
No schema/PG change; previous real-PG120-migration receipt is retained without another run.
Original rawf80911c50 archived NONPRODUCT. Qualified source needs independent review and current full CI.
D-min/D-final/S/E/F/G remain unqualified; root goal ACTIVE, H deferred. No provider/App effects or release.
