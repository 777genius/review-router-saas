import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type OutputSink,
  type ProcessResult,
  type ProviderTask,
  type ProviderTaskResult,
  type RedactorPort,
  type RunnerPort,
  type RuntimeEvent,
  type RuntimeMetric,
  type WorkspaceHandle,
  type WorkspacePort,
} from "@777genius/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexCliSessionDriver,
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
  type CodexReasoningEffort,
  sessionArtifactFromCodexAuthJson,
} from "@777genius/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@777genius/subscription-runtime/store-local-file";

export type FileBackendCodexWorkerOptions = {
  readonly providerInstanceId: string;
  readonly stateRootDir: string;
  readonly codexBinaryPath: string;
  readonly encryptionKey: Uint8Array | string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly slots?: number;
  readonly taskTimeoutMs?: number;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type FileBackendCodexWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly abortSignal?: AbortSignal;
};

export type FileBackendCodexWorkerResult = {
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export class FileBackendCodexWorker {
  private readonly redactor: RedactorPort = new DefaultRedactor();
  private readonly runner = new NodeProcessRunner();
  private readonly workspace = new TempWorkspace();
  private readonly observability: ObservabilityPort =
    new SafeConsoleObservability();
  private readonly clock: ClockPort = systemClock;
  private readonly idGenerator = new DeterministicIdGenerator();
  private readonly sessionDriver: CodexCliSessionDriver;
  private readonly agentDriver: CodexJsonAgentDriver;
  private readonly sessionStore;
  private readonly runtime;

  constructor(private readonly options: FileBackendCodexWorkerOptions) {
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "codex",
      rootDir: join(options.stateRootDir, "sessions"),
      encryptionKey: options.encryptionKey,
      metadata: { adapter: "file-backend-codex-worker" },
    });
    this.sessionStore = sessionStore;

    this.sessionDriver = new CodexCliSessionDriver({
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
    });

    const fallback = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
    });
    this.agentDriver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: options.codexBinaryPath,
        ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
        ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
        fallback,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: `codex:${options.providerInstanceId}`,
        slots: options.slots ?? 2,
        rootDir: join(options.stateRootDir, "codex-cache"),
      }),
      model: options.model ?? "gpt-5.5",
      reasoningEffort: options.reasoningEffort ?? "low",
    });

    this.runtime = createSubscriptionRuntime({
      policy: {
        custodyMode: "local-only",
        requireNoBackendPlaintext: false,
        requireWritebackBeforeTask: true,
        requireCompareAndSwap: true,
        allowInteractiveSetupInRuntime: false,
        allowedProviderIds: ["codex"],
        allowedAgentIds: [this.agentDriver.agentId],
        allowedStoreIds: [sessionStore.storeId],
        allowedRunnerIds: [this.runner.runnerId],
      },
      sessionDriver: this.sessionDriver,
      agentDriver: this.agentDriver,
      sessionStore,
      leaseStore,
      runner: this.runner,
      workspace: this.workspace,
      redactor: this.redactor,
      observability: this.observability,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });
  }

  async seedCodexAuthJsonFile(authJsonPath: string): Promise<void> {
    const authJson = await readFile(authJsonPath, "utf8");
    await this.seedCodexAuthJson(authJson);
  }

  async seedCodexAuthJson(authJson: string): Promise<void> {
    const existing = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (existing) return;

    const artifact = sessionArtifactFromCodexAuthJson(authJson);
    await this.sessionStore.write({
      providerInstanceId: this.options.providerInstanceId,
      expectedGeneration: 0,
      nextArtifact: artifact,
      idempotencyKey: `seed:${hashText(authJson)}`,
      leaseId: "seed-local-file-backend",
    });
  }

  async prewarm(): Promise<void> {
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "run",
    });
    if (!session) {
      throw new Error("file_backend_codex_session_missing");
    }
    await this.agentDriver.prewarmSession({
      session: session.artifact,
      redactor: this.redactor,
    });
  }

  async runOneShot(
    job: FileBackendCodexWorkerJob,
  ): Promise<FileBackendCodexWorkerResult> {
    const result = await this.runtime.refreshThenRunTask({
      providerInstanceId: this.options.providerInstanceId,
      task: {
        kind: job.kind ?? "structured-prompt",
        prompt: job.prompt,
        ...(job.outputSchemaName
          ? { outputSchemaName: job.outputSchemaName }
          : {}),
      },
      runContext: {
        runId: job.runId ?? `local-${randomUUID()}`,
        attempt: 1,
        abortSignal: job.abortSignal ?? new AbortController().signal,
      },
    });

    if (result.status !== "completed") {
      throw new Error(`file_backend_codex_run_blocked:${result.reason}`);
    }
    return taskResultToOutput(result.task);
  }

  async dispose(): Promise<void> {
    await this.agentDriver.dispose();
  }
}

class NodeProcessRunner implements RunnerPort {
  readonly runnerId = "node-process-runner";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process" as const,
  };

  async run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly stdout?: OutputSink;
    readonly stderr?: OutputSink;
    readonly abortSignal: AbortSignal;
  }): Promise<ProcessResult> {
    const startedAt = Date.now();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      input.stdout?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      input.stderr?.write(chunk);
    });

    let forceKillTimer: NodeJS.Timeout | null = null;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    };
    const timeout = setTimeout(terminate, input.timeoutMs);
    const abort = () => terminate();
    input.abortSignal.addEventListener("abort", abort, { once: true });

    if (input.stdin) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }

    try {
      const exit = await new Promise<{
        readonly exitCode: number;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
      });
      return {
        exitCode: exit.exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.abortSignal.removeEventListener("abort", abort);
    }
  }
}

class TempWorkspace implements WorkspacePort {
  readonly workspaceId = "temp-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: true,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  async create(): Promise<WorkspaceHandle> {
    const path = await mkdtemp(join(tmpdir(), "subscription-runtime-worker-"));
    return {
      path,
      dispose: () => rm(path, { recursive: true, force: true }),
    };
  }
}

class SafeConsoleObservability implements ObservabilityPort {
  emit(event: RuntimeEvent): void {
    if (event.name === "runtime.failure.classified") {
      console.warn("[subscription-runtime]", event.name, event.metadata ?? {});
    }
  }

  count(metric: RuntimeMetric): void {
    void metric;
  }

  timing(metric: RuntimeMetric, durationMs: number): void {
    void metric;
    void durationMs;
  }
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};

function taskResultToOutput(
  result: ProviderTaskResult,
): FileBackendCodexWorkerResult {
  if (result.status === "failed") {
    throw new Error(`file_backend_codex_task_failed:${result.failure.code}`);
  }
  return {
    outputText: result.outputText,
    structuredOutput: result.structuredOutput,
    warnings: result.warnings,
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
