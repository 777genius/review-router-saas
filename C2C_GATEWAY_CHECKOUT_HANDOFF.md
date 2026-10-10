# C2c authenticated SCM checkout companion

Supplied source: `777genius/review-router-ai@8da8db477d9539da196398680c11a334baca1ce5`.
Sole authority: `ai-docs/architecture/53-account-gateway-implementation-contract.md`; observed SHA256
`66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`, equal to the supplied contract53 digest.
Observed `.spike-inputs/manifest.json`: `ef83bb364bc325963d80f1921ab8a241b77cedb73bb426a33dd9ab25349d8870`.
Frozen handoff: `fc5288bbe2e25d381c62535ccf5a94ccb9290698fd318bafaad775c56105f12b`;
frozen runtime/DTO: `69df6c7e978fdbaefd465782d9c0ed4080b853955f43c3b207db431694636992`, both match manifest.
The manifest's Action patch digest is a declaration; those patch bytes were not supplied. The older source identifier in the frozen Action handoff is not this backend base.

Observed preimage SHA256: composition `65ba0ac0831e04b3d276ebd33ffa31c702dfca4083d386d012abe0b3bf716057`;
app `ffd7090dc8852c00986c1c683f5b5b035f86d6b0def8dd3bb39627f41d80a490`.
Both equal independently downloaded immutable raw GitHub files at the supplied canonical source SHA. This verifies these edited preimages, not the entire checkout HEAD.
`git rev-parse HEAD`, `git status --short`, and `git rev-parse --git-common-dir`: exit 128, linked gitdir unavailable in this sandbox.
Git common-directory/lock ability: NOT_RUN beyond that discovery failure. No staging, commit, push, deployment, secret-file read or credential output.

Owned changes only:

- `apps/api/src/review-run-gateway-checkout.ts` (new API capability adapter and HTTP route).
- `apps/api/src/review-action-v2-production-composition.ts` (shared protected confirmation, existing App issuer and current SCM lookup).
- `apps/api/src/app.ts` (existing application-boundary registration).
- `C2C_GATEWAY_CHECKOUT_HANDOFF.md` (this finite handoff).

Observed final source SHA256:

- checkout: `94aaa03371354bc578b979aa0e51bb88274b97e1f4efa282e54ecd1ad17b7818`.
- composition: `4d09549957ab65ba7e390a8b1efe8232cfb2bc4792c08ca7c2cdee4dbf85778d`.
- app: `b6175c41f0c5bf1d683f87e90f97acce5d29d954aa360ddbd7e7d22fe155567c`.
  Relay, existing PG scenario and UI files were not edited or reverted. No tests, harnesses, dependencies, packages or migrations added.

HTTP contract is exactly `POST /api/action/v2/account-gateway/checkout`, JSON empty object and current v2 run Bearer.
Only the six frozen capability fields are returned, with literal read-only permissions and the issuer's actual expiry (>30 seconds remaining at return).
Body fields/query selectors cannot supply authority; job/repository/head/account/provider headers are never consumed as authority.
Registration uses the existing `REVIEW_ROUTER_ACCOUNT_GATEWAY_RELAY_ENABLED=1` opt-in and the already configured fixed GitHub App.
Missing adapter issuer denies `checkout_unavailable`; missing production App credentials retain existing startup rejection. Disabled opt-in registers no route.
There is no rotating lease, prelease, authJSON, refresh/writeback, fallback, publication token or model access in this adapter.

Authorization uses existing current-token resolution, original pinned runtime snapshot and `PrismaReviewRunGatewayExecutionBinding.read` before issuance.
The existing reader checks canonical saved config, original connection/use revisions and live binding authority; an absent execution attachment is allowed because checkout precedes inference.
Settings changes retain admitted configuration by contract53; current config is not used to choose a replacement account/provider.
Current SCM lookup requires the saved workspace/repository/SCM identity, bound GitHub identity, selected unarchived repository and active same-workspace installation.
Existing `currentRevision.resolve` must match the entire approved revision (including head), both before and after issuer completion.
Existing OIDC event/fork/App admission and binding membership/revocation policy remain authoritative; no caller actor or blanket fork policy is introduced.
After the asynchronous issuer settles, the adapter resolves the current token again, checks the same authorization/version/owned identity/snapshot,
rechecks SCM and binding, then runs the shared protected auth/epoch/release/safety confirmation with fresh DB time. Failure returns no capability.
Already minted or returned GitHub read tokens are governed by GitHub expiry/cache semantics; this route does not revoke them remotely.

