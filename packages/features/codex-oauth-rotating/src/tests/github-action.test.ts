import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedRunnerEnvironment,
  buildCodexCommand,
  buildFullReviewRuntimeEnv,
  deleteFullRuntimeProgressComments,
  deleteStaleCodexRotatingSummaryComments,
  didReviewRuntimeComplete,
  extractReviewRouterRuntimeFailure,
  formatTopLevelActionErrorMessage,
  postPullRequestComment,
  readActionAuthJson,
  readActionInputs,
  resolveCodexBinary,
  resolveCodexProxyUpstreamResponsesUrl,
  routeCodexLocalProviderRequest,
  runCodexRotatingGitHubAction,
  sanitizeReviewComment,
  settleFinalizedReviewCheckpoint,
  shouldAutoRunCodexRotatingAction,
  shouldUseSubscriptionRuntimeCodex,
  shouldSuppressTopLevelActionError,
  startCodexLocalProviderProxy,
} from "../action/github-action";

describe("Codex rotating GitHub Action runtime", () => {
  it("detects already reported ReviewRouter runtime failures", () => {
    expect(
      extractReviewRouterRuntimeFailure(
        "ReviewRouter found 2 major+ finding(s). Review comments were posted before failing this check.\n",
      ),
    ).toBe(
      "ReviewRouter found 2 major+ finding(s). Review comments were posted before failing this check.",
    );
    expect(
      extractReviewRouterRuntimeFailure(
        [
          "Review failed [required_provider_unhealthy]: A required review provider was unavailable or unhealthy.",
          "Check provider credentials, CLI setup, model name, and quota.",
        ].join("\n"),
      ),
    ).toBe(
      "Review failed [required_provider_unhealthy]: A required review provider was unavailable or unhealthy.",
    );
  });

  it("clears finalized checkpoints directly when no snapshot advancement is required", async () => {
    const commitSnapshot = vi.fn().mockResolvedValue(true);
    const clearCheckpoint = vi.fn().mockResolvedValue(undefined);
    const marker = {
      protocolVersion: 1 as const,
      pullRequestNumber: 118,
      headSha: "0".repeat(40),
      planHash: "1".repeat(64),
      expectedVersion: 9,
      snapshotAdvancementRequired: false,
    };

    await settleFinalizedReviewCheckpoint({
      marker,
      runtimeCompleted: true,
      commitSnapshot,
      clearCheckpoint,
    });

    expect(commitSnapshot).not.toHaveBeenCalled();
    expect(clearCheckpoint).toHaveBeenCalledWith(marker);

    clearCheckpoint.mockClear();
    await settleFinalizedReviewCheckpoint({
      marker,
      runtimeCompleted: false,
      commitSnapshot,
      clearCheckpoint,
    });
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("treats an already-reported policy failure as a completed review runtime", () => {
    expect(didReviewRuntimeComplete(undefined)).toBe(true);
    expect(didReviewRuntimeComplete({ alreadyReportedToGitHub: true })).toBe(
      true,
    );
    expect(didReviewRuntimeComplete(new Error("process crashed"))).toBe(false);
  });

  it("declares a real node action entrypoint without pre or post hooks", () => {
    const actionYml = readFileSync(join(process.cwd(), "action.yml"), "utf8");
    const actionSource = readFileSync(
      join(
        process.cwd(),
        "packages/features/codex-oauth-rotating/src/action/github-action.ts",
      ),
      "utf8",
    );

    expect(actionYml).toContain("using: node24");
    expect(actionYml).toContain("main: action-dist/index.cjs");
    expect(actionYml).not.toMatch(
      /\bdefault:\s*["']?codex-oauth-rotating["']?\b/,
    );
    expect(actionSource).toContain("action-dist[\\\\/]index\\.cjs");
    expect(actionSource).not.toContain("process.env.GITHUB_ACTION_PATH");
    expect(actionYml).toContain("provider-instance-id:\n    description:");
    expect(actionYml).toContain("review-drafts:\n    description:");
    expect(actionYml).toContain("max-changed-lines:\n    description:");
    expect(actionYml).toContain("review-timeout-minutes:\n    description:");
    expect(actionYml).toContain("auth-json:\n    description:");
    expect(actionYml).toContain("claude-code-oauth-token:\n    description:");
    expect(actionYml).toContain("openrouter-api-key:\n    description:");
    expect(actionYml).not.toContain("codex-package-version");
    expect(actionYml).not.toContain("codex-binary");
    expect(actionYml).not.toMatch(/\bpre:/);
    expect(actionYml).not.toMatch(/\bpre-if:/);
    expect(actionYml).not.toMatch(/\bpost:/);
    expect(actionYml).not.toMatch(/\bpost-if:/);
  });

  it("passes the optional lifecycle resolve token only to the full runtime child", () => {
    const childEnv = buildFullReviewRuntimeEnv({
      sourceEnv: {
        PATH: "/usr/bin",
        GITHUB_TOKEN: "source-github-token",
        OPENAI_API_KEY: "source-openai-key",
        REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN: "source-lifecycle-token",
      },
      inputs: {
        mode: "fork-agentic-sandbox",
        apiUrl: "https://api.reviewrouter.site",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 1,
        reviewDrafts: false,
        maxChangedLines: 0,
        reviewTimeoutMinutes: 60,
        providerSecrets: {},
      },
      leaseId: "lease-123",
      event: {
        number: 118,
        repository: "777genius/agent-teams-ai",
        owner: "777genius",
        repo: "agent-teams-ai",
        headSha: "head-sha",
        baseSha: "base-sha",
      },
      workspace: "/tmp/workspace",
      tempHome: "/tmp/home",
      tempCodexHome: "/tmp/codex-home",
      codexBinDir: "/tmp/codex-bin",
      commentToken: "comment-token",
      runtimeConfigVersion: 7,
      runtimeEnv: {
        REVIEW_PROVIDERS: "codex/gpt-5.5",
      },
      reviewThreadLifecycleResolveToken: "repo-scoped-lifecycle-token",
      reviewSnapshotInputPath: "/tmp/home/snapshot-input.json",
      reviewSnapshotOutputPath: "/tmp/home/snapshot-output.json",
      reviewCheckpointFinalizationPath:
        "/tmp/home/checkpoint-finalization.json",
      executionDeadlineEpochMs: 1_800_000_000_000,
    });

    expect(childEnv.PATH).toContain("/tmp/codex-bin");
    expect(childEnv.GITHUB_TOKEN).toBe("comment-token");
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN).toBe(
      "repo-scoped-lifecycle-token",
    );
    expect(childEnv.REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH).toBe(
      "/tmp/home/snapshot-input.json",
    );
    expect(childEnv.REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH).toBe(
      "/tmp/home/snapshot-output.json",
    );
    expect(childEnv.REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH).toBe(
      "/tmp/home/checkpoint-finalization.json",
    );
    expect(childEnv.REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS).toBe(
      "1800000000000",
    );
  });

  it("does not auto-run when imported by CI tooling under GitHub Actions", () => {
    expect(
      shouldAutoRunCodexRotatingAction({
        env: { GITHUB_ACTIONS: "true" },
        argv: ["/usr/bin/node", "/workspace/scripts/check-runtime.mjs"],
      }),
    ).toBe(false);
    expect(
      shouldAutoRunCodexRotatingAction({
        env: { GITHUB_ACTIONS: "true" },
        argv: [
          "/usr/bin/node",
          "/home/runner/work/_actions/777genius/review-router/789c192/action-dist/index.cjs",
        ],
      }),
    ).toBe(true);
    expect(
      shouldAutoRunCodexRotatingAction({
        env: { REVIEW_ROUTER_RUN_CODEX_ROTATING_ACTION: "1" },
        argv: ["/usr/bin/node", "/workspace/custom-entrypoint.js"],
      }),
    ).toBe(true);
  });

  it("reads hyphenated GitHub action inputs without reading auth-json", () => {
    const inputs = readActionInputs({
      "INPUT_API-URL": "https://api.reviewrouter.site/",
      "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
      "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
      "INPUT_CLAUDE-CODE-OAUTH-TOKEN": " sk-ant-oat01-provider-secret\n",
      "INPUT_OPENROUTER-API-KEY": "sk-or-provider-secret",
    });

    expect(inputs).toMatchObject({
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      workflowSchemaVersion: 1,
      reviewDrafts: false,
      maxChangedLines: 0,
      reviewTimeoutMinutes: 60,
      providerSecrets: {
        claudeCodeOAuthToken: "sk-ant-oat01-provider-secret",
        openRouterApiKey: "sk-or-provider-secret",
      },
    });
  });

  it("reads an exact boolean draft review action input", () => {
    expect(
      readActionInputs({
        "INPUT_API-URL": "https://api.reviewrouter.site/",
        "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
        "INPUT_REVIEW-DRAFTS": "true",
      }).reviewDrafts,
    ).toBe(true);
    expect(() =>
      readActionInputs({
        "INPUT_API-URL": "https://api.reviewrouter.site/",
        "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
        "INPUT_REVIEW-DRAFTS": "yes",
      }),
    ).toThrow("invalid_boolean_action_input:review-drafts");
  });

  it("reads a non-negative changed-line limit", () => {
    expect(
      readActionInputs({
        "INPUT_API-URL": "https://api.reviewrouter.site/",
        "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
        "INPUT_MAX-CHANGED-LINES": "10000",
      }).maxChangedLines,
    ).toBe(10_000);
    expect(() =>
      readActionInputs({
        "INPUT_API-URL": "https://api.reviewrouter.site/",
        "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
        "INPUT_MAX-CHANGED-LINES": "-1",
      }),
    ).toThrow("invalid_non_negative_integer_action_input:max-changed-lines");
  });

  it("reads a bounded repository review timeout", () => {
    expect(
      readActionInputs({
        "INPUT_API-URL": "https://api.reviewrouter.site/",
        "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
        "INPUT_REVIEW-TIMEOUT-MINUTES": "180",
      }).reviewTimeoutMinutes,
    ).toBe(180);
    for (const value of ["9", "361", "1.5"]) {
      expect(() =>
        readActionInputs({
          "INPUT_API-URL": "https://api.reviewrouter.site/",
          "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
          "INPUT_REVIEW-TIMEOUT-MINUTES": value,
        }),
      ).toThrow(/review-timeout-minutes/);
    }
  });

  it("reads fork agentic sandbox action inputs through the rotating contract", () => {
    const inputs = readActionInputs({
      INPUT_MODE: "fork-agentic-sandbox",
      "INPUT_API-URL": "https://api.reviewrouter.site/",
      "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
      "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
      "INPUT_CLAUDE-CODE-OAUTH-TOKEN": " sk-ant-oat01-provider-secret\n",
    });

    expect(inputs).toMatchObject({
      mode: "fork-agentic-sandbox",
      apiUrl: "https://api.reviewrouter.site",
      providerInstanceId: "codex-rotating:123456",
      workflowSchemaVersion: 1,
      reviewDrafts: false,
      maxChangedLines: 0,
      reviewTimeoutMinutes: 60,
      providerSecrets: {
        claudeCodeOAuthToken: "sk-ant-oat01-provider-secret",
      },
    });
  });

  it("runs fork agentic sandbox review from a sanitized workspace without checkout token", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-fork-test-"));
    const eventPath = join(tempDir, "event.json");
    const githubWorkspace = join(tempDir, "github-workspace");
    const safeWorkspace = join(githubWorkspace, "safe-workspace");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const refreshedAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "refreshed-refresh-token",
        access_token: "refreshed-access-token",
      },
    });
    const invokedUrls: string[] = [];
    const requestBodies: string[] = [];

    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await mkdir(join(safeWorkspace, ".git"), { recursive: true });
    await writeFile(
      join(safeWorkspace, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n",
    );
    await writeFile(
      join(safeWorkspace, "file.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { id: 777, full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "agent-teams-ai/review-router-fork" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "readFileSync(authPath, 'utf8');",
        `writeFileSync(authPath, ${JSON.stringify(refreshedAuthJson)});`,
        "process.stdout.write('OK\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeCodexManifest(fakeCodex);

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      invokedUrls.push(href);
      if (typeof init?.body === "string") {
        requestBodies.push(init.body);
      }
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
          runtimeConfigVersion: 7,
          runtimeEnv: {
            REVIEW_AUTH_MODE: "codex-oauth-rotating",
            REVIEW_PROVIDERS:
              "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
            REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
            SYNTHESIS_MODEL: "codex/gpt-5.5",
            PROVIDER_LIMIT: "3",
            PROVIDER_MAX_PARALLEL: "3",
            INLINE_MIN_AGREEMENT: "2",
            CODEX_MODEL: "gpt-5.5",
            CLAUDE_MODEL: "sonnet",
            OPENROUTER_MODEL: "openai/gpt-5.3-codex",
            EXTRA_RUNTIME_FLAG: "must-not-pass",
          },
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/comment-token")) {
        return jsonResponse({
          token: "ghs_comment_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100"
      ) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    const fullReviewRuntimeRunner = vi.fn(async (input) => {
      expect(input.workspace).toBe(await realpath(safeWorkspace));
      const resolvedGithubWorkspace = await realpath(githubWorkspace);
      expect(input.tempCodexHome).toContain(
        join(resolvedGithubWorkspace, ".reviewrouter-codex-home", "run-"),
      );
      expect(input.tempCodexHome.startsWith(`${safeWorkspace}/`)).toBe(false);
      expect(input.runtimeEnv).toMatchObject({
        REVIEW_PROVIDERS:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
        REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
        SYNTHESIS_MODEL: "codex/gpt-5.5",
        PROVIDER_LIMIT: "3",
        PROVIDER_MAX_PARALLEL: "3",
        INLINE_MIN_AGREEMENT: "2",
        CLAUDE_MODEL: "sonnet",
        CLAUDE_AGENTIC_CONTEXT: "true",
        REVIEWROUTER_FORK_AGENTIC_SANDBOX: "true",
      });
      expect(input.runtimeEnv.OPENROUTER_MODEL).toBeUndefined();
      expect(input.runtimeEnv.EXTRA_RUNTIME_FLAG).toBeUndefined();
      const config = readFileSync(
        join(input.tempCodexHome, "config.toml"),
        "utf8",
      );
      expect(config).toContain('model_provider = "reviewrouter_proxy"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('sandbox_mode = "read-only"');
      expect(config).not.toContain("refreshed-access-token");
      expect(() =>
        readFileSync(join(input.tempCodexHome, "auth.json"), "utf8"),
      ).toThrow();
    });

    try {
      await runCodexRotatingGitHubAction({
        env: {
          INPUT_MODE: "fork-agentic-sandbox",
          "INPUT_API-URL": "https://api.reviewrouter.site/",
          "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
          "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
          "INPUT_AUTH-JSON": JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              refresh_token: "initial-refresh-token",
              access_token: "initial-access-token",
            },
          }),
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          GITHUB_ACTION_PATH: tempDir,
          GITHUB_WORKSPACE: githubWorkspace,
          REVIEW_ROUTER_PR_WORKSPACE: safeWorkspace,
          GITHUB_RUN_ID: "9001",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          ImageOS: "ubuntu24",
          ImageVersion: "20260518.1.0",
          PATH: process.env.PATH ?? "",
        },
        fetchImpl,
        fullReviewRuntimeRunner,
        io: {
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
      });

      expect(fullReviewRuntimeRunner).toHaveBeenCalledTimes(1);
      expect(invokedUrls.some((url) => url.endsWith("/checkout-token"))).toBe(
        false,
      );
      expect(requestBodies.join("\n")).not.toContain("initial-refresh-token");
      expect(requestBodies.join("\n")).not.toContain("refreshed-refresh-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads auth-json as exact bytes and clears auth input env", () => {
    const env = {
      "INPUT_AUTH-JSON": `  {"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh-token"}}\n`,
      INPUT_AUTH_JSON: "fallback",
      REVIEWROUTER_CODEX_AUTH_JSON: "legacy-copy",
    };

    expect(readActionAuthJson(env)).toBe(
      `  {"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh-token"}}\n`,
    );
    expect(env["INPUT_AUTH-JSON"]).toBeUndefined();
    expect(env.INPUT_AUTH_JSON).toBeUndefined();
    expect(env.REVIEWROUTER_CODEX_AUTH_JSON).toBeUndefined();
  });

  it("keeps the legacy Codex refresh path as an explicit rollback switch", () => {
    expect(shouldUseSubscriptionRuntimeCodex({})).toBe(true);
    expect(
      shouldUseSubscriptionRuntimeCodex({
        REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "0",
      }),
    ).toBe(false);
    expect(
      shouldUseSubscriptionRuntimeCodex({
        REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "false",
      }),
    ).toBe(false);
    expect(
      shouldUseSubscriptionRuntimeCodex({
        REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "1",
      }),
    ).toBe(true);
  });

  it("runs scheduled refresh without pull request checkout or comments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-refresh-test-"));
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const invokedUrls: string[] = [];
    const requestBodies: string[] = [];
    const fullReviewRuntimeRunner = vi.fn();

    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "readFileSync(authPath, 'utf8');",
        "writeFileSync(authPath, JSON.stringify({",
        "  auth_mode: 'chatgpt',",
        "  tokens: {",
        "    refresh_token: 'scheduled-refreshed-refresh-token',",
        "    access_token: 'scheduled-refreshed-access-token'",
        "  }",
        "}));",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await writeCodexManifest(fakeCodex);

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      invokedUrls.push(href);
      if (init?.body) {
        requestBodies.push(String(init.body));
      }
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
          runtimeConfigVersion: 7,
          runtimeEnv: {},
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    try {
      await runCodexRotatingGitHubAction({
        env: {
          INPUT_MODE: "codex-oauth-refresh",
          "INPUT_API-URL": "https://api.reviewrouter.site/",
          "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
          "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
          "INPUT_AUTH-JSON": JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              refresh_token: "scheduled-initial-refresh-token",
              access_token: "scheduled-initial-access-token",
            },
          }),
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          GITHUB_RUN_ID: "9001",
          GITHUB_RUN_ATTEMPT: "1",
          PATH: process.env.PATH ?? "",
          ...supportedRunnerEnv(tempDir),
        },
        fetchImpl,
        fullReviewRuntimeRunner,
        io: {
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
      });

      expect(fullReviewRuntimeRunner).not.toHaveBeenCalled();
      expect(invokedUrls.some((url) => url.endsWith("/writeback"))).toBe(true);
      expect(invokedUrls.some((url) => url.endsWith("/checkout-token"))).toBe(
        false,
      );
      expect(invokedUrls.some((url) => url.endsWith("/comment-token"))).toBe(
        false,
      );
      expect(requestBodies.join("\n")).not.toContain(
        "scheduled-initial-refresh-token",
      );
      expect(requestBodies.join("\n")).not.toContain(
        "scheduled-refreshed-refresh-token",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("maps empty auth-json to reconnect before parsing", () => {
    expect(() => readActionAuthJson({ "INPUT_AUTH-JSON": "" })).toThrow(
      "needs_reconnect",
    );
  });

  it("formats top-level action state codes with actionable safe messages", () => {
    expect(formatTopLevelActionErrorMessage(new Error("needs_reconnect"))).toBe(
      "needs_reconnect: Codex OAuth session is expired or revoked. Reconnect the Codex provider in ReviewRouter.",
    );
    expect(formatTopLevelActionErrorMessage(new Error("quota_limited"))).toBe(
      "quota_limited: Codex usage, rate, or billing limit was reached. Add credits, wait for reset, or change account entitlement.",
    );
  });

  it("does not require or read auth-json before GitHub OIDC is available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          },
          fetchImpl: vi.fn() as unknown as typeof fetch,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("github_oidc_unavailable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows only explicitly enabled same-repository drafts from pull_request_target", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-draft-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 240,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: true,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    const baseEnv = {
      "INPUT_API-URL": "https://api.reviewrouter.site/",
      "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "777genius/agent-teams-ai",
    };
    const runtime = {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      io: {
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      },
    };

    try {
      await expect(
        runCodexRotatingGitHubAction({
          ...runtime,
          env: {
            ...baseEnv,
            "INPUT_REVIEW-DRAFTS": "true",
            GITHUB_EVENT_NAME: "pull_request_target",
          },
        }),
      ).rejects.toThrow("github_oidc_unavailable");
      await expect(
        runCodexRotatingGitHubAction({
          ...runtime,
          env: {
            ...baseEnv,
            GITHUB_EVENT_NAME: "pull_request_target",
          },
        }),
      ).rejects.toThrow("draft_pull_request_unsupported");
      await expect(
        runCodexRotatingGitHubAction({
          ...runtime,
          env: {
            ...baseEnv,
            "INPUT_REVIEW-DRAFTS": "true",
            GITHUB_EVENT_NAME: "pull_request",
          },
        }),
      ).rejects.toThrow("draft_pull_request_target_required");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips oversized pull requests before OIDC, auth, or a lease is used", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-size-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 240,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: true,
          additions: 149_137,
          deletions: 31_405,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stdout = { write: vi.fn() };
    const env = {
      "INPUT_API-URL": "https://api.reviewrouter.site/",
      "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
      "INPUT_REVIEW-DRAFTS": "true",
      "INPUT_MAX-CHANGED-LINES": "10000",
      "INPUT_AUTH-JSON": "must-be-cleared-without-being-read",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "777genius/agent-teams-ai",
    };

    try {
      await runCodexRotatingGitHubAction({
        env,
        fetchImpl,
        io: { stdout, stderr: { write: vi.fn() } },
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(env["INPUT_AUTH-JSON"]).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      expect(stdout.write).toHaveBeenCalledWith(
        expect.stringContaining(
          "180542 changed lines exceed the configured maximum of 10000",
        ),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("labels repeated control-plane network failures without exposing auth-json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    let preleaseAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        preleaseAttempts += 1;
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            "INPUT_AUTH-JSON": JSON.stringify({
              auth_mode: "chatgpt",
              tokens: { refresh_token: "must-not-appear" },
            }),
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          },
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("network_request_failed:api_prelease");
      expect(preleaseAttempts).toBe(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("checks the bundled Codex binary before auth-json is read", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    const env = {
      "INPUT_API-URL": "https://api.reviewrouter.site/",
      "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
      "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "777genius/agent-teams-ai",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      ImageOS: "ubuntu24",
      ImageVersion: "20260518.1.0",
    };

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env,
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("missing_github_action_path");
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported runner metadata before auth-json is read", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
            GITHUB_ACTION_PATH: tempDir,
            RUNNER_OS: "macOS",
            RUNNER_ARCH: "X64",
            ImageOS: "ubuntu24",
            ImageVersion: "20260518.1.0",
          },
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("unsupported_runner_os");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces runner startup preflight contract", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-runner-"));
    const env = supportedRunnerEnv(tempDir);

    try {
      await expect(
        assertSupportedRunnerEnvironment(env, { minimumFreeDiskBytes: 1 }),
      ).resolves.toBeUndefined();
      await expect(
        assertSupportedRunnerEnvironment(env, { nodeVersion: "18.20.0" }),
      ).rejects.toThrow("unsupported_node_runtime");
      await expect(
        assertSupportedRunnerEnvironment(
          { ...env, ImageOS: "ubuntu22" },
          { minimumFreeDiskBytes: 1 },
        ),
      ).rejects.toThrow("unsupported_runner_image_os");
      await expect(
        assertSupportedRunnerEnvironment(env, {
          minimumFreeDiskBytes: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow("runner_disk_budget_too_low");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves only the bundled Codex binary path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-bin-"));
    const bundledCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await writeFile(bundledCodex, "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o700,
    });
    await writeCodexManifest(bundledCodex);

    try {
      const resolved = await resolveCodexBinary({
        GITHUB_ACTION_PATH: tempDir,
      });
      expect(resolved).not.toBe(await realpathForTest(bundledCodex));
      expect(readFileSync(resolved, "utf8")).toBe(
        "#!/usr/bin/env bash\nexit 0\n",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a bundled Codex binary when its manifest hash is stale", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-bin-"));
    const bundledCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await writeFile(bundledCodex, "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o700,
    });
    await writeCodexManifest(bundledCodex);
    const archivePath = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex-linux-x64.tgz",
    );
    const archiveBytes = Buffer.from(readFileSync(archivePath));
    archiveBytes[0] = archiveBytes[0] === 0 ? 1 : 0;
    await writeFile(archivePath, archiveBytes);

    try {
      await expect(
        resolveCodexBinary({ GITHUB_ACTION_PATH: tempDir }),
      ).rejects.toThrow("codex_bundled_archive_hash_mismatch");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds a read-only ephemeral Codex command for review", () => {
    const command = buildCodexCommand({
      codexBinaryPath: "/action-dist/codex/linux-x64/codex",
      mode: "review",
      cwd: "/tmp/workspace",
      outputFile: "/tmp/review.md",
    });

    expect(command.command).toBe("/action-dist/codex/linux-x64/codex");
    expect(command.args).not.toContain("npx");
    expect(command.args.join(" ")).not.toContain("@openai/codex");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("read-only");
    expect(command.args).toContain("--ignore-rules");
    expect(command.args).toContain("--ephemeral");
    expect(command.args).toContain("--output-last-message");
    expect(command.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("routes the local provider proxy only through the nonce responses endpoint", () => {
    expect(
      routeCodexLocalProviderRequest({
        method: "POST",
        path: "/nonce-123/v1/responses",
        nonce: "nonce-123",
        bodyBytes: 100,
      }),
    ).toBe("responses");
    expect(
      routeCodexLocalProviderRequest({
        method: "GET",
        path: "/nonce-123/v1/responses",
        nonce: "nonce-123",
        bodyBytes: 100,
      }),
    ).toBe("deny");
    expect(
      routeCodexLocalProviderRequest({
        method: "POST",
        path: "/v1/responses",
        nonce: "nonce-123",
        bodyBytes: 100,
      }),
    ).toBe("deny");
    expect(
      routeCodexLocalProviderRequest({
        method: "POST",
        path: "/nonce-123/v1/models",
        nonce: "nonce-123",
        bodyBytes: 100,
      }),
    ).toBe("deny");
  });

  it("defaults the fork proxy upstream to the ChatGPT Codex backend", () => {
    expect(resolveCodexProxyUpstreamResponsesUrl({})).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(
      resolveCodexProxyUpstreamResponsesUrl({
        REVIEWROUTER_CODEX_RESPONSES_URL: "https://codex-proxy.test/responses",
        REVIEWROUTER_OPENAI_RESPONSES_URL:
          "https://api.openai.test/v1/responses",
      }),
    ).toBe("https://codex-proxy.test/responses");
    expect(
      resolveCodexProxyUpstreamResponsesUrl({
        REVIEWROUTER_OPENAI_RESPONSES_URL:
          "https://api.openai.test/v1/responses",
      }),
    ).toBe("https://api.openai.test/v1/responses");
  });

  it("forwards live local provider proxy responses through nonce-bound loopback only", async () => {
    const upstreamCalls: {
      readonly url: string;
      readonly authorization: string | undefined;
      readonly chatgptAccountId: string | undefined;
      readonly codexBetaFeatures: string | undefined;
      readonly unexpectedHeader: string | undefined;
      readonly body: string;
    }[] = [];
    const proxy = await startCodexLocalProviderProxy({
      accessToken: "proxy-access-token",
      upstreamResponsesUrl: "https://api.openai.test/v1/responses",
      fetchImpl: vi.fn(async (url: string | URL, init?: RequestInit) => {
        upstreamCalls.push({
          url: String(url),
          authorization:
            new Headers(init?.headers).get("authorization") ?? undefined,
          chatgptAccountId:
            new Headers(init?.headers).get("chatgpt-account-id") ?? undefined,
          codexBetaFeatures:
            new Headers(init?.headers).get("x-codex-beta-features") ??
            undefined,
          unexpectedHeader:
            new Headers(init?.headers).get("x-not-forwarded") ?? undefined,
          body:
            init?.body instanceof Uint8Array
              ? Buffer.from(init.body).toString("utf8")
              : String(init?.body ?? ""),
        });
        return new Response(
          JSON.stringify({ id: "resp_1", output_text: "ok" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as unknown as typeof fetch,
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-refreshed-token",
          "chatgpt-account-id": "account-123",
          "content-type": "application/json",
          "x-codex-beta-features": "responses-v1",
          "x-not-forwarded": "blocked",
        },
        body: JSON.stringify({ input: "review" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "resp_1",
      });
      expect(upstreamCalls).toEqual([
        {
          url: "https://api.openai.test/v1/responses",
          authorization: "Bearer codex-refreshed-token",
          chatgptAccountId: "account-123",
          codexBetaFeatures: "responses-v1",
          unexpectedHeader: undefined,
          body: JSON.stringify({ input: "review" }),
        },
      ]);

      const fallbackResponse = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "fallback" }),
      });
      expect(fallbackResponse.status).toBe(200);
      expect(upstreamCalls.at(-1)).toMatchObject({
        authorization: "Bearer proxy-access-token",
        body: JSON.stringify({ input: "fallback" }),
      });

      const denied = await fetch(`${proxy.baseUrl}/models`, {
        method: "POST",
        body: "{}",
      });
      expect(denied.status).toBe(404);
      await expect(denied.json()).resolves.toEqual({
        error: "proxy_route_denied",
      });
      expect(upstreamCalls).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it("redacts token-like values before posting the PR comment", () => {
    const comment = sanitizeReviewComment(
      '<!-- reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567 -->\nFinding\nrefresh_token = "secret-refresh"\naccess_token: secret-access\nid_token: secret-id',
      {
        marker:
          "<!-- reviewrouter:codex-oauth-rotating head=abcdef0123456789abcdef0123456789abcdef01 -->",
      },
    );

    expect(comment).toContain(
      "reviewrouter:codex-oauth-rotating head=abcdef0123456789abcdef0123456789abcdef01",
    );
    expect(comment).not.toContain(
      "reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567",
    );
    expect(comment).not.toContain("secret-refresh");
    expect(comment).not.toContain("secret-access");
    expect(comment).not.toContain("secret-id");
  });

  it("updates an existing head-specific PR comment marker instead of duplicating", async () => {
    const bodies: string[] = [];
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/issues/118/comments?per_page=100")) {
        return jsonResponse([
          {
            id: 123,
            body: "<!-- reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567 -->\nOld review",
          },
        ]);
      }
      if (href.endsWith("/issues/comments/123")) {
        if (typeof init?.body === "string") bodies.push(init.body);
        return jsonResponse({ id: 123 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    await postPullRequestComment({
      fetchImpl,
      token: "ghs_comment_token",
      owner: "777genius",
      repo: "agent-teams-ai",
      issueNumber: 118,
      marker:
        "<!-- reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567 -->",
      body: "<!-- reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567 -->\nNew review",
    });

    expect(methods).toContain(
      "GET https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100",
    );
    expect(methods).toContain(
      "PATCH https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/123",
    );
    expect(methods).not.toContain(
      "POST https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments",
    );
    expect(bodies[0]).toContain("New review");
  });

  it("deletes stale static rotating summary comments before full runtime review", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/issues/118/comments?per_page=100")) {
        return jsonResponse([
          {
            id: 123,
            body: "<!-- reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567 -->\nOld static review",
          },
          {
            id: 456,
            body: "# ReviewRouter\n\nCurrent full runtime summary",
          },
        ]);
      }
      if (href.endsWith("/issues/comments/123")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    await deleteStaleCodexRotatingSummaryComments({
      fetchImpl,
      token: "ghs_comment_token",
      owner: "777genius",
      repo: "agent-teams-ai",
      issueNumber: 118,
    });

    expect(methods).toContain(
      "GET https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100",
    );
    expect(methods).toContain(
      "DELETE https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/123",
    );
    expect(methods).not.toContain(
      "DELETE https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/456",
    );
  });

  it("deletes full runtime progress comments after a successful review", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      methods.push(`${init?.method ?? "GET"} ${href}`);
      if (href.endsWith("/issues/118/comments?per_page=100")) {
        return jsonResponse([
          {
            id: 123,
            body: [
              "## ReviewRouter Progress",
              "",
              "| Step | Status |",
              "| --- | --- |",
              "| Synthesize & report | Done |",
              "<!-- review-router-progress-tracker -->",
            ].join("\n"),
          },
          {
            id: 456,
            body: "# ReviewRouter\n\nCurrent full runtime summary",
          },
        ]);
      }
      if (href.endsWith("/issues/comments/123")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    await deleteFullRuntimeProgressComments({
      fetchImpl,
      token: "ghs_comment_token",
      owner: "777genius",
      repo: "agent-teams-ai",
      issueNumber: 118,
    });

    expect(methods).toContain(
      "GET https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100",
    );
    expect(methods).toContain(
      "DELETE https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/123",
    );
    expect(methods).not.toContain(
      "DELETE https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/456",
    );
  });

  it("runs fork sandbox E2E with certified provider context in the child runtime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-fork-e2e-"));
    const binDir = join(tempDir, "bin");
    const eventPath = join(tempDir, "event.json");
    const githubWorkspace = join(tempDir, "github-workspace");
    const safeWorkspace = join(githubWorkspace, "safe-workspace");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const fakeClaude = join(binDir, "claude");
    const fakeFullRuntime = join(tempDir, "dist", "index.js");
    const runtimeEnvLog = join(tempDir, "fork-runtime-env.json");
    const claudeInstallEnvLog = join(tempDir, "claude-install-env.json");
    const invokedUrls: string[] = [];
    const requestBodies: string[] = [];
    const refreshedAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "refreshed-refresh-token",
        access_token: "refreshed-access-token",
      },
    });

    await mkdir(binDir, { recursive: true });
    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await mkdir(join(safeWorkspace, ".git"), { recursive: true });
    await writeFile(
      join(safeWorkspace, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n",
    );
    await writeFile(
      join(safeWorkspace, "file.ts"),
      "import { related } from './related';\nexport const value = related;\n",
    );
    await writeFile(
      join(safeWorkspace, "related.ts"),
      "export const related = 1;\n",
    );
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { id: 777, full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "external-contributor/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "readFileSync(authPath, 'utf8');",
        `writeFileSync(authPath, ${JSON.stringify(refreshedAuthJson)});`,
        "process.stdout.write('OK\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeCodexManifest(fakeCodex);
    await writeFile(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(claudeInstallEnvLog)}, JSON.stringify({`,
        "  cwd: process.cwd(),",
        "  githubToken: process.env.GITHUB_TOKEN,",
        "  claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,",
        "  openrouterKey: process.env.OPENROUTER_API_KEY,",
        "  path: process.env.PATH,",
        "}));",
        "process.stdout.write('claude 1.0.0\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeFile(
      fakeFullRuntime,
      [
        "#!/usr/bin/env node",
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const configPath = join(process.env.CODEX_HOME, 'config.toml');",
        "const config = readFileSync(configPath, 'utf8');",
        `writeFileSync(${JSON.stringify(runtimeEnvLog)}, JSON.stringify({`,
        "  cwd: process.cwd(),",
        "  githubWorkspace: process.env.GITHUB_WORKSPACE,",
        "  safeFileExists: existsSync(join(process.cwd(), 'file.ts')),",
        "  relatedFileExists: existsSync(join(process.cwd(), 'related.ts')),",
        "  authExists: existsSync(join(process.env.CODEX_HOME, 'auth.json')),",
        "  configIncludesProxy: config.includes('model_provider = \"reviewrouter_proxy\"'),",
        "  configIncludesApprovalNever: config.includes('approval_policy = \"never\"'),",
        "  configIncludesReadOnly: config.includes('sandbox_mode = \"read-only\"'),",
        "  configIncludesToken: config.includes('refreshed-access-token'),",
        "  providers: process.env.REVIEW_PROVIDERS,",
        "  requiredHealthyProviders: process.env.REQUIRED_HEALTHY_PROVIDERS,",
        "  synthesisModel: process.env.SYNTHESIS_MODEL,",
        "  providerLimit: process.env.PROVIDER_LIMIT,",
        "  providerMaxParallel: process.env.PROVIDER_MAX_PARALLEL,",
        "  inlineMinAgreement: process.env.INLINE_MIN_AGREEMENT,",
        "  claudeAgenticContext: process.env.CLAUDE_AGENTIC_CONTEXT,",
        "  forkFlag: process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX,",
        "  reviewAuthMode: process.env.REVIEW_AUTH_MODE,",
        "  githubToken: process.env.GITHUB_TOKEN,",
        "  claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,",
        "  openrouterKey: process.env.OPENROUTER_API_KEY,",
        "  inheritedOpenAi: process.env.OPENAI_API_KEY,",
        "  inheritedGemini: process.env.GEMINI_API_KEY,",
        "  inheritedOpenCode: process.env.OPENCODE_API_KEY,",
        "  inheritedNpmToken: process.env.NPM_TOKEN,",
        "  inheritedCustomSecret: process.env.CUSTOM_SECRET,",
        "  inheritedPrivateKey: process.env.PRIVATE_KEY,",
        "  inheritedPassword: process.env.DB_PASSWORD,",
        "  inheritedInputMode: process.env.INPUT_MODE,",
        "  inheritedInputClaude: process.env['INPUT_CLAUDE-CODE-OAUTH-TOKEN'] || process.env.INPUT_CLAUDE_CODE_OAUTH_TOKEN,",
        "  inheritedInputOpenRouter: process.env['INPUT_OPENROUTER-API-KEY'] || process.env.INPUT_OPENROUTER_API_KEY,",
        "  inheritedOidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,",
        "  openrouterModel: process.env.OPENROUTER_MODEL,",
        "  extraRuntimeFlag: process.env.EXTRA_RUNTIME_FLAG,",
        "  runtimeConfigVersion: process.env.REVIEWROUTER_CONFIG_VERSION,",
        "}));",
        "process.stdout.write('fork runtime marker\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await chmod(fakeClaude, 0o700);
    await chmod(fakeFullRuntime, 0o700);

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      invokedUrls.push(href);
      if (typeof init?.body === "string") {
        requestBodies.push(init.body);
      }
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
          runtimeConfigVersion: 7,
          runtimeEnv: {
            REVIEW_AUTH_MODE: "codex-oauth-rotating",
            REVIEW_PROVIDERS:
              "gemini/gemini-2.0, codex/gpt-5.5, claude/sonnet, openrouter/openai/gpt-5.3-codex, opencode/qwen",
            REQUIRED_HEALTHY_PROVIDERS:
              "gemini/gemini-2.0,claude/sonnet,openrouter/openai/gpt-5.3-codex",
            SYNTHESIS_MODEL: "openrouter/openai/gpt-5.3-codex",
            PROVIDER_LIMIT: "9",
            PROVIDER_MAX_PARALLEL: "8",
            INLINE_MIN_AGREEMENT: "7",
            CODEX_MODEL: "gpt-5.5",
            CLAUDE_MODEL: "sonnet",
            OPENROUTER_MODEL: "openai/gpt-5.3-codex",
            EXTRA_RUNTIME_FLAG: "must-not-pass",
          },
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/comment-token")) {
        return jsonResponse({
          token: "ghs_comment_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100"
      ) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();

    try {
      await runCodexRotatingGitHubAction({
        env: {
          INPUT_MODE: "fork-agentic-sandbox",
          "INPUT_API-URL": "https://api.reviewrouter.site/",
          "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
          "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
          "INPUT_CLAUDE-CODE-OAUTH-TOKEN": "sk-ant-oat01-claude-input",
          "INPUT_OPENROUTER-API-KEY": "sk-or-input",
          "INPUT_AUTH-JSON": JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              refresh_token: "initial-refresh-token",
              access_token: "initial-access-token",
            },
          }),
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          GITHUB_WORKSPACE: githubWorkspace,
          REVIEW_ROUTER_PR_WORKSPACE: safeWorkspace,
          GITHUB_RUN_ID: "9001",
          GITHUB_RUN_ATTEMPT: "1",
          OPENAI_API_KEY: "sk-runner-openai-key",
          GEMINI_API_KEY: "sk-gemini-inherited",
          OPENCODE_API_KEY: "sk-opencode-inherited",
          NPM_TOKEN: "npm-token-inherited",
          CUSTOM_SECRET: "custom-secret-inherited",
          PRIVATE_KEY: "private-key-inherited",
          DB_PASSWORD: "db-password-inherited",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-inherited",
          OPENROUTER_API_KEY: "sk-or-inherited",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          ...supportedRunnerEnv(tempDir),
        },
        fetchImpl,
        io: {
          stdout: { write: stdoutWrite },
          stderr: { write: stderrWrite },
        },
      });

      const serializedRequests = requestBodies.join("\n");
      expect(serializedRequests).not.toContain("initial-refresh-token");
      expect(serializedRequests).not.toContain("refreshed-refresh-token");
      expect(serializedRequests).not.toContain("sk-ant-oat01-claude-input");
      expect(serializedRequests).not.toContain("sk-or-input");
      expect(invokedUrls.some((url) => url.endsWith("/checkout-token"))).toBe(
        false,
      );
      expect(invokedUrls.some((url) => url.endsWith("/comment-token"))).toBe(
        true,
      );
      expect(
        invokedUrls.filter((url) =>
          url.endsWith("/api/action/v1/codex-oauth/writeback"),
        ),
      ).toHaveLength(1);

      const resolvedSafeWorkspace = await realpath(safeWorkspace);
      const reviewEnv = JSON.parse(
        readFileSync(runtimeEnvLog, "utf8"),
      ) as Record<string, unknown>;
      expect(reviewEnv).toMatchObject({
        cwd: resolvedSafeWorkspace,
        githubWorkspace: resolvedSafeWorkspace,
        safeFileExists: true,
        relatedFileExists: true,
        authExists: false,
        configIncludesProxy: true,
        configIncludesApprovalNever: true,
        configIncludesReadOnly: true,
        configIncludesToken: false,
        providers:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
        requiredHealthyProviders:
          "claude/sonnet,openrouter/openai/gpt-5.3-codex",
        synthesisModel: "openrouter/openai/gpt-5.3-codex",
        providerLimit: "3",
        providerMaxParallel: "3",
        inlineMinAgreement: "3",
        claudeAgenticContext: "true",
        forkFlag: "true",
        reviewAuthMode: "codex-oauth",
        githubToken: "ghs_comment_token",
        claudeToken: "sk-ant-oat01-claude-input",
        openrouterKey: "sk-or-input",
        runtimeConfigVersion: "7",
      });
      expect(reviewEnv.inheritedOpenAi).toBeUndefined();
      expect(reviewEnv.inheritedGemini).toBeUndefined();
      expect(reviewEnv.inheritedOpenCode).toBeUndefined();
      expect(reviewEnv.inheritedNpmToken).toBeUndefined();
      expect(reviewEnv.inheritedCustomSecret).toBeUndefined();
      expect(reviewEnv.inheritedPrivateKey).toBeUndefined();
      expect(reviewEnv.inheritedPassword).toBeUndefined();
      expect(reviewEnv.inheritedInputMode).toBeUndefined();
      expect(reviewEnv.inheritedInputClaude).toBeUndefined();
      expect(reviewEnv.inheritedInputOpenRouter).toBeUndefined();
      expect(reviewEnv.inheritedOidc).toBeUndefined();
      expect(reviewEnv.openrouterModel).toBeUndefined();
      expect(reviewEnv.extraRuntimeFlag).toBeUndefined();

      const claudeInstallEnv = JSON.parse(
        readFileSync(claudeInstallEnvLog, "utf8"),
      ) as Record<string, unknown>;
      expect(claudeInstallEnv.githubToken).toBeUndefined();
      expect(claudeInstallEnv.claudeToken).toBeUndefined();
      expect(claudeInstallEnv.openrouterKey).toBeUndefined();
      expect(
        stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("fork runtime marker");
      expect(stderrWrite).not.toHaveBeenCalledWith(
        expect.stringContaining("refreshed-access-token"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the local action E2E with only explicit hybrid provider secrets in child runtime env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-e2e-"));
    const binDir = join(tempDir, "bin");
    const eventPath = join(tempDir, "event.json");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const fakeGit = join(binDir, "git");
    const fakeClaude = join(binDir, "claude");
    const fakeFullRuntime = join(tempDir, "dist", "index.js");
    const gitEnvLog = join(tempDir, "git-env.log");
    const codexReviewEnvLog = join(tempDir, "codex-review-env.log");
    const claudeInstallEnvLog = join(tempDir, "claude-install-env.log");
    const requestBodies: string[] = [];
    const invokedUrls: string[] = [];
    const pullRequestAuthorizationHeaders: string[] = [];
    const refreshedAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "refreshed-refresh-token",
        access_token: "refreshed-access-token",
      },
    });

    await mkdir(binDir, { recursive: true });
    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(
      eventPath,
      JSON.stringify({
        number: 118,
        repository: { full_name: "777genius/agent-teams-ai" },
        pull_request: {
          draft: false,
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            repo: { full_name: "777genius/agent-teams-ai" },
          },
          base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
        },
      }),
    );
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "(async () => {",
        "  const args = process.argv.slice(2);",
        "  const outputIndex = args.indexOf('--output-last-message');",
        "  if (outputIndex >= 0) {",
        "    const configPath = join(process.env.CODEX_HOME, 'config.toml');",
        "    const config = readFileSync(configPath, 'utf8');",
        `    writeFileSync(${JSON.stringify(codexReviewEnvLog)}, JSON.stringify({`,
        "      codexHome: process.env.CODEX_HOME,",
        "      home: process.env.HOME,",
        "      authExists: existsSync(join(process.env.CODEX_HOME, 'auth.json')),",
        "      configIncludesProxy: config.includes('model_provider = \"reviewrouter_proxy\"'),",
        "      configIncludesApprovalNever: config.includes('approval_policy = \"never\"'),",
        "      configIncludesReadOnly: config.includes('sandbox_mode = \"read-only\"'),",
        "      configIncludesShellSnapshotDisabled: config.includes('shell_snapshot = false'),",
        "      configIncludesToken: config.includes('refreshed-access-token'),",
        "      inheritedOpenAi: process.env.OPENAI_API_KEY,",
        "    }));",
        "    writeFileSync(args[outputIndex + 1], 'Review done without blockers. access_token: should-be-redacted');",
        "    process.exit(2);",
        "  }",
        "  const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "  readFileSync(authPath, 'utf8');",
        `  writeFileSync(authPath, ${JSON.stringify(refreshedAuthJson)});`,
        "})().catch((error) => {",
        "  process.stderr.write(String(error && error.stack ? error.stack : error));",
        "  process.exit(1);",
        "});",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeCodexManifest(fakeCodex);
    await writeFile(
      fakeGit,
      [
        "#!/usr/bin/env node",
        "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
        "let args = process.argv.slice(2);",
        "while (args[0] === '-c') args = args.slice(2);",
        "const command = args[0];",
        "if (process.env.REVIEWROUTER_GIT_ENV_LOG) {",
        "  appendFileSync(process.env.REVIEWROUTER_GIT_ENV_LOG, JSON.stringify({",
        "    command,",
        "    args,",
        "    gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,",
        "    gitConfigSystem: process.env.GIT_CONFIG_SYSTEM,",
        "    gitConfigCount: process.env.GIT_CONFIG_COUNT,",
        "    inheritedGitTrace: process.env.GIT_TRACE,",
        "    lfsSkipSmudge: process.env.GIT_LFS_SKIP_SMUDGE,",
        "    tokenInArgs: args.join(' ').includes(process.env.REVIEWROUTER_CHECKOUT_TOKEN || 'not-set'),",
        "  }) + '\\n');",
        "}",
        "if (command === 'init') {",
        "  mkdirSync('.git', { recursive: true });",
        "  writeFileSync('.git/config', '[core]\\n\\trepositoryformatversion = 0\\n');",
        "}",
        "if (command === 'remote' && args[1] === 'add') {",
        "  appendFileSync('.git/config', `[remote \"${args[2]}\"]\\n\\turl = ${args[3]}\\n`);",
        "}",
        "if (command === 'diff') {",
        "  process.stdout.write('diff --git a/file.ts b/file.ts\\n+const value = 1;\\n');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeFile(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(claudeInstallEnvLog)}, JSON.stringify({`,
        "  githubToken: process.env.GITHUB_TOKEN,",
        "  claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,",
        "  openrouterKey: process.env.OPENROUTER_API_KEY,",
        "  home: process.env.HOME,",
        "  path: process.env.PATH,",
        "}));",
        "process.stdout.write('claude 1.0.0\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeFile(
      fakeFullRuntime,
      [
        "#!/usr/bin/env node",
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const codexBin = join((process.env.PATH || '').split(':')[0] || '', 'codex');",
        "const configPath = join(process.env.CODEX_HOME, 'config.toml');",
        "const config = readFileSync(configPath, 'utf8');",
        `writeFileSync(${JSON.stringify(codexReviewEnvLog)}, JSON.stringify({`,
        "  codexHome: process.env.CODEX_HOME,",
        "  home: process.env.HOME,",
        "  authExists: existsSync(join(process.env.CODEX_HOME, 'auth.json')),",
        "  codexBinExists: existsSync(codexBin),",
        "  configIncludesProxy: config.includes('model_provider = \"reviewrouter_proxy\"'),",
        "  configIncludesApprovalNever: config.includes('approval_policy = \"never\"'),",
        "  configIncludesReadOnly: config.includes('sandbox_mode = \"read-only\"'),",
        "  configIncludesShellSnapshotDisabled: config.includes('shell_snapshot = false'),",
        "  configIncludesToken: config.includes('refreshed-access-token'),",
        "  inheritedOpenAi: process.env.OPENAI_API_KEY,",
        "  claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,",
        "  openrouterKey: process.env.OPENROUTER_API_KEY,",
        "  inheritedInputClaude: process.env['INPUT_CLAUDE-CODE-OAUTH-TOKEN'] || process.env.INPUT_CLAUDE_CODE_OAUTH_TOKEN,",
        "  inheritedInputOpenRouter: process.env['INPUT_OPENROUTER-API-KEY'] || process.env.INPUT_OPENROUTER_API_KEY,",
        "  inheritedOidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,",
        "  githubToken: process.env.GITHUB_TOKEN,",
        "  githubOutput: process.env.GITHUB_OUTPUT,",
        "  githubOutputInsideHome: Boolean(process.env.GITHUB_OUTPUT && process.env.GITHUB_OUTPUT.startsWith(process.env.HOME + '/')),",
        "  prNumber: process.env.PR_NUMBER,",
        "  reviewAuthMode: process.env.REVIEW_AUTH_MODE,",
        "  codexAgenticAudit: process.env.CODEX_AGENTIC_AUDIT,",
        "  failOnNoHealthyProviders: process.env.FAIL_ON_NO_HEALTHY_PROVIDERS,",
        "  providers: process.env.REVIEW_PROVIDERS,",
        "  runtimeMode: process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE,",
        "  commentTokenMode: process.env.REVIEWROUTER_COMMENT_TOKEN_MODE,",
        "  commentTokenRefreshUrl: process.env.REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL,",
        "  commentTokenLeaseId: process.env.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,",
        "  commentTokenProviderInstanceId: process.env.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,",
        "  scmProvider: process.env.REVIEWROUTER_SCM_PROVIDER,",
        "  findingsArtifactPath: process.env.REVIEWROUTER_FINDINGS_ARTIFACT_PATH,",
        "  repositoryFullName: process.env.REVIEWROUTER_REPOSITORY_FULL_NAME,",
        "  changeRequestExternalId: process.env.REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID,",
        "  reviewHeadSha: process.env.REVIEWROUTER_HEAD_SHA,",
        "  reviewBaseSha: process.env.REVIEWROUTER_BASE_SHA,",
        "  reviewMarker: process.env.REVIEWROUTER_REVIEW_MARKER,",
        "  runtimeConfigVersion: process.env.REVIEWROUTER_CONFIG_VERSION,",
        "  snapshotInputPath: process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH,",
        "  snapshotOutputPath: process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH,",
        "  checkpointFinalizationPath: process.env.REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH,",
        "  snapshotRequired: process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_REQUIRED,",
        "}));",
        "if (process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH) {",
        "  const restored = JSON.parse(readFileSync(process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH, 'utf8'));",
        "  writeFileSync(process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH, JSON.stringify({",
        "    protocolVersion: 1,",
        "    expectedVersion: restored.expectedVersion,",
        "    pullRequestNumber: Number(process.env.PR_NUMBER),",
        "    schemaVersion: 1,",
        "    reviewedHeadSha: process.env.REVIEWROUTER_HEAD_SHA,",
        "    baseSha: process.env.REVIEWROUTER_BASE_SHA,",
        `    compatibilityKey: ${JSON.stringify("c".repeat(64))},`,
        "    payload: { reviewSummary: 'Review complete', findings: [] },",
        "  }));",
        "}",
        "if (process.env.REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH) {",
        "  writeFileSync(process.env.REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH, JSON.stringify({",
        "    protocolVersion: 1,",
        "    pullRequestNumber: Number(process.env.PR_NUMBER),",
        "    headSha: process.env.REVIEWROUTER_HEAD_SHA,",
        `    planHash: ${JSON.stringify("d".repeat(64))},`,
        "    expectedVersion: 9,",
        "  }));",
        "}",
        "process.stdout.write('runtime marker visible\\n');",
        "process.stdout.write('refresh_token: refreshed-refresh-token access_token=refreshed-access-token Bearer ghs_comment_token auth.json=/tmp/private/auth.json\\n');",
        "process.stderr.write('runtime stderr marker Bearer refreshed-access-token\\n');",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await chmod(fakeGit, 0o700);
    await chmod(fakeClaude, 0o700);
    await chmod(fakeFullRuntime, 0o700);

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      invokedUrls.push(href);
      if (typeof init?.body === "string") {
        requestBodies.push(init.body);
      }
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
          runtimeConfigVersion: 7,
          runtimeEnv: {
            REVIEW_AUTH_MODE: "codex-oauth-rotating",
            REVIEW_PROVIDERS:
              "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
            REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
            SYNTHESIS_MODEL: "codex/gpt-5.5",
            PROVIDER_LIMIT: "3",
            PROVIDER_MAX_PARALLEL: "3",
            INLINE_MAX_COMMENTS: "10",
            INLINE_MIN_AGREEMENT: "2",
            TARGET_TOKENS_PER_BATCH: "90000",
            FAIL_ON_SEVERITY: "critical",
            CODEX_MODEL: "gpt-5.5",
            CODEX_REASONING_EFFORT: "high",
            CODEX_AGENTIC_CONTEXT: "true",
            CLAUDE_MODEL: "sonnet",
            CLAUDE_AGENTIC_CONTEXT: "true",
          },
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/checkout-token")) {
        return jsonResponse({
          token: "ghs_checkout_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/review-snapshot/restore")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "found",
          expectedVersion: 4,
          snapshot: {
            version: 4,
            schemaVersion: 1,
            reviewedHeadSha: "f".repeat(40),
            baseSha: "abcdef0123456789abcdef0123456789abcdef01",
            compatibilityKey: "c".repeat(64),
            payload: { reviewSummary: "Previous review", findings: [] },
            reviewedAt: "2026-07-16T10:00:00.000Z",
            expiresAt: "2099-07-23T10:00:00.000Z",
          },
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/comment-token")) {
        return jsonResponse({
          token: "ghs_comment_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href.endsWith("/api/action/v1/codex-oauth/review-snapshot/head-token")
      ) {
        return jsonResponse({
          token: "ghs_snapshot_head_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/pulls/118"
      ) {
        pullRequestAuthorizationHeaders.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return jsonResponse({
          head: { sha: "0123456789abcdef0123456789abcdef01234567" },
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/review-snapshot/commit")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "committed",
          version: 1,
          reviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        });
      }
      if (
        href.endsWith(
          "/api/action/v1/codex-oauth/review-execution-checkpoint/clear",
        )
      ) {
        return jsonResponse({ protocolVersion: 1, status: "cleared" });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100"
      ) {
        return jsonResponse([
          {
            id: 123,
            body: "<!-- reviewrouter:codex-oauth-rotating head=old -->\nOld static review",
          },
        ]);
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/123"
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();

    try {
      await runCodexRotatingGitHubAction({
        env: {
          "INPUT_API-URL": "https://api.reviewrouter.site/",
          "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
          "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
          "INPUT_CLAUDE-CODE-OAUTH-TOKEN": "sk-ant-oat01-claude-input",
          "INPUT_OPENROUTER-API-KEY": "sk-or-input",
          "INPUT_AUTH-JSON": JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              refresh_token: "initial-refresh-token",
              access_token: "initial-access-token",
            },
          }),
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "777genius/agent-teams-ai",
          GITHUB_ACTION_PATH: tempDir,
          GITHUB_RUN_ID: "9001",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          ImageOS: "ubuntu24",
          ImageVersion: "20260518.1.0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
          GIT_CONFIG_VALUE_0: "https://github.com/",
          GIT_TRACE: "1",
          REVIEWROUTER_GIT_ENV_LOG: gitEnvLog,
          OPENAI_API_KEY: "sk-runner-openai-key",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-inherited",
          OPENROUTER_API_KEY: "sk-or-inherited",
          REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "1",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        fetchImpl,
        io: {
          stdout: { write: stdoutWrite },
          stderr: { write: stderrWrite },
        },
      });

      const serializedRequests = requestBodies.join("\n");
      expect(serializedRequests).not.toContain("initial-refresh-token");
      expect(serializedRequests).not.toContain("refreshed-refresh-token");
      expect(serializedRequests).not.toContain("sk-ant-oat01-claude-input");
      expect(serializedRequests).not.toContain("sk-or-input");
      expect(
        invokedUrls.some(
          (url) =>
            url ===
            "https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments",
        ),
      ).toBe(false);
      expect(invokedUrls).toContain(
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/comments/123",
      );
      expect(
        invokedUrls.filter((url) =>
          url.endsWith("/api/action/v1/codex-oauth/writeback"),
        ),
      ).toHaveLength(1);
      expect(
        invokedUrls.some((url) => url.endsWith("/review-snapshot/restore")),
      ).toBe(true);
      expect(
        invokedUrls.some((url) => url.endsWith("/review-snapshot/commit")),
      ).toBe(true);
      expect(
        invokedUrls.some((url) => url.endsWith("/review-snapshot/head-token")),
      ).toBe(true);
      const snapshotCommitIndex = invokedUrls.findIndex((url) =>
        url.endsWith("/review-snapshot/commit"),
      );
      const checkpointClearIndex = invokedUrls.findIndex((url) =>
        url.endsWith("/review-execution-checkpoint/clear"),
      );
      expect(snapshotCommitIndex).toBeGreaterThanOrEqual(0);
      expect(checkpointClearIndex).toBeGreaterThan(snapshotCommitIndex);
      expect(pullRequestAuthorizationHeaders).toEqual([
        "Bearer ghs_snapshot_head_token",
      ]);
      const snapshotCommitBody = requestBodies
        .map((body) => JSON.parse(body) as Record<string, unknown>)
        .find((body) => body.compatibilityKey === "c".repeat(64));
      expect(snapshotCommitBody).toMatchObject({
        protocolVersion: 1,
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        expectedVersion: 4,
        pullRequestNumber: 118,
      });
      const checkpointClearBody = requestBodies
        .map((body) => JSON.parse(body) as Record<string, unknown>)
        .find((body) => body.planHash === "d".repeat(64));
      expect(checkpointClearBody).toEqual({
        protocolVersion: 1,
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 118,
        expectedVersion: 9,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        planHash: "d".repeat(64),
      });
      const reviewEnv = JSON.parse(
        readFileSync(codexReviewEnvLog, "utf8"),
      ) as Record<string, unknown>;
      expect(reviewEnv).toMatchObject({
        authExists: true,
        codexBinExists: true,
        configIncludesProxy: false,
        configIncludesApprovalNever: true,
        configIncludesReadOnly: true,
        configIncludesShellSnapshotDisabled: true,
        configIncludesToken: false,
        githubToken: "ghs_comment_token",
        githubOutputInsideHome: true,
        prNumber: "118",
        reviewAuthMode: "codex-oauth",
        codexAgenticAudit: "rerun",
        failOnNoHealthyProviders: "true",
        providers:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
        runtimeMode: "static",
        commentTokenMode: "github-token",
        commentTokenRefreshUrl:
          "https://api.reviewrouter.site/api/action/v1/codex-oauth/comment-token",
        commentTokenLeaseId: "lease_1",
        commentTokenProviderInstanceId: "codex-rotating:123456",
        scmProvider: "github",
        findingsArtifactPath: "reviewrouter-findings.json",
        repositoryFullName: "777genius/agent-teams-ai",
        changeRequestExternalId: "118",
        reviewHeadSha: "0123456789abcdef0123456789abcdef01234567",
        reviewBaseSha: "abcdef0123456789abcdef0123456789abcdef01",
        reviewMarker:
          "reviewrouter:codex-oauth-rotating head=0123456789abcdef0123456789abcdef01234567",
        runtimeConfigVersion: "7",
        snapshotInputPath: expect.stringContaining(
          "incremental-snapshot-input.json",
        ),
        snapshotOutputPath: expect.stringContaining(
          "incremental-snapshot-output.json",
        ),
        checkpointFinalizationPath: expect.stringContaining(
          "review-checkpoint-finalization.json",
        ),
        snapshotRequired: "true",
      });
      expect(reviewEnv.inheritedOpenAi).toBeUndefined();
      expect(reviewEnv.claudeToken).toBe("sk-ant-oat01-claude-input");
      expect(reviewEnv.openrouterKey).toBe("sk-or-input");
      expect(reviewEnv.inheritedInputClaude).toBeUndefined();
      expect(reviewEnv.inheritedInputOpenRouter).toBeUndefined();
      expect(reviewEnv.inheritedOidc).toBeUndefined();
      const claudeInstallEnv = JSON.parse(
        readFileSync(claudeInstallEnvLog, "utf8"),
      ) as Record<string, unknown>;
      expect(claudeInstallEnv.githubToken).toBeUndefined();
      expect(claudeInstallEnv.claudeToken).toBeUndefined();
      expect(claudeInstallEnv.openrouterKey).toBeUndefined();
      expect(claudeInstallEnv.home).toBe(reviewEnv.home);
      expect(String(reviewEnv.githubOutput)).toContain("github-output");
      const childStdout = stdoutWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      const childStderr = stderrWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      const runtimeStdout = childStdout.slice(
        childStdout.indexOf("runtime marker visible"),
      );
      expect(runtimeStdout).toContain("runtime marker visible");
      expect(childStderr).toContain("runtime stderr marker");
      expect(childStdout).toContain("::add-mask::sk-ant-oat01-claude-input");
      expect(childStdout).toContain("::add-mask::sk-or-input");
      expect(runtimeStdout).not.toContain("refreshed-refresh-token");
      expect(runtimeStdout).not.toContain("refreshed-access-token");
      expect(childStderr).not.toContain("refreshed-access-token");
      expect(runtimeStdout).not.toContain("ghs_comment_token");
      expect(runtimeStdout).not.toContain("/tmp/private/auth.json");
      const gitEnvEntries = readFileSync(gitEnvLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const fetchEntry = gitEnvEntries.find(
        (entry) => entry.command === "fetch",
      );
      expect(fetchEntry).toMatchObject({
        command: "fetch",
        gitConfigGlobal: "/dev/null",
        gitConfigSystem: "/dev/null",
        gitConfigCount: "7",
        lfsSkipSmudge: "1",
        tokenInArgs: false,
      });
      expect(fetchEntry).not.toHaveProperty("inheritedGitTrace");
      expect(
        gitEnvEntries.some(
          (entry) =>
            entry.command === "fetch" &&
            Array.isArray(entry.args) &&
            entry.args.includes("f".repeat(40)),
        ),
      ).toBe(true);
      const remoteIndex = gitEnvEntries.findIndex(
        (entry) => entry.command === "remote",
      );
      const previousHeadFetchIndex = gitEnvEntries.findIndex(
        (entry) =>
          entry.command === "fetch" &&
          Array.isArray(entry.args) &&
          entry.args.includes("f".repeat(40)),
      );
      expect(remoteIndex).toBeGreaterThanOrEqual(0);
      expect(previousHeadFetchIndex).toBeGreaterThan(remoteIndex);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate top-level errors when full runtime already reported findings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-e2e-"));
    const binDir = join(tempDir, "bin");
    const eventPath = join(tempDir, "event.json");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const fakeGit = join(binDir, "git");
    const fakeFullRuntime = join(tempDir, "dist", "index.js");
    const invokedUrls: string[] = [];

    await mkdir(binDir, { recursive: true });
    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writePullRequestEvent(eventPath);
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "readFileSync(authPath, 'utf8');",
        "writeFileSync(authPath, JSON.stringify({",
        "  auth_mode: 'chatgpt',",
        "  tokens: {",
        "    refresh_token: 'refreshed-refresh-token',",
        "    access_token: 'refreshed-access-token'",
        "  }",
        "}));",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeCodexManifest(fakeCodex);
    await writeFile(
      fakeGit,
      [
        "#!/usr/bin/env node",
        "const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');",
        "let args = process.argv.slice(2);",
        "while (args[0] === '-c') args = args.slice(2);",
        "const command = args[0];",
        "if (command === 'init') {",
        "  mkdirSync('.git', { recursive: true });",
        "  writeFileSync('.git/config', '[core]\\n\\trepositoryformatversion = 0\\n');",
        "}",
        "if (command === 'remote' && args[1] === 'add') {",
        "  appendFileSync('.git/config', `[remote \"${args[2]}\"]\\n\\turl = ${args[3]}\\n`);",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await writeFile(
      fakeFullRuntime,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const restored = JSON.parse(readFileSync(process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH, 'utf8'));",
        "writeFileSync(process.env.REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH, JSON.stringify({",
        "  protocolVersion: 1,",
        "  expectedVersion: restored.expectedVersion,",
        "  pullRequestNumber: Number(process.env.PR_NUMBER),",
        "  schemaVersion: 1,",
        "  reviewedHeadSha: process.env.REVIEWROUTER_HEAD_SHA,",
        "  baseSha: process.env.REVIEWROUTER_BASE_SHA,",
        `  compatibilityKey: ${JSON.stringify("c".repeat(64))},`,
        "  payload: { reviewSummary: 'Blocking review complete', findings: [] },",
        "}));",
        "writeFileSync(process.env.REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH, JSON.stringify({",
        "  protocolVersion: 1,",
        "  pullRequestNumber: Number(process.env.PR_NUMBER),",
        "  headSha: process.env.REVIEWROUTER_HEAD_SHA,",
        `  planHash: ${JSON.stringify("d".repeat(64))},`,
        "  expectedVersion: 9,",
        "  snapshotAdvancementRequired: true,",
        "}));",
        "process.stderr.write('::error::ReviewRouter found 2 major+ finding(s). Review comments were posted before failing this check.\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await chmod(fakeGit, 0o700);
    await chmod(fakeFullRuntime, 0o700);

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      invokedUrls.push(href);
      if (
        href.endsWith("/api/action/v1/codex-oauth/review-snapshot/head-token")
      ) {
        return jsonResponse({
          token: "ghs_snapshot_head_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/pulls/118"
      ) {
        return jsonResponse({
          head: { sha: "0123456789abcdef0123456789abcdef01234567" },
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/review-snapshot/commit")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "committed",
          version: 1,
          reviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
        });
      }
      if (
        href.endsWith(
          "/api/action/v1/codex-oauth/review-execution-checkpoint/clear",
        )
      ) {
        return jsonResponse({ protocolVersion: 1, status: "cleared" });
      }
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
          runtimeConfigVersion: 7,
          runtimeEnv: {},
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/checkout-token")) {
        return jsonResponse({
          token: "ghs_checkout_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/comment-token")) {
        return jsonResponse({
          token: "ghs_comment_token",
          repository: "777genius/agent-teams-ai",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/issues/118/comments?per_page=100"
      ) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();

    try {
      let thrown: unknown;
      try {
        await runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            "INPUT_AUTH-JSON": JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                refresh_token: "initial-refresh-token",
                access_token: "initial-access-token",
              },
            }),
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
            GITHUB_RUN_ID: "9001",
            GITHUB_RUN_ATTEMPT: "1",
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            ...supportedRunnerEnv(tempDir),
          },
          fetchImpl,
          io: {
            stdout: { write: stdoutWrite },
            stderr: { write: stderrWrite },
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(shouldSuppressTopLevelActionError(thrown)).toBe(true);
      expect(invokedUrls.some((url) => url.endsWith("/comment-token"))).toBe(
        true,
      );
      expect(
        invokedUrls.some((url) => url.endsWith("/review-snapshot/commit")),
      ).toBe(true);
      expect(
        invokedUrls.some((url) =>
          url.endsWith("/review-execution-checkpoint/clear"),
        ),
      ).toBe(true);

      const childStdout = stdoutWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      const childStderr = stderrWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      const streamedText = `${childStdout}\n${childStderr}`;
      expect(
        streamedText.match(/ReviewRouter found 2 major\+ finding\(s\)/g) ?? [],
      ).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stops before checkout when subscription-runtime refreshed writeback is not confirmed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const invokedUrls: string[] = [];

    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await writePullRequestEvent(eventPath);
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const { readFileSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
        "readFileSync(authPath, 'utf8');",
        "writeFileSync(authPath, JSON.stringify({",
        "  auth_mode: 'chatgpt',",
        "  tokens: {",
        "    refresh_token: 'refreshed-refresh-token',",
        "    access_token: 'refreshed-access-token'",
        "  }",
        "}));",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await writeCodexManifest(fakeCodex);

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      invokedUrls.push(href);
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "github_put_failed",
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            "INPUT_AUTH-JSON": JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                refresh_token: "initial-refresh-token",
                access_token: "initial-access-token",
              },
            }),
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
            GITHUB_RUN_ID: "9001",
            GITHUB_RUN_ATTEMPT: "1",
            REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "1",
            PATH: process.env.PATH ?? "",
            ...supportedRunnerEnv(tempDir),
          },
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("unknown_auth_state");

      expect(invokedUrls.some((url) => url.endsWith("/writeback"))).toBe(true);
      expect(invokedUrls.some((url) => url.endsWith("/checkout-token"))).toBe(
        false,
      );
      expect(invokedUrls.some((url) => url.endsWith("/comment-token"))).toBe(
        false,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("maps bootstrap auth failure to reconnect without streaming child output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "reviewrouter-action-test-"));
    const eventPath = join(tempDir, "event.json");
    const fakeCodex = join(
      tempDir,
      "action-dist",
      "codex",
      "linux-x64",
      "codex",
    );
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();
    const invokedUrls: string[] = [];

    await mkdir(join(tempDir, "action-dist", "codex", "linux-x64"), {
      recursive: true,
    });
    await writePullRequestEvent(eventPath);
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('invalid_grant refresh token access_token leak');",
        "process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    await writeCodexManifest(fakeCodex);

    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      invokedUrls.push(href);
      if (href.startsWith("https://oidc.actions.test/token")) {
        return jsonResponse({ value: "oidc.jwt.value" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/prelease")) {
        return jsonResponse({
          leaseId: "lease_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "777genius",
          repositoryName: "agent-teams-ai",
          publicKeyReadToken: "ghs_public_key_read_token",
        });
      }
      if (
        href ===
        "https://api.github.com/repos/777genius/agent-teams-ai/actions/secrets/public-key"
      ) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/api/action/v1/codex-oauth/abandon")) {
        return jsonResponse({ protocolVersion: 1, status: "abandoned" });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as unknown as typeof fetch;

    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: {
            "INPUT_API-URL": "https://api.reviewrouter.site/",
            "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
            "INPUT_WORKFLOW-SCHEMA-VERSION": "1",
            "INPUT_AUTH-JSON": JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                refresh_token: "initial-refresh-token",
                access_token: "initial-access-token",
              },
            }),
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.test/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "777genius/agent-teams-ai",
            PATH: process.env.PATH ?? "",
            ...supportedRunnerEnv(tempDir),
          },
          fetchImpl,
          io: {
            stdout: { write: stdoutWrite },
            stderr: { write: stderrWrite },
          },
        }),
      ).rejects.toThrow("needs_reconnect");

      const stdoutText = stdoutWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(stdoutText).not.toContain("invalid_grant");
      expect(stdoutText).not.toContain("leak");
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(invokedUrls.some((url) => url.endsWith("/abandon"))).toBe(true);
      expect(invokedUrls.some((url) => url.endsWith("/writeback"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function realpathForTest(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

async function writeCodexManifest(binaryPath: string): Promise<void> {
  const bytes = readFileSync(binaryPath);
  const bundleDir = join(binaryPath, "..");
  const archivePath = join(bundleDir, "codex-linux-x64.tgz");
  const stagingDir = await mkdtemp(join(tmpdir(), "reviewrouter-codex-tar-"));
  const binaryPathInArchive =
    "package/vendor/x86_64-unknown-linux-musl/bin/codex";
  const stagedBinary = join(stagingDir, binaryPathInArchive);
  await mkdir(join(stagedBinary, ".."), { recursive: true });
  await writeFile(stagedBinary, bytes, { mode: 0o700 });
  execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "package"]);
  const archiveBytes = readFileSync(archivePath);
  await rm(stagingDir, { recursive: true, force: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    `${JSON.stringify(
      {
        protocolVersion: 1,
        packageName: "@openai/codex",
        version: "0.135.0",
        platform: "linux-x64",
        archive: "codex-linux-x64.tgz",
        archiveSize: archiveBytes.byteLength,
        archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
        binaryPathInArchive,
        binary: "codex",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
}

async function writePullRequestEvent(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      number: 118,
      repository: { full_name: "777genius/agent-teams-ai" },
      pull_request: {
        draft: false,
        head: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          repo: { full_name: "777genius/agent-teams-ai" },
        },
        base: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
      },
    }),
  );
}

function supportedRunnerEnv(actionPath: string): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTION_PATH: actionPath,
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    ImageOS: "ubuntu24",
    ImageVersion: "20260518.1.0",
  };
}
