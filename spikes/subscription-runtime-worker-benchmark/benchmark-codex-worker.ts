import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import { FileBackendCodexWorker } from "@reviewrouter/subscription-runtime-worker-codex";

type BenchmarkSample = {
  readonly slots: number;
  readonly taskCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly totalMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly rssDeltaMb: number;
  readonly heapDeltaMb: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
};

async function main(): Promise<void> {
  const config = readConfig();
  const authJson = await readFile(config.authJsonPath, "utf8");
  const samples: BenchmarkSample[] = [];

  for (const slots of config.slots) {
    samples.push(await runSlots({ ...config, slots, authJson }));
  }

  console.table(
    samples.map((sample) => ({
      slots: sample.slots,
      tasks: sample.taskCount,
      ok: sample.successCount,
      failed: sample.failureCount,
      totalMs: Math.round(sample.totalMs),
      p50Ms: Math.round(sample.p50Ms),
      p95Ms: Math.round(sample.p95Ms),
      maxMs: Math.round(sample.maxMs),
      rssDeltaMb: sample.rssDeltaMb.toFixed(1),
      heapDeltaMb: sample.heapDeltaMb.toFixed(1),
      cpuUserMs: Math.round(sample.cpuUserMs),
      cpuSystemMs: Math.round(sample.cpuSystemMs),
    })),
  );
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
}): Promise<BenchmarkSample> {
  const rootDir = await mkdtemp(join(tmpdir(), "rr-codex-worker-bench-"));
  const startedMemory = process.memoryUsage();
  const startedCpu = process.cpuUsage();
  const startedAt = performance.now();
  const durations: number[] = [];
  let successCount = 0;
  let failureCount = 0;

  const pool = new BoundedSubscriptionWorkerPool({
    poolId: `codex-bench-${input.slots}`,
    slots: input.slots,
    prewarmOnStart: false,
    shutdownTimeoutMs: 120_000,
    workerFactory: ({ workerId }) =>
      new FileBackendCodexWorker({
        workerId,
        providerInstanceId: `codex:bench:${input.slots}:${workerId}`,
        stateRootDir: rootDir,
        codexBinaryPath: input.codexBinaryPath,
        encryptionKey: input.encryptionKey,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        sessionCacheSlots: 1,
        taskTimeoutMs: 10 * 60_000,
        sourceEnv: process.env,
      }),
  });

  try {
    await pool.start();
    await Promise.all(
      Array.from({ length: input.slots }, async (_, index) => {
        const worker = (pool as unknown as { slots?: unknown }).slots;
        void worker;
        await seedWorker(pool, index, input.authJson);
      }),
    );
    await pool.prewarm();

    const tasks = Array.from({ length: input.taskCount }, (_, index) =>
      timed(async () => {
        const result = await pool.run({
          runId: `bench-${input.slots}-${index + 1}`,
          prompt: `${input.prompt}\nTask index: ${index + 1}.`,
        });
        if (!result.outputText.trim()) {
          throw new Error("empty_output");
        }
      }),
    );
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "fulfilled") {
        successCount += 1;
        durations.push(result.value);
      } else {
        failureCount += 1;
      }
    }
  } finally {
    await pool.dispose();
    await rm(rootDir, { recursive: true, force: true });
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
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? 0,
    rssDeltaMb: bytesToMb(endedMemory.rss - startedMemory.rss),
    heapDeltaMb: bytesToMb(endedMemory.heapUsed - startedMemory.heapUsed),
    cpuUserMs: endedCpu.user / 1000,
    cpuSystemMs: endedCpu.system / 1000,
  };
}

async function seedWorker(
  pool: BoundedSubscriptionWorkerPool<
    Parameters<FileBackendCodexWorker["run"]>[0],
    Awaited<ReturnType<FileBackendCodexWorker["run"]>>
  >,
  slotIndex: number,
  authJson: string,
): Promise<void> {
  const internals = pool as unknown as {
    readonly slots: readonly { readonly worker: FileBackendCodexWorker }[];
  };
  await internals.slots[slotIndex]?.worker.seedCodexAuthJson(authJson);
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
      "Return exactly one short sentence with the word OK.",
  };
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
