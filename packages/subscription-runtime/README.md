# Subscription Runtime

Reusable runtime primitives for user-owned subscription/session credentials.

The package family is intentionally split by responsibility:

- `core` owns domain types, ports, runtime policy, adapter manifests, registry
  checks, redaction, and orchestration.
- `provider-codex` owns Codex auth JSON validation, refresh, task execution, and
  Codex failure classification. Its recommended task engine is a single
  packaged Codex JSON engine; production code must not depend on a stale global
  `codex` binary.
- Future providers such as Claude should plug in through the same core ports:
  `ProviderSessionDriver`, `AgentDriver`, `SessionStorePort`, and
  `RunnerPort`. Provider-specific refresh logic must stay inside each provider
  adapter.
- Core policy must use adapter-declared refresh, rotation, task, and history
  modes. Do not special-case Codex in core, and do not force Claude/API-key/local
  agents through Codex-style refresh/writeback.
- Capability negotiation should compile one runtime plan before any session bytes
  are read: `no-session`, `static-session`, or `rotating-session`.
- Provider runners must use adapter-owned environment policies. Do not inherit
  host env blindly; API-key variables can override subscription credentials for
  some CLIs.
- `store-github-actions-secret` owns no-custody GitHub Actions secret read and
  encrypted writeback request preparation.
- `store-local-file` owns local-only encrypted file persistence for development
  and adapter contract tests.
- `runner-github-action` owns explicit process execution for GitHub-hosted
  Action jobs.

ReviewRouter remains the host app. It owns repository policy, OIDC validation,
workflow shape, PR comments, inline findings, and control-plane endpoints.

The existing Codex refresh/writeback implementation is the baseline, not
throwaway code. For Codex OAuth on GitHub-hosted Actions, durable refresh
writeback is required because each job starts with the GitHub Secret value from
job start. Future providers can use lighter plans only when their adapter
declares and tests non-rotating or no-session behavior.

Current extraction rule: keep the existing packages in production and migrate
with a strangler path. `core`, `provider-codex`, `runner-github-action`,
`store-github-actions-secret`, and `store-local-file` are the baseline package
family. ReviewRouter feature code remains the host-app wrapper for OIDC,
workflow shape, PR comments, inline findings, and SaaS endpoints. New execution
engines, including SDK/JSON workers, should be added beside the current Codex
refresh driver first; delete compatibility code only after live public/private
E2E, stale-generation tests, redaction canaries, and rollback have passed.

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

## Local File Backend Mode

For a first backend-owned deployment without database migrations, use the local
file adapters with a persistent volume. This mode is clean-architecture friendly:
the host app wires ordinary `SessionStorePort` and `LeaseStorePort`
implementations, while core and providers stay unaware of the filesystem.

```ts
import { createSubscriptionRuntime } from "@reviewrouter/subscription-runtime-core";
import {
  CodexCliSessionDriver,
  CodexJsonAgentDriver,
} from "@reviewrouter/subscription-runtime-provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@reviewrouter/subscription-runtime-store-local-file";

const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
  providerId: "codex",
  rootDir: "/var/lib/subscription-runtime",
  // 32-byte base64/base64url key from the host secret manager.
  encryptionKey: process.env.SUBSCRIPTION_RUNTIME_FILE_KEY!,
  metadata: { service: "openai-service" },
});

const runtime = createSubscriptionRuntime({
  policy: {
    custodyMode: "local-only",
    requireNoBackendPlaintext: false,
    requireWritebackBeforeTask: true,
    requireCompareAndSwap: true,
    allowInteractiveSetupInRuntime: false,
    allowedProviderIds: ["codex"],
    allowedAgentIds: ["codex-json"],
    allowedStoreIds: [sessionStore.storeId],
    allowedRunnerIds: [runner.runnerId],
  },
  sessionDriver: new CodexCliSessionDriver({ codexBinaryPath }),
  agentDriver: new CodexJsonAgentDriver({ codexBinaryPath }),
  sessionStore,
  leaseStore,
  runner,
  workspace,
  redactor,
  observability,
  clock,
  idGenerator,
});
```

Operational constraints:

- Mount `rootDir` on durable storage. Container-local ephemeral storage will lose
  sessions on restart.
- The file store encrypts session bytes at rest with AES-256-GCM, but the
  backend process can decrypt them. This is `local-only`, not
  `no-plaintext-backend`.
- `LocalFileLeaseStore` is intended for one host or a reliable shared POSIX
  volume. Multiple app replicas on independent disks need a future Postgres or
  Redis lease/store adapter.
- Lease files contain only run, generation, TTL, and writeback metadata. They
  must never contain provider token plaintext.
- Keep queue concurrency bounded to the number of warmed execution slots for a
  provider account.

See [`../../spikes/subscription-runtime-file-backend-worker`](../../spikes/subscription-runtime-file-backend-worker)
for a host-neutral worker skeleton that can be wrapped by any queue framework.

## Minimal Composition Shape

