import type {
  ProviderFailure,
  ProviderSessionDriver,
  RefreshedSession,
  SessionArtifact,
  SessionValidationResult,
  WorkspaceHandle,
} from "@reviewrouter/subscription-runtime-core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "./codex-auth-json-codec";
import {
  buildCodexRefreshBootstrapPlan,
  pruneCodexChildEnv,
} from "./codex-cli-domain";
import {
  codexAuthJsonFormatVersion,
  codexProviderId,
  codexSessionCapabilities,
} from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";

export type CodexCliSessionDriverOptions = {
  readonly codexBinaryPath?: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export class CodexCliSessionDriver implements ProviderSessionDriver {
  readonly providerId = codexProviderId;
  readonly supportedArtifactKinds = ["json-file"] as const;
  readonly capabilities = codexSessionCapabilities;

  constructor(private readonly options: CodexCliSessionDriverOptions = {}) {}

  async validateSession(input: {
    readonly session: SessionArtifact;
  }): Promise<SessionValidationResult> {
    return validateCodexSessionArtifact(input.session);
  }

  async refreshSession(input: {
    readonly session: SessionArtifact;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<
      ProviderSessionDriver["refreshSession"]
    >[0]["runner"];
    readonly redactor: Parameters<
      ProviderSessionDriver["refreshSession"]
    >[0]["redactor"];
    readonly abortSignal: AbortSignal;
  }): Promise<RefreshedSession> {
    const authJson = codexAuthJsonFromArtifact(input.session);
    input.redactor.registerSecret(authJson, "codex-auth-json");

    const tempRoot = await mkdtemp(
      join(tmpdir(), "subscription-runtime-codex-"),
    );
    const tempHome = join(tempRoot, "home");
    const tempCodexHome = join(tempRoot, "codex-home");
    const emptyWorkingDirectory = join(tempRoot, "empty-workdir");
    const authJsonPath = join(tempCodexHome, "auth.json");
    await mkdir(tempHome, { recursive: true, mode: 0o700 });
    await mkdir(tempCodexHome, { recursive: true, mode: 0o700 });
    await mkdir(emptyWorkingDirectory, { recursive: true, mode: 0o700 });

    try {
      await writeCodexHomeSnapshot({ codexHome: tempCodexHome, authJson });
      const plan = buildCodexRefreshBootstrapPlan({
        codexBinaryPath: this.options.codexBinaryPath ?? "codex",
        tempHome,
        tempCodexHome,
        emptyWorkingDirectory,
        authJsonPath,
      });

      await input.runner.run({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: {
          ...pruneCodexChildEnv(this.options.sourceEnv ?? {}),
          ...plan.env,
        },
        stdin: new TextEncoder().encode("Respond with OK only."),
        timeoutMs: 5 * 60 * 1000,
        abortSignal: input.abortSignal,
      });

      const refreshedAuthJson = await readFile(authJsonPath, "utf8");
      const refreshed = sessionArtifactFromCodexAuthJson(refreshedAuthJson);
      const providerState =
        refreshedAuthJson === authJson ? "unchanged" : "refreshed";
      return {
        artifact: refreshed,
        providerState,
        warnings: [],
      };
    } catch (error) {
      const failure = classifyCodexFailure(error);
      if (failure.code === "needs_reconnect") {
        return {
          artifact: {
            ...input.session,
            formatVersion: codexAuthJsonFormatVersion,
          },
          providerState: "needs-reconnect",
          warnings: [],
        };
      }
      if (failure.code === "quota_limited") {
        return {
          artifact: input.session,
          providerState: "quota-limited",
          warnings: [{ code: failure.code, safeMessage: failure.safeMessage }],
        };
      }
      if (failure.code === "permission_required") {
        return {
          artifact: input.session,
          providerState: "permission-required",
          warnings: [{ code: failure.code, safeMessage: failure.safeMessage }],
        };
      }
      throw error;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  classifySessionFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }
}

async function writeCodexHomeSnapshot(input: {
  readonly codexHome: string;
  readonly authJson: string;
}): Promise<void> {
  const config = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
  ].join("\n");
  await writeFile(join(input.codexHome, "config.toml"), config, {
    mode: 0o600,
  });
  await writeFile(join(input.codexHome, "auth.json"), input.authJson, {
    mode: 0o600,
  });
}