The relay's two-argument `confirmAuthority` path now uses `confirmAccountGatewayAuthority` in the existing composition.
Its repository scope guard, authorization SHARE, transaction-bound safety resolver, active/version/identity/snapshot checks, actual clock sampling,
v2 mutation mode/epoch and registered release checks retain their original order/semantics. Relay SCM preflight, callbacks and close behavior are unchanged.
Checkout additionally supplies the server-resolved read target, enabling a protected local branch before issuance and again after issuer/SCM waits.
That branch holds installation/repository/connection/original-use SHARE locks before authorization SHARE, then rereads current target and calls existing
`runtimeSnapshots.isLive` on the same transaction. Local selection rules are shared by preflight and protected reads. Original-use revocation while
confirmation waits cannot leave an earlier binding observation in force; fresh DB time follows every read. No HTTP runs under these SQL guards.
The existing binding reader is reused; no capability is stored in SQL or logs.

Bounds: raw JSON body 64 bytes; aggregate raw headers 16,384 bytes; token 16,384 characters; repository 201 characters;
in-flight checkout slots `min(4, relay.maxInFlight)` reserved in onRequest before body/token/SCM work; timer `min(30,000ms, relay.requestTimeoutMs)`.
Only JSON whitespace plus `{}` is accepted, rejecting unknown/duplicate/escaped body fields and malformed UTF-8; auth/content-type duplicates,
duplicate framing headers, content encoding, query selectors and non-Bearer auth are rejected. Errors are fixed sanitized codes; route replies use no-store.
Disconnect/timeout/shutdown latches cancellation; timeout destroys the response/socket. Each issued dependency is awaited to settlement, never detached or raced.
The reservation remains occupied while an issuer/SCM call is outstanding, even after the caller disconnects or the timer fires.

Exact issuer limitation: `workflowInventory.issueContentsReadToken` calls `mintRepositoryToken`, which awaits `app.octokit.auth` with one repository ID
and `{contents:'read',pull_requests:'read'}` and validates issuer expiry/permissions (only inherent metadata read may additionally exist).
Its constructor is `new App({appId, privateKey})`; this auth path supplies no timeout or AbortSignal and exposes no cancellation port.
The separately configured 15-second secret-PUT timeout does not apply. SDK/transitive default retries/timeouts cannot be verified without dependencies.
Existing SCM resolution likewise has no checkout cancellation contract. Thus the timer bounds result delivery/admission, not underlying issuer/SCM settlement or total handler lifetime.
A hung dependency can occupy the finite slots until it settles; saturation denies further work. No hard issuer cancellation bound, cleanup SLO or production qualification is claimed.

Performed commands/results:

