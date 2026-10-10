# Account Gateway server runtime-config entry (bounded D-min component)

Supplied checkout: `82aac1a72a49dd195efede8f2add7fc703e246e6`.
Observed HEAD: UNVERIFIED; `.git` points to an unavailable linked-worktree git directory.
Exclusive `index.lock` create/release was attempted before writing; ENOENT. No retry/history change.
Sole authority: unchanged contract53 SHA256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` (verified).
Ownership: runtime-config use case, its nearest existing action-control-plane suite, this handoff only.

Saved `codex_account_gateway` now passes authenticated config for an approved normal bootstrap source.
Approval reuses `isManagedV2SessionBootstrapSource`: repository-specific `codexWorkflowPathForRepository`,
normally `.github/workflows/reviewrouter-codex.yml`, or managed `.github/workflows/reviewrouter-interaction.yml`
with their existing event/identity rules; the isolated quality identity remains subject to its existing guard.
Missing/wrong/legacy workflow and conflict runtime deny. Any gateway selection requires one total provider;
effective primary auth/model selection cannot hide gateway behind a static provider or mix credentials.
Strict saved-config validation is reused. Session verification/expiry, repository revalidation, entitlements,
conflict snapshot/version gates, compatibility checks and existing OIDC fork/event policy remain in place.
Inputs remain only sessionToken/actionVersion; caller auth/grant/account/model/checkout/env never grants authority.

Returned top-level fields: protocolVersion=1, configVersion, provider, providers, execution,
blockingPolicy.failOnSeverity, limits.inlineMaxComments/targetTokensPerBatch, runtimeEnv.
Each provider has kind/authMode/model/reasoningEffort/agenticContext/fastMode/requiredHealthy/
secretBackedProviderEnabled; the gateway flag is false. Binding/profile are carried only in runtimeEnv.
Gateway runtimeEnv includes REVIEW_AUTH_MODE=codex-account-gateway, REVIEW_ROUTER_GATEWAY_BINDING_ID,
REVIEW_ROUTER_GATEWAY_PROFILE_REF, CODEX_MODEL/REASONING_EFFORT/AGENTIC_CONTEXT/FAST_MODE,
REVIEW_PROVIDERS, REQUIRED_HEALTHY_PROVIDERS, SYNTHESIS_MODEL, provider counts, review limits/policy,
schema version and investigation flags; language/ultra timeout/derived ledger key remain conditional.
Observed baseline plan emits auth/model but validates without emitting binding/profile; this entry preserves
the saved nonsecret references in the extensible runtimeEnv record. No credential, origin or grant is returned.
References are selection metadata: subsequent admission must resolve live binding/account/model/limits and
retain its approved run snapshot; this config endpoint does not mint a capability or authorize execution.

Paired Action next wiring: runtime-preflight may emit nonsecret account_gateway_needed only after successful
authenticated config with effective REVIEW_AUTH_MODE=codex-account-gateway. Execute public dist/index.js
with REVIEW_ROUTER_MODE=account-gateway in the keyless T0 step; inject no provider secrets and allow no
static fallback. Retain server run/attempt/head admission and approved checkout inputs; no client selectors.
App-first client-triggered schema-v2 T0 remains required, with immutable reviewrouter-t0-reusable.yml,
repository-scoped provider_instance_id and id-token: write. Action code/workflows are outside this patch.

New nearest tests cover a real signed/verified session, saved config and schema-parsed nonsecret result,
wrong/missing/legacy paths and gateway hidden behind a static primary. Existing legacy/conflict tests retained.
Old code rejects the approved gateway case with codex_provider_requires_rotating_workflow and drops references.
Typecheck and full nearest suite: NOT_RUN; both pnpm commands exit127 because corepack is missing;
node_modules/compiler/Vitest are absent. Node24.21.0 syntax checks pass; they are not typechecking/behavior proof.
Primary must verify supplied source and per-file patch guards, qualify pinned dependencies, run
`pnpm --filter @reviewrouter/features-action-control-plane typecheck` and
`pnpm exec vitest run packages/features/action-control-plane/src/tests/action-control-plane.test.ts`.
Full D-min/D-final/S/E/F/G remain required; H sharing deferred. No release/deploy/provider call/credential read.