```ts
import {
  createSubscriptionRuntime,
  defineSubscriptionRuntimeConfig,
} from "@reviewrouter/subscription-runtime-core";
import {
  CodexCliSessionDriver,
  CodexJsonAgentDriver,
} from "@reviewrouter/subscription-runtime-provider-codex";
import { GitHubActionsSecretStore } from "@reviewrouter/subscription-runtime-store-github-actions-secret";
import { GitHubActionRunner } from "@reviewrouter/subscription-runtime-runner-github-action";

declare function resolvePinnedCodexBinary(): string;

const config = defineSubscriptionRuntimeConfig({
  custodyMode: "no-plaintext-backend",
  provider: "provider.codex-cli",
  store: "store.github-actions-secret",
  runner: "runner.github-action",
});

void config;

const codexSessionDriver = new CodexCliSessionDriver({
  // Pass a pinned packaged Codex binary from the composition root; avoid
  // resolving a stale global `codex` from PATH in production.
  codexBinaryPath: resolvePinnedCodexBinary(),
});
const codexAgentDriver = new CodexJsonAgentDriver({
  codexBinaryPath: resolvePinnedCodexBinary(),
});

const runtime = createSubscriptionRuntime({
  policy,
  sessionDriver: codexSessionDriver,
  agentDriver: codexAgentDriver,
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

## Backend Worker Cache

Backend services that own custody or local encrypted storage can avoid creating
a fresh `CODEX_HOME` for every task. Create one worker-cache materializer per
provider account and worker slot, prewarm it at worker startup, and keep queue
concurrency at `1` for that slot. Scale parallelism by creating more slots.

```ts
import {
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionMaterializer,
} from "@reviewrouter/subscription-runtime-provider-codex";

const slot = 0;
const materializer = new CodexWorkerCacheSessionMaterializer({
  cacheKey: `codex:${providerAccountId}:slot:${slot}`,
  rootDir: "/var/tmp/subscription-runtime/codex",
});

const agentDriver = new CodexJsonAgentDriver({
  codexBinaryPath: resolvePinnedCodexBinary(),
  sessionMaterializer: materializer,
  model: "gpt-5.5",
  reasoningEffort: "low",
});

await agentDriver.prewarmSession({
  session: await sessionStore.readLatest(providerAccountId),
  redactor,
  workspacePath: "/var/tmp/subscription-runtime/warmup-workspace",
  runner,
});

// Bind this driver into the host queue processor. Do not share one warmed slot
// across concurrent jobs; create slot:1, slot:2, ... for parallelism.
```

## Backend App-Server Pool

For backend workloads where the process can keep local custody of a Codex
session, prefer a bounded app-server slot pool. Each slot owns one reusable
`CODEX_HOME` and one long-lived `codex app-server` process. Keep one active turn
per slot and scale parallelism by increasing the slot count.

`codex exec` remains the production fallback because app-server is an
experimental Codex protocol. The queue and host app depend only on
`CodexJsonAgentDriver`; replacing app-server with `exec`, SDK, or another
provider-specific engine stays a composition-root change.

```ts
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
} from "@reviewrouter/subscription-runtime-provider-codex";

const codexBinaryPath = resolvePinnedCodexBinary();

const fallback = new PackagedCodexJsonExecutionEngine({
  codexBinaryPath,
});

const agentDriver = new CodexJsonAgentDriver({
  engine: new CodexAppServerExecutionEngine({
    codexBinaryPath,
    fallback,
    executionProfile: "stateless-completion",
    cleanThreadPrewarm: true,
  }),
  sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
    cacheKey: `codex:${providerAccountId}`,
    slots: 4,
    rootDir: "/var/tmp/subscription-runtime/codex",
  }),
  model: "gpt-5.5",
  reasoningEffort: "low",
  warmupPrompt: "Return exactly OK.",
});

await agentDriver.prewarmSession({
  session: await sessionStore.readLatest(providerAccountId),
  redactor,
  workspacePath: "/var/tmp/subscription-runtime/warmup-workspace",
  runner,
});
```

With `workspacePath` and `runner`, `prewarmSession` starts the reusable
`codex app-server` for the materialized session. With `warmupPrompt`, it also
runs a cheap hidden turn to warm the model path before the first user job. The
host queue should set concurrency to the same value as the number of warmed
worker slots for that provider account. If app-server fails for a job, the
engine restarts that slot and falls back to `codex exec` for the same
materialized session.

This is the intended integration shape for services such as `openai-service`:
the service keeps its existing Nest/Bull/queue stack, while the subscription
runtime provides the warmed Codex session and execution driver. The cache is not
durable storage; session persistence and refresh policy still belong to the
selected `SessionStorePort` and provider session driver.

## Production Worker Package API

The spike worker has been promoted into package APIs:

- `@reviewrouter/subscription-runtime-worker-core` - provider-neutral worker
  lifecycle and bounded slot pool.
- `@reviewrouter/subscription-runtime-worker-codex` - file-backend Codex worker
  using local encrypted storage, local file leases, lazy refresh, app-server,
  and `codex exec` fallback.
- `@reviewrouter/subscription-runtime-queue-core` - host-neutral queue port,
  retry/backoff/idempotency, in-memory contract implementation, and queue
  processor.
- `@reviewrouter/subscription-runtime-queue-bull` - Bull/BullMQ-compatible
  adapter that does not import Bull. The host app provides its queue instance.

```ts
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import { FileBackendCodexWorker } from "@reviewrouter/subscription-runtime-worker-codex";