- `sha256sum ai-docs/architecture/53-account-gateway-implementation-contract.md .spike-inputs/manifest.json .spike-inputs/ACCOUNT_GATEWAY_ACTION_HANDOFF.md .spike-inputs/account-gateway-runtime.ts`: exit 0; digests above.
- `curl --max-time 15 --silent --show-error --fail https://raw.githubusercontent.com/777genius/review-router-ai/8da8db477d9539da196398680c11a334baca1ce5/apps/api/src/review-action-v2-production-composition.ts -o /srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action/jobs/review-router-mimo-openrouter-v1-gateway-p54-checkout/tmp/agent/checkout-preimage/canonical-composition.ts`: exit 0.
- `curl --max-time 15 --silent --show-error --fail https://raw.githubusercontent.com/777genius/review-router-ai/8da8db477d9539da196398680c11a334baca1ce5/apps/api/src/app.ts -o /srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action/jobs/review-router-mimo-openrouter-v1-gateway-p54-checkout/tmp/agent/checkout-preimage/canonical-app.ts`: exit 0. Download hashes equal preimages above.
- `node --experimental-transform-types --check apps/api/src/review-run-gateway-checkout.ts`: exit 0.
- `node --experimental-transform-types --check apps/api/src/review-action-v2-production-composition.ts`: exit 0.
- `node --experimental-transform-types --check apps/api/src/app.ts`: exit 0. These three commands check syntax only.
- `sha256sum apps/api/src/review-run-gateway-checkout.ts apps/api/src/review-action-v2-production-composition.ts apps/api/src/app.ts`: exit 0; final source digests above.
- `pnpm --filter @reviewrouter/api typecheck`: exit 127, pnpm shim's corepack missing; node_modules/npm/tsc unavailable. Meaningful contract typecheck: NOT_RUN. No installs or toolchain rebuild.
- Initial worktree `git diff --no-index --check` attempts: exit 128 because the linked gitdir is unavailable. Standalone inspection from `/srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action/jobs/review-router-mimo-openrouter-v1-gateway-p54-checkout/tmp/agent` succeeded below; exit 1 denotes changed files, with no whitespace diagnostics:
- `git diff --no-index --check checkout-preimage/review-action-v2-production-composition.ts /srv/workers/jobs/review-router/mimo-openrouter-v1/repos/gateway-action-p47/workspaces/p54-checkout/apps/api/src/review-action-v2-production-composition.ts`: exit 1.
- `git diff --no-index --check checkout-preimage/app.ts /srv/workers/jobs/review-router/mimo-openrouter-v1/repos/gateway-action-p47/workspaces/p54-checkout/apps/api/src/app.ts`: exit 1.
- `git diff --no-index --check /dev/null /srv/workers/jobs/review-router/mimo-openrouter-v1/repos/gateway-action-p47/workspaces/p54-checkout/apps/api/src/review-run-gateway-checkout.ts`: exit 1.

Primary must extend the existing `apps/api/src/review-run-runtime-snapshot.postgres.test.ts` real PG/HTTP scenario after joining, with no mirrored test suite:

1. Through registered HTTP plus the existing actual App auth request boundary, prove exact DTO, approved repository/head, one-repository read permissions and actual >30s issuer expiry; short expiry/extra permission/upstream error must withhold capability and sanitize bodies.
2. Hold the issuer HTTP request, commit revoke/expiry/epoch advance/safety pause/original-use fence from another PG connection, then release it; every case must return no token. Also hold SCM and change approved head/selection/archive/installation/identity; deny before returning capability. Hold final confirmation on its installation SHARE after the binding read, revoke the original use from another connection, then release the lock; protected rereads must deny without relying on the earlier live observation.
3. Verify pinned settings changes cannot replace original authority; revoked original remains denied even when another binding is live. Null attachment permits initial checkout; incompatible saved attachment denies.
4. At raw HTTP, reject nonempty/malformed/duplicate bodies, oversized body/headers, duplicate bearer, missing/wrong token and expired/old renewed token; caller selectors cannot choose a different repository/head/account. Errors/no-store must expose no upstream material.
5. Hold one dependency at configured cap, disconnect or expire its timer, and prove overflow still returns 503 before further token/SCM/issuer work; release it and prove capacity returns. No response token after cancellation; no detached mint. Disabled opt-in must leave route absent.
6. Preserve existing relay delayed-SCM/epoch/recovery/status/stream/close assertions; do not duplicate the same security invariant in unit/source/mock tests.

Runtime scenario, meaningful types, independent exact-source review and full provider/CLI/App E2E: NOT_RUN in this producer.
Full D-min/D-final/S/E/F/G remain mandatory and unqualified, including actual keyless CI tools/final parsing/exact-head App publication, fork/event fixtures,
provider-specific runs, measured bounds/retention/cleanup/long OIDC, operator grants and legacy retirement/release gates. H sharing remains deferred.
This finite backend source patch does not claim product E2E, paid-provider acceptance, deployment or release. Primary applies, validates and creates the commit.
