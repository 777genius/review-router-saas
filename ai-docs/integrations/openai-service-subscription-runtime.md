# openai-service Subscription Runtime Integration

Status: ready for a separate implementation PR in `Padelapp-Club/openai-service`.

This document records the verified integration shape for using Codex subscription
workers from `openai-service` without replacing the existing OpenAI API path.
Do not wire this directly into `ChatService.sendMessage` first. Add a separate
Codex job API and keep the current synchronous OpenAI API endpoint stable.

## What Was Verified

Temporary clone:

```text
/tmp/openai-service-rr-hXDM66/openai-service
```

Verified dependency install:

```bash
npm install --save \
  @openai/codex@0.135.0 \
  git+https://github.com/777genius/subscription-runtime-worker-codex.git#main \
  git+https://github.com/777genius/subscription-runtime-queue-bull.git#main
```

Verified checks:

- `npm run build` passes.
- ESM import of `@reviewrouter/subscription-runtime-worker-codex` passes.
- ESM import of `@reviewrouter/subscription-runtime-queue-bull` passes.
- packaged Codex binary is available as `/app/node_modules/.bin/codex`.
- Docker image builds on the service's existing `node:20.18.0-alpine` base.
- Docker runtime can start a file-backed Codex worker as non-root user.
- Docker runtime can seed mounted `auth.json`.
- Docker runtime prewarm returns `ready`.
- A real Codex task completes through the Dockerized worker.
- Earlier quota exhaustion was classified as `quota_limited`, not as an unknown
  app-server or Docker failure.

Current successful Docker smoke output:

```json
{
  "status": "completed",
  "prewarmStatus": "ready",
  "durationMs": 2597,
  "outputText": "OK.",
  "warnings": []
}
```

That means the integration path is verified end-to-end inside the service's
Docker shape.

## Recommended API Shape

Use a hybrid job API:

`POST /chat/codex/jobs`

- creates a job in Bull
- returns quickly with `202` if not completed within `wait_ms`
- optionally waits up to `wait_ms` and returns `200` with the result if the
  worker finishes quickly

`GET /chat/codex/jobs/:job_id`

- returns queued, running, succeeded, failed, or expired
- returns safe provider errors such as `quota_limited`

Why this shape:

- Codex subscription workers are not API-latency primitives.
- Optimized local benchmarks are roughly 6-12 seconds for warm small tasks on
  this machine, but p95 can still be 20+ seconds under load.
- Queue wait time can dominate when there are more requests than warmed slots.
- A pure blocking endpoint will work in happy-path demos, but it creates brittle
  HTTP timeouts and bad mobile UX under real load.

Options:

1. Hybrid `enqueue + waitMs` - 🎯 9 🛡️ 8.5 🧠 6, around 800-1500 LOC in
   `openai-service`.
   Best default. Frontend can get fast responses when available, otherwise poll
   by job id. This also supports background match scoring.

2. Async-only jobs - 🎯 8.5 🛡️ 9 🧠 4, around 500-900 LOC.
   Simpler and most reliable. UX is less API-like because every request returns
   `202` first.

3. Sync-only blocking call - 🎯 6 🛡️ 5.5 🧠 3, around 300-600 LOC.
   Lowest code volume, but not recommended. A 10-30 second provider path should
   not be the only public contract.

Recommended first production contract:

```ts
export type CodexJobRequestDto = {
  user_id: number;
  prompt_id: number;
  message: string;
  wait_ms?: number;
  idempotency_key?: string;
  metadata?: Record<string, string>;
};

export type CodexJobAcceptedDto = {
  status: "queued" | "running";
  job_id: string;
  poll_url: string;
};

export type CodexJobCompletedDto = {
  status: "success";
  job_id: string;
  response: string;
  tokens_used: 0;
  provider: "codex-subscription";
  model: string;
  latency_ms: number;
};

export type CodexJobFailedDto = {
  status: "error";
  job_id: string;
  error_code:
    | "quota_limited"
    | "auth_required"
    | "task_timeout"
    | "worker_unavailable"
    | "provider_failed";
  message: string;
};
```

Suggested HTTP behavior:

```ts
const waitMs = Math.min(dto.wait_ms ?? 0, 15_000);
const job = await codexJobService.enqueue(dto);

if (waitMs <= 0) {
  return accepted(job);
}

const completed = await codexJobService.waitForResult(job.id, waitMs);
return completed ?? accepted(job);
```

