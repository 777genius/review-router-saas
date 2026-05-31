import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import { FileBackendCodexWorker } from "@reviewrouter/subscription-runtime-worker-codex";
import type { CodexAppServerProcessFactory } from "@reviewrouter/subscription-runtime-provider-codex";

type BenchmarkSample = {
  readonly slots: number;
  readonly taskCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly totalMs: number;
  readonly prewarmMs: number;
  readonly firstTaskMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly rssDeltaMb: number;
  readonly heapDeltaMb: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly restartSlotMs: number | null;
};

type FallbackSample = {
  readonly status: "ok" | "failed";
  readonly durationMs: number;
  readonly safeMessage?: string;
};

async function main(): Promise<void> {
  const config = readConfig();
  const authJson = await readFile(config.authJsonPath, "utf8");
  const samples: BenchmarkSample[] = [];

  for (const slots of config.slots) {
    samples.push(await runSlots({ ...config, slots, authJson }));
  }
  const fallback = config.runFallbackProbe
    ? await runFallbackProbe({ ...config, authJson })
    : null;

  console.table(
    samples.map((sample) => ({
      slots: sample.slots,
      tasks: sample.taskCount,
      ok: sample.successCount,
      failed: sample.failureCount,
      totalMs: Math.round(sample.totalMs),
      prewarmMs: Math.round(sample.prewarmMs),
      firstTaskMs: Math.round(sample.firstTaskMs),
      p50Ms: Math.round(sample.p50Ms),
      p95Ms: Math.round(sample.p95Ms),
      maxMs: Math.round(sample.maxMs),
      rssDeltaMb: sample.rssDeltaMb.toFixed(1),
      heapDeltaMb: sample.heapDeltaMb.toFixed(1),
      cpuUserMs: Math.round(sample.cpuUserMs),
      cpuSystemMs: Math.round(sample.cpuSystemMs),
      restartSlotMs:
        sample.restartSlotMs === null
          ? "n/a"
          : Math.round(sample.restartSlotMs),
    })),
  );
  if (fallback) {
    console.table([
      {
        probe: "forced app-server failure -> codex exec fallback",
        status: fallback.status,
        durationMs: Math.round(fallback.durationMs),
        safeMessage: fallback.safeMessage ?? "",
      },
    ]);
  }
}

