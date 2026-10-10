# PR503 gateway confirmation repair

Saved guarded patch for supplied source `f7ce25fbf46e1de13ef8f88c9d17a4744400e3f7`; qualification pending. Sole normative authority: frozen `.spike-inputs/contract53.md`, independently hashed here as `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`. Read the frozen original P86 review and CI37304764316 failure list (47 existing failures in the two recovery suites).

Only `actions.ts`, the two owned recovery suites, and this handoff changed. P85/P87 selectors and P88 service fixture retain their ownership. No SDK/platform/retirement/sharing changes. No commit, push, deployment, release, credential/session/auth JSON access, real-project probe, or paid call.

## Source repairs

1. Gateway confirmation skips legacy `activateConfirmedCodexNamespaceAfterWorkflowMerge` and `repository_secret` source switching. Existing setup/attempt/artifact checks, hosted binding checks, and final provisioning CAS remain. Hosted and client-triggered legacy activation paths retain their existing behavior.
2. Gateway confirmation now enters the existing GitHub identity/default-branch, immutable commit/path/blob wrapper. It uses the existing keyless semantic readiness adapter, bypassing OAuth metadata/trusted-rotating-ref selection and namespace resolution. After readiness, fresh identity/head/pinned-blob reads use that same wrapper before the final setup fence/CAS. No duplicate verifier or production test hook was added.

Production diff: 47 added / 27 removed lines, including indentation of the existing metadata block; 20 net added lines. Gateway always checks its canonical caller path.

## Recovery fixture diagnosis and observations

The old mocked resolved configurations supplied only `providers`. New saved-configuration selection calls `isAccountGatewayConfiguration`, which first reads `config.provider.authMode`. Those partial mocks therefore throw before the existing recovery assertions; production's real saved-config resolver returns a complete parsed configuration. Repair the fixture dependency, not the assertions: both suites now parse complete configurations using the existing safe defaults. Generic rows use current `openrouter_api_key` and an explicit model rather than the obsolete `api_key`/missing-model input. All existing recovery/race/source/activation assertions remain; none were removed or weakened. This diagnosis is source-traced, not a local behavioral rerun.

Six added action-boundary observations reuse the existing recovery fixture, production saved-config Prisma adapter/resolver, real readiness adapter, decoded caller bytes, inspector, and final status authority:

- Exact keyless caller: catches any invocation of legacy activation, namespace resolution, source switch, or configuration/binding mutation despite successful confirmation.
- Existing rotating provider row: catches diversion into OAuth/namespace verification from stale provider state.
- Active hosted binding: catches diversion into hosted verification or repository-secret switching; binding/configuration remain unchanged.
- Head moved while readiness is deferred: catches acceptance of a superseded default-branch commit.
- Caller removed while readiness is deferred: catches acceptance without a fresh pinned workflow read.
- Caller blob replaced while readiness is deferred: catches acceptance of different bytes after the semantic probe.

The deferred barrier runs the real semantic probe successfully before changing transport state. It permits both branch and commit reads as GitHub does, so the old source can reach the defective post-probe boundary. Failed source cases require unchanged setup state, zero configured writes, and zero audit publication. Saved gateway selection is repository-scoped, `binding-account-v`, `gpt-6.1-sol` / `high` / `default`, `fastMode: false`; these settings are not emitted into the caller.

## Qualification limits and primary commands

Web meaningful typechecking, both recovery suites, previous three nearest suites, and ESLint: **NOT_RUN**. Each requested command was attempted once and exited 127 before launching its checker: the pnpm wrapper's configured corepack binary is missing. `node_modules` is absent. No installation loop or syntax-only PASS. Old-RED → fixed-GREEN was not executed; historical P86 125-pass/TS5.9 evidence does not qualify this patch.

The primary cache must use pinned SaaS TypeScript **6.0.3** and Vitest **4.1.10**:

```sh
pnpm --filter @reviewrouter/web typecheck
pnpm exec vitest run apps/web/app/dashboard/actions-hosted-workflow-recovery.test.ts apps/web/app/dashboard/actions-workflow-provisioning-recovery.test.ts
pnpm exec vitest run packages/features/workflow-provisioning/src/tests/workflow-template.test.ts packages/features/workflow-provisioning/src/tests/provision-reviewrouter-workflow.test.ts apps/web/src/server/workflow-setup-readiness.test.ts
pnpm exec eslint apps/web/app/dashboard/actions.ts apps/web/app/dashboard/actions-hosted-workflow-recovery.test.ts apps/web/app/dashboard/actions-workflow-provisioning-recovery.test.ts
```

Also compare the patch against exact f7ce25 before integration, inspect the diff/whitespace, and run the primary's installed guard. Prefer old source with the same repaired fixtures/new observations in an isolated checkout to establish RED, then fixed source for GREEN. The previous three suites' historical total was 125; no current total is claimed.

Read-only Git/lock probe: `.git` references unavailable `p80-server-source/.git/worktrees/p89-caller-repair`. HEAD, index.lock, and HEAD.lock return ENOENT; this cannot establish either HEAD identity or an unlocked live repository. No lock/history was changed. PR503's draft/remote state was not independently queried.

Patch/preimage artifacts: `/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-p89-caller-repair/tmp/agent/p89-caller-repair-artifacts/`. `minimal-production.patch` was saved before test repairs; `final.patch` contains the four owned paths. Preimages are local snapshot aids (actions preimage mechanically reconstructed from the first repair), not Git-authenticated source receipts. The controller owns apply/commit/push.

## Remaining mandatory qualification

D-min, D-final, S, E, F, and G remain mandatory and unqualified by this caller repair; H is deferred. D-min needs paired immutable Action/service integration, actual Codex tools/final review, and exact-approved-head App publication in a disposable fixture. D-final needs the full UI batch, measured/enforced numeric limits, cleanup, and long OIDC. S needs operator-pool grant/deny/revoke and account-global capacity evidence. E and F need actual OpenRouter and protected Codex OAuth profile tools/final/publication, with F custody/refresh qualification. G requires D+E+F and exact release gates. No real E2E, App publication, provider, rollout, or release acceptance is claimed here.
