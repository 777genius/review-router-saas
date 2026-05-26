import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  codexAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import { classifyCodexRuntimeFailure } from "../codex-cli-domain";

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

  it("declares split session and agent capabilities", () => {
    expect(codexSessionCapabilities.providerId).toBe("codex");
    expect(codexSessionCapabilities.refreshMayRotateSession).toBe(true);
    expect(codexAgentCapabilities.agentId).toBe("codex-cli");
    expect(codexAgentCapabilities.providerId).toBe("codex");
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

  constructor(private readonly stdout: string) {}

  async run(input: {
    readonly args: readonly string[];
  }): Promise<ProcessResult> {
    this.lastArgs = input.args;
    return {
      exitCode: 0,
      stdout: this.stdout,
      stderr: "",
      durationMs: 1,
    };
  }
}