async function runSlots(input: {
  readonly slots: number;
  readonly taskCount: number;
  readonly authJson: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly prompt: string;
  readonly executionProfile:
    | "stateless-completion"
    | "subscription-worker"
    | { readonly kind: "custom"; readonly baseInstructions?: string };
  readonly cleanThreadPrewarm: boolean;
  readonly restartSlotProbe: boolean;
}): Promise<BenchmarkSample> {
  const rootDir = await mkdtemp(join(tmpdir(), "rr-codex-worker-bench-"));
  const startedMemory = process.memoryUsage();
  const startedCpu = process.cpuUsage();
  const startedAt = performance.now();
  const durations: number[] = [];
  let successCount = 0;
  let failureCount = 0;
  let firstTaskMs = 0;
  let restartSlotMs: number | null = null;
  const workers: FileBackendCodexWorker[] = [];

  const pool = new BoundedSubscriptionWorkerPool({
    poolId: `codex-bench-${input.slots}`,
    slots: input.slots,
    prewarmOnStart: false,
    shutdownTimeoutMs: 120_000,
    workerFactory: ({ workerId }) =>
      createWorker({
        workers,
        workerId,
        providerInstanceId: `codex:bench:${input.slots}:${workerId}`,
        stateRootDir: rootDir,
        codexBinaryPath: input.codexBinaryPath,
        encryptionKey: input.encryptionKey,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        executionProfile: input.executionProfile,
        cleanThreadPrewarm: input.cleanThreadPrewarm,
        sessionCacheSlots: 1,
        taskTimeoutMs: 10 * 60_000,
        sourceEnv: process.env,
      }),
  });

  try {
    await pool.start();
    await Promise.all(
      Array.from({ length: input.slots }, async (_, index) => {
        await workers[index]?.seedCodexAuthJson(input.authJson);
      }),
    );
    const prewarmMs = await timed(async () => {
      await pool.prewarm();
    });
    if (input.restartSlotProbe && input.slots > 0) {
      restartSlotMs = await timed(async () => {
        await pool.restartSlot(0, { prewarm: true });
      });
    }

    const tasks = Array.from({ length: input.taskCount }, (_, index) =>
      timed(async () => {
        const result = await pool.run({
          runId: `bench-${input.slots}-${index + 1}`,
          prompt: `${input.prompt}\nTask index: ${index + 1}.`,
        });
        if (!result.outputText.trim()) {
          throw new Error("empty_output");
        }
      }).then((durationMs) => ({ index, durationMs })),
    );
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "fulfilled") {
        successCount += 1;
        durations.push(result.value.durationMs);
        if (result.value.index === 0) firstTaskMs = result.value.durationMs;
      } else {
        failureCount += 1;
      }
    }

    const endedMemory = process.memoryUsage();
    const endedCpu = process.cpuUsage(startedCpu);
    durations.sort((a, b) => a - b);
    return {
      slots: input.slots,
      taskCount: input.taskCount,
      successCount,
      failureCount,
      totalMs: performance.now() - startedAt,
      prewarmMs,
      firstTaskMs,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1) ?? 0,
      rssDeltaMb: bytesToMb(endedMemory.rss - startedMemory.rss),
      heapDeltaMb: bytesToMb(endedMemory.heapUsed - startedMemory.heapUsed),
      cpuUserMs: endedCpu.user / 1000,
      cpuSystemMs: endedCpu.system / 1000,
      restartSlotMs,
    };
  } finally {
    await pool.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function runFallbackProbe(input: {
  readonly authJson: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly prompt: string;
  readonly executionProfile:
    | "stateless-completion"
    | "subscription-worker"
    | { readonly kind: "custom"; readonly baseInstructions?: string };
  readonly cleanThreadPrewarm: boolean;
}): Promise<FallbackSample> {
  const rootDir = await mkdtemp(join(tmpdir(), "rr-codex-worker-fallback-"));
  const worker = createWorker({
    workers: [],
    workerId: "fallback-probe",
    providerInstanceId: "codex:bench:fallback-probe",
    stateRootDir: rootDir,
    codexBinaryPath: input.codexBinaryPath,
    encryptionKey: input.encryptionKey,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    executionProfile: input.executionProfile,
    cleanThreadPrewarm: input.cleanThreadPrewarm,
    sessionCacheSlots: 1,
    taskTimeoutMs: 10 * 60_000,
    sourceEnv: process.env,
    appServerProcessFactory: (() => {
      throw new Error("forced_app_server_failure");
    }) as CodexAppServerProcessFactory,
  });

  const startedAt = performance.now();
  try {
    await worker.start();
    await worker.seedCodexAuthJson(input.authJson);
    const result = await worker.run({
      runId: "fallback-probe",
      prompt: input.prompt,
    });
    if (!result.outputText.trim()) throw new Error("empty_output");
    return {
      status: "ok",
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: performance.now() - startedAt,
      safeMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await worker.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
}

function createWorker(
  input: ConstructorParameters<typeof FileBackendCodexWorker>[0] & {
    readonly workers: FileBackendCodexWorker[];
  },
): FileBackendCodexWorker {
  const { workers, ...options } = input;
  const worker = new FileBackendCodexWorker(options);
  workers.push(worker);
  return worker;
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await fn();
  return performance.now() - startedAt;
}

function readConfig(): {
  readonly authJsonPath: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array;
  readonly slots: readonly number[];
  readonly taskCount: number;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly prompt: string;
  readonly executionProfile:
    | "stateless-completion"
    | "subscription-worker"
    | { readonly kind: "custom"; readonly baseInstructions?: string };
  readonly cleanThreadPrewarm: boolean;
  readonly restartSlotProbe: boolean;
  readonly runFallbackProbe: boolean;
} {
  const authJsonPath = process.env.SUBSCRIPTION_RUNTIME_CODEX_AUTH_JSON_PATH;
  const key = process.env.SUBSCRIPTION_RUNTIME_FILE_KEY;
  if (!authJsonPath || !key) {
    throw new Error(
      [
        "Missing benchmark env.",
        "Set SUBSCRIPTION_RUNTIME_CODEX_AUTH_JSON_PATH=/path/to/auth.json",
        "and SUBSCRIPTION_RUNTIME_FILE_KEY=<base64url 32-byte key>.",
      ].join(" "),
    );
  }
  const promptKind =
    process.env.SUBSCRIPTION_RUNTIME_BENCH_PROMPT_KIND ?? "ok-smoke";
  return {
    authJsonPath,
    codexBinaryPath: process.env.CODEX_BINARY ?? "codex",
    encryptionKey: decodeKey(key),
    slots: (process.env.SUBSCRIPTION_RUNTIME_BENCH_SLOTS ?? "1,2,4,8")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
    taskCount: Number(process.env.SUBSCRIPTION_RUNTIME_BENCH_TASKS ?? "16"),
    model: process.env.SUBSCRIPTION_RUNTIME_BENCH_MODEL ?? "gpt-5.5",
    reasoningEffort:
      (process.env.SUBSCRIPTION_RUNTIME_BENCH_REASONING as
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | undefined) ?? "low",
    prompt:
      process.env.SUBSCRIPTION_RUNTIME_BENCH_PROMPT ??
      promptForKind(promptKind),
    executionProfile: readExecutionProfile(),
    cleanThreadPrewarm:
      process.env.SUBSCRIPTION_RUNTIME_BENCH_CLEAN_THREAD_PREWARM !== "0",
    restartSlotProbe:
      process.env.SUBSCRIPTION_RUNTIME_BENCH_RESTART_SLOT !== "0",
    runFallbackProbe:
      process.env.SUBSCRIPTION_RUNTIME_BENCH_FALLBACK_PROBE !== "0",
  };
}

function readExecutionProfile():
  | "stateless-completion"
  | "subscription-worker"
  | { readonly kind: "custom"; readonly baseInstructions?: string } {
  const profile =
    process.env.SUBSCRIPTION_RUNTIME_BENCH_PROFILE ?? "stateless-completion";
  if (profile === "subscription-worker") return "subscription-worker";
  if (profile === "stateless-completion") return "stateless-completion";
  if (profile === "custom") {
    const baseInstructions =
      process.env.SUBSCRIPTION_RUNTIME_BENCH_BASE_INSTRUCTIONS;
    return baseInstructions
      ? { kind: "custom", baseInstructions }
      : { kind: "custom" };
  }
  throw new Error(
    "SUBSCRIPTION_RUNTIME_BENCH_PROFILE must be stateless-completion, subscription-worker, or custom.",
  );
}

function promptForKind(kind: string): string {
  if (kind === "ok-smoke") {
    return "Return exactly one short sentence with the word OK.";
  }
  if (kind === "match-rating-json") {
    return [
      "Calculate a player rating delta for this padel match.",
      "Return JSON only with keys playerId, ratingDelta, confidence, reason.",
      'Input: {"playerId":"p1","playerRating":1520,"partnerRating":1480,"opponentRatings":[1510,1490],"score":"6-4 3-6 10-8","result":"win"}',
    ].join(" ");
  }
  throw new Error(
    "SUBSCRIPTION_RUNTIME_BENCH_PROMPT_KIND must be ok-smoke or match-rating-json.",
  );
}

function decodeKey(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32) {
    throw new Error("SUBSCRIPTION_RUNTIME_FILE_KEY must decode to 32 bytes.");
  }
  return new Uint8Array(decoded);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index] ?? 0;
}

function bytesToMb(value: number): number {
  return value / 1024 / 1024;
}

await main();
