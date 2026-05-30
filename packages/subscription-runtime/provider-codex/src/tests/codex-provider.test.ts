import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@reviewrouter/subscription-runtime-core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "@reviewrouter/subscription-runtime-core/testing";
import type {
  ProcessResult,
  RunnerPort,
  RunnerCapabilities,
} from "@reviewrouter/subscription-runtime-core";
import {
  CodexCliAgentDriver,
  CodexCliProviderDriver,
  CodexCliSessionDriver,
  CodexWorkerCacheSessionMaterializer,
  CodexWorkerCacheSessionPoolMaterializer,
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  PackagedCodexJsonExecutionEngine,
  buildCodexJsonExecArgs,
  codexAgentCapabilities,
  codexEnvironmentPolicy,
  codexJsonAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import { classifyCodexRuntimeFailure } from "../codex-cli-domain";
import { pruneCodexChildEnv } from "../codex-cli-domain";
import { isTransientCodexTempCleanupError } from "../codex-cli-temp-cleanup";

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refresh-token",
    access_token: "access-token",
  },
  last_refresh: "2026-05-24T12:00:00.000Z",
});

const refreshedAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refreshed-refresh-token",
    access_token: "refreshed-access-token",
  },
  last_refresh: "2026-05-25T12:00:00.000Z",
});