## Where To Integrate

Current service shape:

- `src/modules/chat/chat.controller.ts` exposes `POST /chat/send`.
- `src/modules/chat/chat.service.ts` synchronously calls OpenAI API.
- `openai_requests_history.status` currently supports only `success` and
  `error`.
- Bull is already in dependencies, but no project-specific queue module is wired
  for this task yet.

Recommended placement:

```text
src/modules/subscription-runtime/
  subscription-runtime.module.ts
  codex-worker.provider.ts
  codex-job.service.ts
  codex-job.processor.ts
  dto/codex-job.request.ts
  dto/codex-job.response.ts
```

Then expose only a thin controller integration:

```text
src/modules/chat/chat-codex.controller.ts
```

Keep it separate from `ChatService.sendMessage` so API-key OpenAI remains a
known-good path and Codex subscription can be rolled out behind a feature flag.

## Nest Wiring Sketch

The host app owns Bull, Redis, auth, DTO validation, metrics, and persistence.
The subscription runtime owns Codex auth refresh, local encrypted file storage,
leases, worker slots, and execution.

```ts
import { Inject, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import { FileBackendCodexWorker } from "@reviewrouter/subscription-runtime-worker-codex";

@Module({
  providers: [
    {
      provide: "CODEX_WORKER_POOL",
      useFactory: () => {
        const key = decodeFileKey(process.env.SUBSCRIPTION_RUNTIME_FILE_KEY);

        return new BoundedSubscriptionWorkerPool({
          poolId: "openai-service-codex",
          slots: Number(process.env.CODEX_WORKER_SLOTS ?? 4),
          prewarmOnStart: true,
          maxQueueSize: Number(process.env.CODEX_WORKER_MAX_QUEUE ?? 256),
          workerFactory: ({ workerId }) =>
            new FileBackendCodexWorker({
              workerId,
              providerInstanceId:
                process.env.CODEX_PROVIDER_INSTANCE_ID ?? "codex:default",
              stateRootDir:
                process.env.SUBSCRIPTION_RUNTIME_STATE_ROOT ??
                "/var/lib/subscription-runtime",
              codexBinaryPath:
                process.env.CODEX_BINARY ?? "/app/node_modules/.bin/codex",
              encryptionKey: key,
              model: process.env.CODEX_MODEL ?? "gpt-5.5",
              reasoningEffort: "low",
              executionProfile: "stateless-completion",
              cleanThreadPrewarm: true,
              warmupPrompt: "Return exactly OK.",
              sessionCacheSlots: 1,
              taskTimeoutMs: 180_000,
            }),
        });
      },
    },
  ],
  exports: ["CODEX_WORKER_POOL"],
})
export class SubscriptionRuntimeModule
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject("CODEX_WORKER_POOL")
    private readonly pool: BoundedSubscriptionWorkerPool<unknown, unknown>,
  ) {}

  async onModuleInit() {
    await this.pool.start();
  }

  async onModuleDestroy() {
    await this.pool.dispose();
  }
}
```

Bull processor sketch:

```ts
import { Process, Processor } from "@nestjs/bull";
import { Inject } from "@nestjs/common";
import { Job } from "bull";
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";

@Processor("codex-subscription")
export class CodexJobProcessor {
  constructor(
    @Inject("CODEX_WORKER_POOL")
    private readonly pool: BoundedSubscriptionWorkerPool<
      { runId: string; prompt: string; metadata?: Record<string, string> },
      { outputText: string }
    >,
  ) {}

  @Process({ name: "complete", concurrency: 4 })
  async process(job: Job<CodexJobPayload>) {
    return this.pool.run(
      {
        runId: job.id.toString(),
        prompt: job.data.prompt,
        metadata: job.data.metadata,
      },
      { idempotencyKey: job.id.toString() },
    );
  }
}
```

For the first PR, set Bull concurrency equal to worker slots. Do not set Bull
concurrency higher than the warmed pool unless queue latency and memory are
measured under load.

## Docker Changes Needed

The service already uses `node:20.18.0-alpine`. GitHub git dependencies require
`git` in the builder stage.

```Dockerfile
RUN apk add --no-cache git openssh-client
```

The runtime container runs as `nestjs`, so the file backend needs a writable
persistent directory:

```Dockerfile
RUN mkdir -p /var/lib/subscription-runtime \
  && chown -R nestjs:nodejs /var/lib/subscription-runtime
```

