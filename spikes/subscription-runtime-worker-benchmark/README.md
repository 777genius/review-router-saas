# Subscription Runtime Worker Benchmark

This spike measures the real Codex file-backend worker path:

- local encrypted file session store
- local file lease store
- lazy refresh policy
- Codex worker-cache materializer
- Codex app-server execution engine with `codex exec` fallback
- bounded worker pool slots

Run it only on a machine where Codex subscription auth is allowed:

```bash
SUBSCRIPTION_RUNTIME_CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json" \
SUBSCRIPTION_RUNTIME_FILE_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
SUBSCRIPTION_RUNTIME_BENCH_SLOTS=1,2,4,8 \
SUBSCRIPTION_RUNTIME_BENCH_TASKS=32 \
SUBSCRIPTION_RUNTIME_BENCH_REASONING=low \
pnpm exec tsx spikes/subscription-runtime-worker-benchmark/benchmark-codex-worker.ts
```

Expected output is a table with total latency, p50, p95, max latency, RSS/heap
delta, CPU user/system time, and restart-slot timing per slot count. By
default the script also runs a forced app-server failure probe and verifies that
the same worker can complete through the `codex exec` fallback.

Useful toggles:

- `SUBSCRIPTION_RUNTIME_BENCH_RESTART_SLOT=0` disables the restart-slot probe.
- `SUBSCRIPTION_RUNTIME_BENCH_FALLBACK_PROBE=0` disables the fallback probe.
- `SUBSCRIPTION_RUNTIME_BENCH_TASKS=50` or `100` runs a soak batch for memory
  inspection.

Operational notes:

- Keep this benchmark disposable. It copies the provided `auth.json` into
  encrypted local file storage and removes the temp root at the end.
- One worker slot owns one app-server process and one reusable `CODEX_HOME`.
- If app-server fails, the Codex execution engine falls back to `codex exec`.
- If the benchmark shows rising RSS over repeated batches, stop rollout and
  inspect slot disposal/restart behavior before using 8+ slots in production.