describe("Codex provider adapter", () => {
  it("classifies quota failures without matching generic support guidance", () => {
    expect(
      classifyCodexRuntimeFailure(
        "Error 429: rate limit exceeded for this account",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "insufficient_quota: You exceeded your current quota",
      ),
    ).toBe("quota_limited");
    expect(classifyCodexRuntimeFailure("You've hit your usage limit.")).toBe(
      "quota_limited",
    );
    expect(
      classifyCodexRuntimeFailure(
        "Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "However, not enough retry quota is available for another attempt",
      ),
    ).toBe("quota_limited");
    expect(
      classifyCodexRuntimeFailure(
        "Check the required provider credentials, CLI setup, model name, and quota.",
      ),
    ).toBe("unknown_auth_state");
    expect(
      classifyCodexRuntimeFailure(
        "Verify the key has quota and access to the configured model.",
      ),
    ).toBe("unknown_auth_state");
  });

  it("recognizes transient Codex temp cleanup races", () => {
    const error = Object.assign(
      new Error(
        "ENOTEMPTY: directory not empty, rmdir '/tmp/codex-home/.tmp/plugins-clone-test'",
      ),
      { code: "ENOTEMPTY" },
    );

    expect(isTransientCodexTempCleanupError(error)).toBe(true);
    expect(isTransientCodexTempCleanupError(new Error("boom"))).toBe(false);
  });

  it("declares split session and agent capabilities", () => {
    expect(codexSessionCapabilities.providerId).toBe("codex");
    expect(codexSessionCapabilities.refreshMayRotateSession).toBe(true);
    expect(codexSessionCapabilities.environmentPolicy).toBe(
      codexEnvironmentPolicy,
    );
    expect(codexEnvironmentPolicy.credentialSourceOrder).toEqual([
      "codex-auth-json-file",
    ]);
    expect(codexAgentCapabilities.agentId).toBe("codex-cli");
    expect(codexAgentCapabilities.providerId).toBe("codex");
    expect(codexJsonAgentCapabilities.agentId).toBe("codex-json");
    expect(codexJsonAgentCapabilities.providerId).toBe("codex");
  });

  it("applies the provider-owned environment policy before Codex subprocesses", () => {
    const env = pruneCodexChildEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "must-not-pass",
      OPENAI_API_KEY: "must-not-pass",
      REVIEWROUTER_CODEX_AUTH_JSON: "must-not-pass",
      SAFE_PUBLIC_FLAG: "ok",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      SAFE_PUBLIC_FLAG: "ok",
    });
  });

  it("exposes a combined provider driver and manifest for composition roots", () => {
    const driver = new CodexCliProviderDriver({
      codexBinaryPath: "/bin/codex-test",
    });

    expect(driver.providerId).toBe("codex");
    expect(driver.agentId).toBe("codex-cli");
    expect(driver.capabilities).toBe(codexSessionCapabilities);
    expect(driver.agentCapabilities).toBe(codexAgentCapabilities);
    expect(codexProviderManifest).toMatchObject({
      adapterId: "provider.codex-cli",
      adapterKind: "combined-provider",
      capabilities: {
        agent: {
          agentId: "codex-json",
        },
      },
    });
    expect("custody" in codexProviderManifest).toBe(false);
  });

  it("validates Codex auth JSON as a session artifact", () => {
    const artifact = sessionArtifactFromCodexAuthJson(validAuthJson);
    const result = validateCodexSessionArtifact(artifact);

    expect(result.status).toBe("valid");
    expect(artifact.providerId).toBe("codex");
    expect(artifact.kind).toBe("json-file");
    expect(artifact.formatVersion).toBe("codex-auth-json-v1");
  });

  it("refreshes by writing an isolated Codex home and reading refreshed auth", async () => {
    const runner = new RefreshingRunner(refreshedAuthJson);
    const workspace = await mkdtemp(join(tmpdir(), "codex-provider-test-"));
    const driver = new CodexCliSessionDriver({
      codexBinaryPath: "/bin/codex-test",
      sourceEnv: {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "must-not-pass",
      },
    });

    try {
      const result = await driver.refreshSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result.providerState).toBe("refreshed");
      expect(runner.lastEnv?.GITHUB_TOKEN).toBeUndefined();
      expect(runner.lastEnv?.CODEX_HOME).toBeTruthy();
      expect(new TextDecoder().decode(result.artifact.bytes)).toContain(
        "refreshed-refresh-token",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs a Codex task with redacted output", async () => {
    const runner = new StaticRunner("review output");
    const workspace = await mkdtemp(join(tmpdir(), "codex-agent-test-"));
    const driver = new CodexCliAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      model: "gpt-test",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "review output",
      });
      expect(runner.lastArgs).toContain("gpt-test");
      expect(runner.lastArgs).toContain("inspect diff");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("builds packaged JSON exec args without the human renderer path", () => {
    expect(
      buildCodexJsonExecArgs({
        jsonFlag: "--json",
        model: "gpt-test",
        reasoningEffort: "low",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-test",
      "--sandbox",
      "read-only",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="low"',
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("runs a Codex JSON task through the packaged execution engine", async () => {
    const runner = new StaticRunner(
      `${JSON.stringify({ type: "agent_message", message: "json review output" })}\n`,
    );
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-agent-test-"));
    const driver = new CodexJsonAgentDriver({
      engine: new PackagedCodexJsonExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "json review output",
      });
      expect(runner.lastArgs).toContain("--json");
      expect(runner.lastArgs).toContain("-");
      expect(runner.lastStdin).toBe("inspect diff");
      expect(runner.lastEnv?.CODEX_HOME).toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs Codex JSON tasks through reusable app-server slots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-server-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-app-server-root-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-test",
        slots: 2,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const run = (prompt: string) =>
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });

      const [first, second] = await Promise.all([run("one"), run("two")]);

      expect(first).toMatchObject({
        status: "completed",
        outputText: "app-server output:one",
      });
      expect(second).toMatchObject({
        status: "completed",
        outputText: "app-server output:two",
      });
      expect(fakeFactory.spawnCount).toBe(2);
      expect(new Set(fakeFactory.codexHomes)).toHaveLength(2);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("falls back to packaged Codex exec when app-server fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-fallback-test-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStart: true,
    });
    const fallback = new RecordingJsonEngine("fallback output");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        fallback,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "fallback please" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "fallback output",
      });
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "codex_app_server_fallback",
      );
      expect(fallback.prompts).toEqual(["fallback please"]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prewarms and reuses worker-cache CODEX_HOME across tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-cache-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-cache-root-"));
    const engine = new RecordingJsonEngine();
    const materializer = new CodexWorkerCacheSessionMaterializer({
      cacheKey: "provider-account:codex-test:slot:0",
      rootDir: cacheRoot,
    });
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: materializer,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
      });
      expect(prewarm.reusable).toBe(true);

      const first = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "first" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      const second = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "second" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(engine.codexHomes).toHaveLength(2);
      expect(engine.codexHomes[0]).toBe(prewarm.codexHome);
      expect(engine.codexHomes[1]).toBe(prewarm.codexHome);

      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(refreshedAuthJson),
        task: { kind: "review", prompt: "rotated" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(engine.codexHomes[2]).toBe(prewarm.codexHome);
      await expect(readFile(join(prewarm.codexHome, "auth.json"), "utf8"))
        .resolves.toContain("refreshed-refresh-token");

      await driver.dispose();
      await expect(readFile(join(prewarm.codexHome, "auth.json"), "utf8"))
        .rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent worker-cache use for one warmed worker slot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-worker-lock-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-worker-lock-root-"));
    const engine = new SlowRecordingJsonEngine();
    const driver = new CodexJsonAgentDriver({
      engine,
      sessionMaterializer: new CodexWorkerCacheSessionMaterializer({
        cacheKey: "provider-account:codex-test:slot:1",
        rootDir: cacheRoot,
      }),
    });

    try {
      const run = (prompt: string) =>
        driver.runTask({
          session: sessionArtifactFromCodexAuthJson(validAuthJson),
          task: { kind: "review", prompt },
          workspace: { path: workspace },
          runner: new StaticRunner(""),
          redactor: new DefaultRedactor(),
          abortSignal: new AbortController().signal,
        });

      await Promise.all([run("one"), run("two")]);
      expect(engine.maxActive).toBe(1);
      expect(engine.codexHomes[0]).toBe(engine.codexHomes[1]);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

providerSessionDriverContract("codex", () => ({
  driver: new CodexCliSessionDriver({ codexBinaryPath: "/bin/codex-test" }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
  reconnectError: new Error("invalid_grant refresh_token=raw"),
}));

agentDriverContract("codex", () => ({
  driver: new CodexCliAgentDriver({ codexBinaryPath: "/bin/codex-test" }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
}));

agentDriverContract("codex-json", () => ({
  driver: new CodexJsonAgentDriver({
    engine: {
      kind: "packaged-json",
      capabilities: {
        supportsStructuredOutput: true,
        supportsJsonEvents: true,
        supportsThreadResume: false,
        requiresSchemaFile: false,
      },
      async run() {
        return {
          outputText: "json contract output",
          warnings: [],
        };
      },
    },
  }),
  goodSession: sessionArtifactFromCodexAuthJson(validAuthJson),
  redactor: new DefaultRedactor(),
}));

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "codex-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class RefreshingRunner implements RunnerPort {
  readonly runnerId = "codex-test-runner";
  readonly capabilities = runnerCapabilities;
  lastEnv: Readonly<Record<string, string>> | null = null;

  constructor(private readonly nextAuthJson: string) {}

  async run(input: {
    readonly env: Readonly<Record<string, string>>;
    readonly args: readonly string[];
  }): Promise<ProcessResult> {
    this.lastEnv = input.env;
    const codexHome = input.env.CODEX_HOME;
    if (!codexHome) throw new Error("missing_codex_home");
    expect(input.args).toContain("exec");
    await readFile(join(codexHome, "auth.json"), "utf8");
    await writeFile(join(codexHome, "auth.json"), this.nextAuthJson);
    return {
      exitCode: 0,
      stdout: "OK",
      stderr: "",
      durationMs: 1,
    };
  }
}

class StaticRunner implements RunnerPort {
  readonly runnerId = "codex-test-runner";
  readonly capabilities = runnerCapabilities;
  lastArgs: readonly string[] = [];
  lastEnv: Readonly<Record<string, string>> | null = null;
  lastStdin: string | null = null;

  constructor(private readonly stdout: string) {}

  async run(input: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
  }): Promise<ProcessResult> {
    this.lastArgs = input.args;
    this.lastEnv = input.env;
    this.lastStdin = input.stdin
      ? new TextDecoder().decode(input.stdin)
      : null;
    return {
      exitCode: 0,
      stdout: this.stdout,
      stderr: "",
      durationMs: 1,
    };
  }
}

class RecordingJsonEngine implements CodexExecutionEngine {
  readonly kind = "packaged-json" as const;
  readonly capabilities = {
    supportsStructuredOutput: true,
    supportsJsonEvents: true,
    supportsThreadResume: false,
    requiresSchemaFile: false,
  } as const;
  readonly codexHomes: string[] = [];
  readonly prompts: string[] = [];

  constructor(private readonly fixedOutputText?: string) {}

  async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
    this.codexHomes.push(input.session.codexHome);
    this.prompts.push(input.prompt);
    return {
      outputText: this.fixedOutputText ?? `json output:${input.prompt}`,
      warnings: [],
    };
  }
}

class SlowRecordingJsonEngine extends RecordingJsonEngine {
  active = 0;
  maxActive = 0;

  override async run(input: Parameters<CodexExecutionEngine["run"]>[0]) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await super.run(input);
    } finally {
      this.active -= 1;
    }
  }
}