Deployment must mount `/var/lib/subscription-runtime` as persistent storage. If
it is container-local ephemeral storage, Codex auth will be lost on restart.

## Required Env

```bash
SUBSCRIPTION_RUNTIME_FILE_KEY=<base64-or-base64url-32-byte-key>
SUBSCRIPTION_RUNTIME_STATE_ROOT=/var/lib/subscription-runtime
CODEX_BINARY=/app/node_modules/.bin/codex
CODEX_PROVIDER_INSTANCE_ID=codex:default
CODEX_MODEL=gpt-5.5
CODEX_WORKER_SLOTS=4
CODEX_WORKER_MAX_QUEUE=256
```

Generate a local file key:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Auth import should be an explicit admin operation. Do not put raw `auth.json` in
environment variables. Accept a file upload or local mounted file, then call:

```ts
await worker.seedCodexAuthJsonFile("/secure/import/auth.json");
```

After seed, the encrypted file store owns persistence. The plaintext import file
must be deleted.

## Storage And State

First production phase should use file mode:

- encrypted sessions under `/var/lib/subscription-runtime/sessions`
- local file leases under the same state root
- reusable `CODEX_HOME` cache under `/var/lib/subscription-runtime/codex-cache`
- stable worker workspaces under `/var/lib/subscription-runtime/workspaces`

This is valid for one service instance or one shared POSIX volume.

Do not run multiple replicas with separate disks against the same provider
account. That can create split-brain refresh and quota pressure. Multi-replica
requires a Postgres or Redis session and lease adapter later.

## History Persistence

Do not overload `openai_requests_history.status` for queued/running state in the
first PR, because it currently only supports `success` and `error`.

Two safe options:

1. Minimal first PR - keep Codex job status in Bull and write to
   `openai_requests_history` only on success/error.
2. Better later PR - add `subscription_runtime_jobs` with `queued`, `running`,
   `success`, `error`, `expired`, `provider`, `model`, `latency_ms`,
   `safe_error_code`, and `history_id`.

For the first integration, option 1 is enough if job results are short-lived and
the frontend polls soon after submit.

## Expected Latency

Latest local benchmark on this machine, `gpt-5.5`, `low`, stateless completion,
no `/fast`:

- 4 slots / 8 tasks, warm app-server path: p50 around 6.6s, p95/max around
  12.3s in the best rerun.
- 6 slots / 8 tasks: p50 around 6.7s, p95/max around 11.9s, higher resource
  cost and little benefit for this workload.

Recommended starting point:

- `CODEX_WORKER_SLOTS=4`
- Bull concurrency `4`
- `wait_ms` cap `15000`
- queue max `256`

For realtime UX, keep OpenAI API as the fast path. Use Codex subscription for
background or cost-sensitive work. For product flows that can wait, the hybrid
endpoint can feel API-like when the queue is empty.

## Failure Handling

Return safe codes only:

- `quota_limited` - show retry later or switch to API path
- `auth_required` - admin must reimport Codex auth
- `task_timeout` - prompt too slow or queue overloaded
- `worker_unavailable` - pool failed health check
- `provider_failed` - generic safe provider failure

Never return raw Codex stderr to users. The runtime redacts access tokens,
refresh tokens, and id tokens, but app-level error responses should still use
safe messages.

## Acceptance Before First PR Merge

- `npm run build` passes in `openai-service`.
- Docker build passes.
- Container smoke can import worker packages.
- Container smoke can run `codex --version`.
- Container smoke can start `FileBackendCodexWorker`.
- Container smoke `prewarmStatus` is `ready`.
- One real Codex task succeeds.
- Queue endpoint returns `202` when `wait_ms=0`.
- Queue endpoint returns `200` when a tiny warm task completes inside `wait_ms`.
- Queue endpoint returns safe `quota_limited` when provider quota is exhausted.
- No raw `auth.json`, `refresh_token`, `access_token`, or `id_token` appears in
  logs, DB rows, HTTP responses, or Bull job payloads.

## Final Recommendation

Build a separate `SubscriptionRuntimeModule` and `ChatCodexController`, backed
by Bull and `FileBackendCodexWorker`.

Use the hybrid endpoint first:

```text
POST /chat/codex/jobs?wait_ms=15000
GET /chat/codex/jobs/:job_id
```

Keep `/chat/send` on OpenAI API until Codex subscription latency, quota behavior,
and frontend polling are accepted in production.