const pool = new BoundedSubscriptionWorkerPool({
  poolId: "codex-ratings",
  slots: 4,
  prewarmOnStart: true,
  workerFactory: ({ workerId }) =>
    new FileBackendCodexWorker({
      workerId,
      providerInstanceId: "codex:ratings",
      stateRootDir: "/var/lib/subscription-runtime",
      // Pin a recent Codex binary. Do not rely on a stale global PATH install.
      codexBinaryPath: "/opt/reviewrouter/codex-0.135.0/codex",
      encryptionKey: fileKey32Bytes,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      executionProfile: "stateless-completion",
      cleanThreadPrewarm: true,
      warmupPrompt: "Return exactly OK.",
      sessionCacheSlots: 1,
      refreshFreshnessMs: 15 * 60_000,
      maxSessionAgeMs: 24 * 60 * 60_000,
    }),
});

await pool.start();

const result = await pool.run({
  runId: "match-rating-123",
  prompt: "Calculate this player rating and return JSON only.",
  outputSchemaName: "rating-v1",
});
```

The Codex adapters write a minimal backend `CODEX_HOME` by default:
subscription auth is file-backed, web search and response storage are disabled,
shell snapshot is disabled, and optional UI/app/memory features are disabled.
Keep those defaults for background workers; enabling interactive Codex features
adds startup and prompt overhead.

For API-like batch workloads such as match rating, use
`executionProfile: "stateless-completion"`. It sends minimal app-server
`baseInstructions`, disables tools, keeps history off, and treats every job as
a clean prompt-response operation.

When `executionProfile` is omitted, direct app-server and file-backend workers
use the compatible `subscription-worker` profile so repository-aware jobs are
not accidentally told to avoid file inspection. Future chat/dialog workloads
should add a separate session mode based on
`thread/resume` or `thread/fork`; do not use that path for independent match
scoring jobs.

For an existing Bull/BullMQ deployment, keep the queue in the host service and
only map jobs into the worker pool:

```ts
import { createBullSubscriptionProcessor } from "@reviewrouter/subscription-runtime-queue-bull";

const processor = createBullSubscriptionProcessor({
  workerPool: pool,
});

// new Worker("subscription-runtime", processor, { connection, concurrency: 4 })
```

If you enqueue through `BullSubscriptionTaskQueue`, also process through
`createBullSubscriptionProcessor`. The queue adapter stores subscription
runtime metadata inside the Bull payload when an explicit `idempotencyKey` is
present, and the processor unwraps it before calling the worker pool. This
keeps `taskId` available as Bull's `jobId` while preserving the real worker
idempotency key.

Core does not know about Nest, Bull, Prisma, or app-specific schemas. That keeps
the library reusable for Codex today and Claude or another subscription agent
later.

## Temporary Public GitHub Main Install

For early backend integrations where registry auth is not worth the friction,
publish generated public mirrors from this monorepo and install them directly
from GitHub `main`.

Run a dry run first:

```bash
pnpm subscription-runtime:sync-public-mirrors
```

Create or update public mirror repositories:

```bash
pnpm subscription-runtime:sync-public-mirrors -- --push
```

The sync script builds each package, copies only the package source/dist into a
generated repository, rewrites `workspace:*` dependencies to public GitHub
dependencies, and force-pushes the mirror `main` branch. Do not edit mirror
repositories directly.

Backend services can then install the packages without GitHub Packages or npm
registry auth:

```json
{
  "dependencies": {
    "@reviewrouter/subscription-runtime-worker-codex": "git+https://github.com/777genius/subscription-runtime-worker-codex.git#main",
    "@reviewrouter/subscription-runtime-queue-bull": "git+https://github.com/777genius/subscription-runtime-queue-bull.git#main"
  }
}
```

This is intentionally a convenience path, not the final release process. It
tracks `main`, so every install can pick up new code. For stable production
rollouts, pin a commit SHA or move to versioned packages.

Backend mode uses lazy refresh. A fresh session runs immediately. A stale or
nearly expired session refreshes before the task. If the first task fails with
an auth-shaped failure, the runtime performs one guarded refresh and retries
once, then returns the real provider failure.

Load benchmarking lives in
[`../../spikes/subscription-runtime-worker-benchmark`](../../spikes/subscription-runtime-worker-benchmark).
Run `pnpm subscription-runtime:worker-benchmark` with a local Codex `auth.json`
and file key before claiming a slot count as production capacity.

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