type FakeAppServerFactoryOptions = {
  readonly failThreadStart?: boolean;
};

class FakeAppServerFactory {
  spawnCount = 0;
  readonly codexHomes: string[] = [];

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }) => {
    this.spawnCount += 1;
    this.codexHomes.push(input.env.CODEX_HOME ?? "");
    return new FakeAppServerProcess(this.options);
  };
}

class FakeAppServerProcess extends EventEmitter {
  readonly pid = Math.floor(Math.random() * 100_000) + 1;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: () => undefined,
  };
  private nextThreadId = 1;
  private nextTurnId = 1;

  constructor(private readonly options: FakeAppServerFactoryOptions) {
    super();
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "initialize") {
        this.respond(request.id, {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
        });
        continue;
      }
      if (request.method === "thread/start") {
        if (this.options.failThreadStart) {
          this.respondError(request.id, "fake thread start failure");
          continue;
        }
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        this.respond(request.id, {
          thread: { id: threadId },
        });
        continue;
      }
      if (request.method === "turn/start") {
        const turnId = `turn-${this.nextTurnId}`;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.respond(request.id, {
          turn: { id: turnId },
        });
        setTimeout(() => {
          this.notify("item/agentMessage/delta", {
            turnId,
            delta: `app-server output:${prompt}`,
          });
          this.notify("turn/completed", {
            turn: { id: turnId, status: { type: "completed" } },
          });
        }, 5);
        continue;
      }
      this.respondError(request.id, `unsupported:${request.method}`);
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.emit(
      "data",
      `${JSON.stringify({ id, error: { message } })}\n`,
    );
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

function extractFakePrompt(params: Record<string, unknown> | undefined): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}
