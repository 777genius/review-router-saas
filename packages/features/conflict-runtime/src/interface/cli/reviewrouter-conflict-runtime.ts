#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { runConflictReviewRuntime } from "../../application/conflict-runtime-runner.js";
import { ActionControlPlaneConflictPostingClient } from "../../infrastructure/action-control-plane-conflict-posting-client.js";
import { ActionControlPlanePrStateValidator } from "../../infrastructure/action-control-plane-pr-state-validator.js";
import { ActionControlPlaneRuntimeConfigClient } from "../../infrastructure/action-control-plane-runtime-config-client.js";
import { CodexCliConflictProviderRunner } from "../../infrastructure/codex-cli-conflict-provider-runner.js";
import { parseConflictRuntimeConfig } from "../../domain/conflict-runtime.js";
import {
  GitCliConflictCheckout,
  GitCliConflictDiffSource,
} from "../../infrastructure/git-cli-conflict-runtime.js";
import { GitHubActionsOidcTokenProvider } from "../../infrastructure/github-actions-oidc-token-provider.js";

const sessionFileSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionToken: z.string().min(1),
    repository: z.string().min(1),
    fetchedAt: z.string().datetime(),
    runtimeConfig: z.object({ conflictReview: z.unknown() }).passthrough(),
    conflictReview: z.unknown(),
  })
  .strict();

const providerSecretKeys = [
  "CODEX_AUTH_JSON",
  "CODEX_CONFIG_TOML",
  "OPENAI_API_KEY",
] as const;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "preflight") {
    await preflight();
    return;
  }
  if (command === "run") {
    await run();
    return;
  }
  throw new Error("usage: reviewrouter-conflict-runtime <preflight|run>");
}

async function preflight(): Promise<void> {
  const apiUrl = requireValue(
    readOption("--api-url") ??
      process.env.REVIEWROUTER_API_URL ??
      process.env.REVIEW_ROUTER_API_URL,
    "missing_api_url",
  );
  const sessionFile = resolveSessionFile();
  const configClient = new ActionControlPlaneRuntimeConfigClient({
    apiUrl,
    audience:
      readOption("--audience") ?? process.env.REVIEWROUTER_OIDC_AUDIENCE,
    actionVersion:
      readOption("--action-version") ??
      process.env.REVIEWROUTER_ACTION_VERSION ??
      process.env.INPUT_RUNTIME_REF,
  });
  const conflictDispatchPayload = readConflictDispatchPayloadFromEnv();
  mask(conflictDispatchPayload.nonce);
  const oidcToken = await new GitHubActionsOidcTokenProvider({
    audience:
      readOption("--audience") ?? process.env.REVIEWROUTER_OIDC_AUDIENCE,
  }).requestToken();
  mask(oidcToken);
  const session = await configClient.exchangeConflictSession({
    oidcToken,
    conflictDispatchPayload,
  });
  mask(session.sessionToken);
  const runtimeConfig = await configClient.fetchConflictRuntimeConfig({
    sessionToken: session.sessionToken,
  });
  await writeSessionFile(sessionFile, {
    protocolVersion: 1,
    sessionToken: session.sessionToken,
    repository: session.repository,
    fetchedAt: new Date().toISOString(),
    runtimeConfig: {
      ...runtimeConfig.runtimeConfig,
      conflictReview: runtimeConfig.conflictReview,
    },
    conflictReview: runtimeConfig.conflictReview,
  });
  safeLog("preflight_completed");
}

async function run(): Promise<void> {
  const apiUrl = requireValue(
    readOption("--api-url") ??
      process.env.REVIEWROUTER_API_URL ??
      process.env.REVIEW_ROUTER_API_URL,
    "missing_api_url",
  );
  const sessionFile = resolveSessionFile();
  const targetWorkspace = resolve(
    readOption("--target-workspace") ??
      process.env.REVIEW_ROUTER_TARGET_WORKSPACE ??
      process.cwd(),
  );
  assertSessionFileOutsideWorkspace(sessionFile, targetWorkspace);
  const session = sessionFileSchema.parse(
    JSON.parse(await readFile(sessionFile, "utf8")),
  );
  mask(session.sessionToken);
  const configClient = new ActionControlPlaneRuntimeConfigClient({
    apiUrl,
    audience:
      readOption("--audience") ?? process.env.REVIEWROUTER_OIDC_AUDIENCE,
    actionVersion:
      readOption("--action-version") ??
      process.env.REVIEWROUTER_ACTION_VERSION ??
      process.env.INPUT_RUNTIME_REF,
  });
  const conflictConfig = parseConflictRuntimeConfig(session.conflictReview);
  await runConflictReviewRuntime(
    {
      runtimeConfig: conflictConfig,
      sourceEnv: buildConflictRuntimeSourceEnv({
        runtimeEnv: toRuntimeEnvRecord(session.runtimeConfig.runtimeEnv),
        staticRuntimeEnv: readStaticRuntimeEnvFromEnv(),
        processEnv: process.env,
      }),
    },
    {
      prStateValidator: new ActionControlPlanePrStateValidator({
        configClient,
        sessionToken: session.sessionToken,
      }),
      checkout: new GitCliConflictCheckout({ workspace: targetWorkspace }),
      diffSource: new GitCliConflictDiffSource({ workspace: targetWorkspace }),
      providerRunner: new CodexCliConflictProviderRunner({
        workspace: targetWorkspace,
        timeoutMs: readPositiveIntegerEnv(
          "REVIEW_ROUTER_CONFLICT_PROVIDER_TIMEOUT_MS",
          15 * 60 * 1000,
        ),
      }),
      postingClient:
        getPostingMode(conflictConfig) === "proxy"
          ? new ActionControlPlaneConflictPostingClient({
              apiUrl,
              actionSessionToken: session.sessionToken,
              config: conflictConfig,
            })
          : undefined,
      healthReporter: {
        async report(event) {
          safeLog(`phase=${event.phase}`);
        },
      },
    },
  );
}

