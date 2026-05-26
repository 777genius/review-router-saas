# Subscription Runtime

Reusable runtime primitives for user-owned subscription/session credentials.

The package family is intentionally split by responsibility:

- `core` owns domain types, ports, runtime policy, adapter manifests, registry
  checks, redaction, and orchestration.
- `provider-codex` owns Codex auth JSON validation, refresh, task execution, and
  Codex failure classification.
- `store-github-actions-secret` owns no-custody GitHub Actions secret read and
  encrypted writeback request preparation.
- `store-local-file` owns local-only encrypted file persistence for development
  and adapter contract tests.
- `runner-github-action` owns explicit process execution for GitHub-hosted
  Action jobs.

ReviewRouter remains the host app. It owns repository policy, OIDC validation,
workflow shape, PR comments, inline findings, and control-plane endpoints.

## Custody Modes

`no-plaintext-backend` is the default production mode. The runner can read the
session because GitHub Actions injected it as a secret. The backend coordinates
leases and writeback, but receives only encrypted secret payloads plus metadata.
Use this for ReviewRouter Codex OAuth rotating.

`backend-custody` means the backend can decrypt or directly read user session
bytes. This is intentionally not the default and must require explicit adapter
configuration, audit logging, and product-level consent.

`local-only` means the session never leaves the developer's machine or a local
daemon. The local file adapter encrypts session bytes at rest with a caller-owned
32-byte key, but the local process can decrypt them, so do not use it with a
`requireNoBackendPlaintext` production policy. This is useful for development
tools and adapter certification, not as a CI/CD replacement unless the host app
owns a reliable runner lifecycle.

Runtime config must never contain `auth.json`, refresh tokens, access tokens, or
raw session bytes. Use `defineSubscriptionRuntimeConfig` to fail fast if a host
app accidentally embeds session material in config.

## Minimal Composition Shape

```ts
import {
  createSubscriptionRuntime,
  defineSubscriptionRuntimeConfig,
} from "@reviewrouter/subscription-runtime-core";
import { CodexCliProviderDriver } from "@reviewrouter/subscription-runtime-provider-codex";
import { GitHubActionsSecretStore } from "@reviewrouter/subscription-runtime-store-github-actions-secret";
import { GitHubActionRunner } from "@reviewrouter/subscription-runtime-runner-github-action";

const config = defineSubscriptionRuntimeConfig({
  custodyMode: "no-plaintext-backend",
  provider: "provider.codex-cli",
  store: "store.github-actions-secret",
  runner: "runner.github-action",
});

void config;

const provider = new CodexCliProviderDriver({ codexBinaryPath: "codex" });

const runtime = createSubscriptionRuntime({
  policy,
  sessionDriver: provider,
  agentDriver: provider,
  sessionStore: new GitHubActionsSecretStore(storeOptions),
  leaseStore,
  runner: new GitHubActionRunner(),
  workspace,
  redactor,
  observability,
  clock,
  idGenerator,
});

await runtime.refreshThenRunTask({
  providerInstanceId,
  task,
  runContext,
});
```

Adapters publish manifests so host apps can validate compatibility before any
session bytes are read. That is required for future providers like Claude,
Gemini, or local agents without editing core runtime code.

Adapter certification rules live in
[`ADAPTER_CERTIFICATION.md`](./ADAPTER_CERTIFICATION.md). Treat that file as the
release checklist for adding or promoting adapters.

## Local Gates

Use these before wiring a host app to a new adapter:

- `pnpm subscription-runtime:contract`
- `pnpm subscription-runtime:redaction-canary`
- `pnpm subscription-runtime:e2e:local`
- `pnpm subscription-runtime:check`
- `pnpm subscription-runtime:live-e2e:prereq`

`subscription-runtime:e2e:local` intentionally models GitHub Actions
no-custody behavior where a refreshed secret is written back durably, but the
current job cannot reread the updated GitHub Secret from its environment.
`refreshThenRunTask` must therefore run the task with the freshly refreshed
artifact after writeback succeeds.

## Live GitHub-Hosted Gate

`pnpm subscription-runtime:live-e2e:prereq` is a non-mutating readiness check
for the ReviewRouter Codex adapter. It verifies the local tools, GitHub CLI
auth, production feature flag, public HTTPS API URL, pinned full-SHA action ref,
fetchable action artifacts, disposable target repository names, and repeatable
Codex auth input.

The mutating live E2E is deliberately opt-in:

```bash
REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1 \
REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX=public,private \
REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE=/path/to/dedicated/codex/auth.json \
REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF=777genius/review-router@<40-char-sha> \
REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL=https://reviewrouter.site \
pnpm subscription-runtime:live-e2e
```

The wrapper uses disposable repository names by default and refuses non-test
repositories unless `REVIEW_ROUTER_LIVE_E2E_ALLOW_NON_DISPOSABLE=1` is set for
an intentional canary. Default review mode is `finding`, so the live run proves
session refresh/writeback and the existing ReviewRouter inline-comment format.
