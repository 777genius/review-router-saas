# Codex app-server spike

This spike checks whether `codex app-server` is practical as a warmed Codex
execution adapter for `@subscription-runtime`.

Official context:

- OpenAI CLI reference documents `codex exec` as the stable non-interactive path
  and `codex app-server` as a local app server command:
  https://developers.openai.com/codex/cli/reference
- OpenAI feature maturity docs mark experimental features as unstable and subject
  to change:
  https://developers.openai.com/codex/feature-maturity

## Why test it

Current production-safe runtime uses `codex exec`. It is reliable, but it starts
a new Codex CLI process per task. `worker-cache` improves filesystem/session
setup by reusing per-worker `CODEX_HOME`, but it does not keep the Codex process
warm.

`app-server` can keep one Codex process alive and accept multiple JSONL RPC
requests. The expected win is reduced per-task process/bootstrap overhead. The
model latency still dominates long reasoning tasks, so this is not guaranteed to
be API-speed.

## How to run

Safe protocol smoke, no model turn:

```bash
node spikes/codex-app-server/benchmark-app-server.mjs \
  --mode app-server \
  --launcher pnpm-dlx \
  --iterations 0 \
  --timeout-ms 30000
```

One real app-server turn:

```bash
node spikes/codex-app-server/benchmark-app-server.mjs \
  --mode app-server \
  --launcher pnpm-dlx \
  --iterations 1 \
  --effort low \
  --prompt "Reply with exactly OK."
```

Compare with `codex exec`:

```bash
node spikes/codex-app-server/benchmark-app-server.mjs \
  --mode both \
  --launcher pnpm-dlx \
  --iterations 1 \
  --effort low \
  --prompt "Reply with exactly OK."
```

For a fair benchmark, prefer `--launcher global --codex-bin <path-to-pinned-codex>`
with the same Codex version for both engines. `pnpm-dlx` is useful for testing the
latest package, but it adds package runner overhead to every `exec` job.

## Architecture if promoted

Keep app-server behind the existing execution boundary. Do not let queue,
refresh, or domain code depend on the experimental protocol.

```ts
export interface ProviderExecutionEngine {
  readonly kind: string;
  run(input: ProviderExecutionInput): Promise<ProviderExecutionResult>;
  dispose?(): Promise<void>;
}

export class CodexAppServerExecutionEngine implements ProviderExecutionEngine {
  readonly kind = "codex-app-server";

  constructor(
    private readonly processFactory: AppServerProcessFactory,
    private readonly fallback: ProviderExecutionEngine,
    private readonly policy: AppServerPolicy,
  ) {}

  async run(input: ProviderExecutionInput): Promise<ProviderExecutionResult> {
    if (!this.policy.enabledFor(input)) {
      return this.fallback.run(input);
    }

    // acquire slot -> ensure process -> thread/start -> turn/start -> collect
    // deltas -> release slot. On protocol mismatch, crash loop, or unsupported
    // server request, fallback or fail according to policy.
  }
}
```

Recommended slot model:

```ts
type AppServerSlot = {
  readonly id: string;
  readonly accountScope: string;
  readonly materializer: CodexSessionMaterializer;
  readonly client: CodexAppServerClient;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
};
```

One slot owns one materialized `CODEX_HOME` and one app-server process. Treat one
app-server process as one active turn until benchmarks prove safe concurrency.
Parallelism is `N` slots, not concurrent turns in one daemon.

## Refresh integration

The refresh/session code already built for `@subscription-runtime` is still
needed. App-server does not remove it.

Required behavior:

- Pre-materialize a fresh enough session before starting or reusing a daemon.
- Use one refresh lock per provider account/session generation.
- If `auth.json` generation changes, restart the app-server process for that
  slot unless the protocol supports a verified safe account reload.
- If app-server sends `account/chatgptAuthTokens/refresh`, do not print or proxy
  plaintext tokens in generic logs. Bridge it through the same session-refresh
  port or fail closed and retry after external refresh.
- On 401/unauthorized, guarded refresh once, restart daemon once, retry once.
  Avoid infinite refresh loops.

## Options

1. Spike only, keep production on `codex exec`.
   🎯 9   🛡️ 9   🧠 3, ~300-700 LOC.
   Best for measuring real latency and protocol stability before committing.

2. App-server adapter with JSON CLI fallback.
   🎯 8   🛡️ 7   🧠 7, ~2.5k-4.5k LOC.
   Good next step if spike shows meaningful latency reduction. Production can
   turn it on by feature flag per repo/account and fall back on protocol failure.

3. Full daemon worker pool for backend workloads.
   🎯 7.5   🛡️ 8   🧠 8.5, ~5k-9k LOC.
   Needed for `openai-service` style high-throughput jobs: queue adapter, slot
   pool, backpressure, process recycling, metrics, health checks, and history
   routing.

## Edge cases to prove before production

- App-server protocol drift between Codex versions.
- Server requests from daemon to client, especially auth refresh.
- Process crash, stuck turn, and SIGTERM/SIGKILL cleanup.
- Memory growth across many turns.
- Session generation update while a daemon is idle or busy.
- Concurrent jobs for the same account.
- Clean one-shot jobs versus reused history threads.
- No secret leakage in stdout, stderr, JSONL errors, metrics, and thrown errors.
- Fallback behavior when app-server is unavailable or returns an unknown event.

## Current smoke result

On this machine with `@openai/codex@0.135.0` and a temporary `CODEX_HOME`
containing only `auth.json`:

- No-turn `initialize` smoke: startup ~1.2-2.3s, RSS ~210-220 MB.
- One real app-server turn: startup ~1.0s, job ~3.1s, RSS ~263 MB.
- App-server run with one warmup and three measured clean-thread jobs:
  p50 ~3.0s, p95 ~4.1s, max RSS ~312 MB.
- Same prompt through `codex exec` using the same `pnpm dlx` package launcher:
  p50 ~4.2s, p95 ~7.4s, max RSS ~350 MB.
- One app-server process with concurrent clean-thread jobs:
  - concurrency 2: 2/2 succeeded, wall ~6.2s, p50 ~5.7s, p95 ~6.2s.
  - concurrency 4: 4/4 succeeded, wall ~13.8s, p50 ~11.9s, p95 ~13.8s.
  - concurrency 8: 8/8 succeeded, wall ~12.5s, p50 ~12.0s, p95 ~12.5s.

These numbers are a small local sample, not a production benchmark. They are
enough to justify a deeper app-server adapter spike: the warmed app-server path
was materially faster for short tasks, while still being experimental and needing
fallback.

Concurrency conclusion: one app-server process can accept multiple simultaneous
clean-thread turns, but it does not scale like independent workers. Latency grows
quickly once several active turns share the same daemon. Treat this as useful for
controlled low concurrency only; production throughput should use a bounded pool
of app-server slots, with one active turn per slot until longer load tests prove
otherwise.
