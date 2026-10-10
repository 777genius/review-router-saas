# Bounded RR checkout selector companion (account-v)

Supplied base: c321f7e75bb41a37f8575849f343cf62f3ee3a6b.
Observed Git base: UNVERIFIED; .git points to absent linked-worktree metadata.
Read-only index.lock probe: metadata and lock absent; no Git history changed.
Norm53 supplied and measured: 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
Requested writer lane: gpt-6.1-sol/high/default, NO FAST; observed model identity unavailable.
Only owned gateway/test/handoff files changed; production +59/-7, nearest test +59/-2.

POST /api/action/v2/account-gateway/checkout with the existing current run Bearer.
Exact request shape: {providerInstanceId:string,workflowSchemaVersion:number}.
Current example: {"providerInstanceId":"codex-rotating:987654321","workflowSchemaVersion":2}.
Example IDs are the existing synthetic disposable PG/fake GitHub fixture only.
Both fields mandatory; unknown, duplicate (including decoded escaped names), wrong types,
non-UTF8, malformed JSON and extra JSON members fail before issuer (400 invalid_request).
JSON member order is unrestricted; only JSON whitespace and scalar members are parsed.
Body ceiling: 512 bytes in Fastify parser, route and explicit byte check.
Aggregate raw headers: 16,384 bytes; Bearer header: 16,384 characters maximum.
Existing authorization/content-type and framing-header duplicate guards, content-encoding,
query-string and JSON charset rejection stay in place; responses retain no-store.

Provider comparison uses canonicalCodexRotatingProviderId(savedTarget.githubRepositoryId),
where target is resolved by the existing server SCM/repository lookup, never client/binding.
Schema comparison uses CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2 (2).
Both exports verified through the codex-oauth-rotating package root/domain sources.
Mismatch fails 401 authorization_denied before issueContentsReadToken; selectors grant nothing.
Existing selected/unarchived repository, active installation, SCM identity and approved revision
checks resolve the target. Existing original snapshot/config/use/binding, run/version, mutation
epoch, registered release and safety checks remain authoritative, including protected rereads.
No extra OAuth attestation or authorization platform is needed for this approved finite caller.
Reservations, deadlines, issuer awaits, drain and post-await confirmation remain unchanged.
Success still returns exactly protocolVersion, repository, headSha, token, expiresAt, permissions;
permissions remain contents/read + pullRequests/read with the issuer's actual expiry.

Existing real Fastify/PG scenario now checks wrong provider, schema 1/3, missing/unknown/duplicate
selectors (otherwise valid last-wins payloads), types, UTF8, ceiling and encoding; zero mints.
Default request changed; held-mint suspended-installation denial and read-only DTO checks retained.
Red proof for primary: in disposable scratch remove only the selector comparison, keeping the
new parser; wrong provider must invoke issuer and fail the mint-count assertion before status.
Typecheck and actual PG boundary: NOT*RUN; both pnpm attempts exited 127 (corepack absent).
No node_modules/tsc/vitest available; no installs or paid/App external effects performed.
Primary: use locked pnpm 10.33.0 / TypeScript 6.0.3 / Vitest 4.1.10; run API typecheck,
then this test with RR_C2C_PG_TEST=1, RR_C2C_MIGRATED_DISPOSABLE_DATABASE=1 and the existing
passwordless loopback RR_C2C_PG_TEST_URL for a migrated rr_gateway_test_c2c*\* disposable DB.
Patch context/preimage check passes locally; whitespace check reports no errors (diff exit 1).
Guarded patches/guard.json: /srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p85-checkout-selectors/tmp/agent/rr-p85-checkout-selectors-artifacts/.
Preimages reverse only this worker's edits; primary must independently verify the exact Git base.
Remaining P83/P84 Action companion must send these two existing inputs; SDK/protocol untouched.
Full normative D-min/D-final/S/E/F/G remain required and unqualified; H deferred; no release.

Primary qualification: exact guarded raw/base verified; real pinned TS6.0.3 API types and ESLint PASS. Fresh isolated PostgreSQL17.10 at immutable postgres image7958605b, all120 current migrations: nearest real Fastify/Prisma controlled issuer test1PASS0skip, original post-await suspension/readonly checks preserved. Wrong selector requests cannot mint. No live provider or external App call. Paired Action ownerd39d08a forwards the exact two fields; its meaningful TS5.9.3, existing9 lifecycle cases and canonical bundle PASS, current full CI37308287884 PASS. Independent paired source review and actual OIDC/provider/App E2E remain required.