function readConflictDispatchPayloadFromEnv() {
  return {
    protocolVersion: 1,
    fallbackVersion: 1,
    dispatchEventType: requireValue(
      process.env.INPUT_CONFLICT_DISPATCH_EVENT_TYPE ??
        process.env.REVIEW_ROUTER_CONFLICT_DISPATCH_EVENT_TYPE,
      "missing_conflict_dispatch_event_type",
    ),
    dispatchId: requireValue(
      process.env.INPUT_CONFLICT_DISPATCH_ID ??
        process.env.REVIEW_ROUTER_CONFLICT_DISPATCH_ID,
      "missing_conflict_dispatch_id",
    ),
    nonce: requireValue(
      process.env.INPUT_CONFLICT_DISPATCH_NONCE ??
        process.env.REVIEW_ROUTER_CONFLICT_DISPATCH_NONCE,
      "missing_conflict_dispatch_nonce",
    ),
    repositoryId: requireValue(
      process.env.INPUT_CONFLICT_REPOSITORY_ID ??
        process.env.REVIEW_ROUTER_CONFLICT_REPOSITORY_ID,
      "missing_conflict_repository_id",
    ),
    pullRequestNumber: Number(
      requireValue(
        process.env.INPUT_PR_NUMBER ??
          process.env.REVIEW_ROUTER_CONFLICT_PR_NUMBER,
        "missing_conflict_pr_number",
      ),
    ),
    headSha: requireValue(
      process.env.INPUT_CONFLICT_HEAD_SHA ??
        process.env.REVIEW_ROUTER_CONFLICT_HEAD_SHA,
      "missing_conflict_head_sha",
    ),
    baseRef: requireValue(
      process.env.INPUT_CONFLICT_BASE_REF ??
        process.env.REVIEW_ROUTER_CONFLICT_BASE_REF,
      "missing_conflict_base_ref",
    ),
    baseSha: requireValue(
      process.env.INPUT_CONFLICT_BASE_SHA ??
        process.env.REVIEW_ROUTER_CONFLICT_BASE_SHA,
      "missing_conflict_base_sha",
    ),
  };
}

function buildConflictRuntimeSourceEnv(input: {
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly staticRuntimeEnv: Readonly<Record<string, string>>;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = {
    ...input.staticRuntimeEnv,
    ...input.runtimeEnv,
  };
  for (const key of providerSecretKeys) {
    delete merged[key];
    if (typeof input.processEnv[key] === "string") {
      merged[key] = input.processEnv[key];
    }
  }
  return merged;
}

function readStaticRuntimeEnvFromEnv(): Readonly<Record<string, string>> {
  const raw =
    process.env.INPUT_STATIC_RUNTIME_ENV_JSON ??
    process.env.REVIEW_ROUTER_STATIC_RUNTIME_ENV_JSON;
  if (!raw?.trim()) {
    return {};
  }
  const parsed = z.record(z.string(), z.string()).parse(JSON.parse(raw));
  for (const key of providerSecretKeys) {
    if (parsed[key] !== undefined) {
      throw new Error("conflict_runtime_static_env_secret_forbidden");
    }
  }
  return parsed;
}

function toRuntimeEnvRecord(value: unknown): Readonly<Record<string, string>> {
  return z.record(z.string(), z.string()).parse(value ?? {});
}

async function writeSessionFile(
  file: string,
  payload: z.infer<typeof sessionFileSchema>,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(payload), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

function resolveSessionFile(): string {
  return resolve(
    readOption("--session-file") ??
      process.env.REVIEW_ROUTER_CONFLICT_SESSION_FILE ??
      `${process.env.RUNNER_TEMP ?? tmpdir()}/reviewrouter-conflict-session.json`,
  );
}

function assertSessionFileOutsideWorkspace(
  sessionFile: string,
  workspace: string,
): void {
  const relation = relative(workspace, sessionFile);
  if (
    relation === "" ||
    (!relation.startsWith("..") && !relation.startsWith("/"))
  ) {
    throw new Error("conflict_runtime_session_file_inside_workspace");
  }
}

function getPostingMode(config: unknown): "proxy" | "disabled" {
  return typeof config === "object" &&
    config !== null &&
    "posting" in config &&
    typeof config.posting === "object" &&
    config.posting !== null &&
    "mode" in config.posting &&
    config.posting.mode === "proxy"
    ? "proxy"
    : "disabled";
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_env:${name}`);
  }
  return parsed;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`missing_option_value:${name}`);
  }
  return value;
}

function requireValue(value: string | undefined, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(code);
  }
  return trimmed;
}

function mask(value: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

function safeLog(message: string): void {
  console.log(`reviewrouter_conflict_runtime:${message}`);
}

main().catch((error) => {
  const code = error instanceof Error ? error.message : "unknown_error";
  console.error(`reviewrouter_conflict_runtime_failed:${safeErrorCode(code)}`);
  process.exitCode = 1;
});

function safeErrorCode(value: string): string {
  if (
    /authorization|bearer|gh[spou]_|github_pat_|sk-[a-z0-9]|api[_-]?key=|secret=|token=|nonce/i.test(
      value,
    )
  ) {
    return "runtime_error";
  }
  return value.replaceAll(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160);
}
