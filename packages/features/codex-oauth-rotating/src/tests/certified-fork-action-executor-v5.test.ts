import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertCertifiedForkPreleaseContextMatchesPrepare,
  buildForkPromptOnlyBootstrapEnv,
  parseCertifiedForkPrepareResponse,
  resolveCertifiedForkPrepareDisposition,
  runCodexRotatingGitHubAction,
} from "../action/github-action";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: vi.fn(async () => ({
    bavail: 5 * 1024 * 1024,
    bsize: 1024,
  })),
}));

const binding = {
  sourceRepository: "contributor/repository",
  sourceRepositoryId: "654321",
  baseRepository: "base/repository",
  baseRepositoryId: "123456",
  pullRequestNumber: 42,
  reviewHeadSha: "b".repeat(40),
  baseSha: "c".repeat(40),
  trustDomain: "fork",
} as const;
const contextHash = "d".repeat(64);
const productionSizedExecutionId = "ticket.".padEnd(982, "x");
const forkSentinel = "fork-sentinel-must-be-erased";
const idToken = `header.${Buffer.from(
  JSON.stringify({
    iss: "https://auth.openai.com",
    sub: "user:test",
    chatgpt_account_id: "account_test",
  }),
).toString("base64url")}.signature`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readyPreleaseResponse(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    status: "ready",
    leaseId: "lease_fork_1",
    providerInstanceId: "codex-rotating:123456",
    repository: binding.baseRepository,
    generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    accountFingerprintSalt:
      "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    currentGeneration: 1,
    expiresAt: "2026-08-30T16:00:00.000Z",
    certifiedForkReviewContextHash: contextHash,
  };
}

function actionEnv(actionPath: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    INPUT_MODE: "fork_prompt_only_v2",
    "INPUT_API-URL": "https://api.reviewrouter.site",
    "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
    "INPUT_WORKFLOW-SCHEMA-VERSION": "5",
    "INPUT_SOURCE-REPOSITORY": binding.sourceRepository,
    "INPUT_SOURCE-REPOSITORY-ID": binding.sourceRepositoryId,
    "INPUT_BASE-REPOSITORY": binding.baseRepository,
    "INPUT_BASE-REPOSITORY-ID": binding.baseRepositoryId,
    "INPUT_PULL-REQUEST-NUMBER": String(binding.pullRequestNumber),
    "INPUT_REVIEW-HEAD-SHA": binding.reviewHeadSha,
    "INPUT_BASE-SHA": binding.baseSha,
    "INPUT_TRUST-DOMAIN": "fork",
    "INPUT_AUTH-JSON": JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "initial-refresh-token",
        access_token: "initial-access-token",
        id_token: idToken,
      },
    }),
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://vstoken.actions.githubusercontent.com/oidc/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: binding.baseRepository,
    GITHUB_WORKSPACE: join(actionPath, "workspace"),
    REVIEW_ROUTER_PR_WORKSPACE: join(actionPath, "workspace", "safe-workspace"),
    GITHUB_ACTION_PATH: actionPath,
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    RUNNER_TEMP: actionPath,
    ImageOS: "ubuntu24",
    ImageVersion: "20260518.1.0",
    PATH: process.env.PATH ?? "",
    FORK_ATTACK_METADATA: "must-not-reach-bootstrap",
  };
}

async function fixture(
  options: {
    readonly bootstrapFails?: boolean;
  } = {},
): Promise<{
  readonly root: string;
  readonly eventPath: string;
  readonly capturePath: string;
  readonly invocationPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rr-fork-executor-v5-"));
  const eventPath = join(root, "event.json");
  const capturePath = join(root, "bootstrap.json");
  const invocationPath = join(root, "bootstrap-invocations.txt");
  await writeFile(
    eventPath,
    JSON.stringify({
      number: binding.pullRequestNumber,
      fork_sentinel: forkSentinel,
      repository: {
        id: Number(binding.baseRepositoryId),
        full_name: binding.baseRepository,
      },
      pull_request: {
        draft: false,
        head: {
          sha: binding.reviewHeadSha,
          repo: {
            id: Number(binding.sourceRepositoryId),
            full_name: binding.sourceRepository,
            private: false,
          },
        },
        base: { sha: binding.baseSha },
      },
    }),
  );
  const bundleDir = join(root, "action-dist", "codex", "linux-x64");
  const binaryPath = join(bundleDir, "codex");
  await mkdir(bundleDir, { recursive: true });
  await mkdir(join(root, "workspace"));
  const refreshedAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "refreshed-refresh-token",
      access_token: "refreshed-access-token",
      id_token: idToken,
    },
  });
  await writeFile(
    binaryPath,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `appendFileSync(${JSON.stringify(invocationPath)}, '1\\n');`,
      `let eventReadable = true; try { readFileSync(${JSON.stringify(eventPath)}, 'utf8'); } catch { eventReadable = false; }`,
      `function searchJson(root) { for (const name of readdirSync(root)) { const path = join(root, name); let stats; try { stats = statSync(path); } catch { continue; } if (stats.isDirectory()) { if (searchJson(path)) return true; } else if (name.endsWith('.json') && path !== ${JSON.stringify(capturePath)}) { try { if (readFileSync(path, 'utf8').includes(${JSON.stringify(forkSentinel)})) return true; } catch {} } } return false; }`,
      "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
      "const config = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');",
      `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), scriptPath: process.argv[1], eventReadable, forkSentinelFound: searchJson(${JSON.stringify(root)}), config, env: process.env }));`,
      ...(options.bootstrapFails
        ? [
            "process.stderr.write('stream disconnected before completion\\n');",
            "process.exit(1);",
          ]
        : []),
      "readFileSync(authPath, 'utf8');",
      `writeFileSync(authPath, ${JSON.stringify(refreshedAuthJson)});`,
      "process.stdout.write('OK\\n');",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(binaryPath, 0o700);
  await writeCodexManifest(binaryPath);
  return { root, eventPath, capturePath, invocationPath };
}

describe("certified fork V5 production executor", () => {
  it("cleans refreshed auth before prepare and publishes one valid result", async () => {
    const test = await fixture();
    const calls: string[] = [];
    const bodies = new Map<string, Record<string, unknown>>();
    let oidcCount = 0;
    let publishAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (typeof init?.body === "string") {
        bodies.set(href, JSON.parse(init.body) as Record<string, unknown>);
      }
      if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
        oidcCount += 1;
        calls.push(`oidc-${oidcCount}`);
        return jsonResponse({ value: `oidc-${oidcCount}` });
      }
      if (href.endsWith("/codex-oauth/prelease")) {
        calls.push("prelease");
        return jsonResponse(readyPreleaseResponse());
      }
      if (href.endsWith("/codex-oauth/finalize")) {
        calls.push("finalize");
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "base",
          repositoryName: "repository",
          publicKeyReadToken: "github-public-key-token",
          runtimeConfigVersion: 1,
          runtimeEnv: {},
        });
      }
      if (href.includes("api.github.com") && href.endsWith("public-key")) {
        calls.push("public-key");
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/writeback-preflight")) {
        calls.push("preflight");
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/codex-oauth/writeback")) {
        calls.push("writeback");
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/certified-fork-review/prepare")) {
        calls.push("prepare");
        const capture = JSON.parse(readFileSync(test.capturePath, "utf8")) as {
          readonly cwd: string;
          readonly cwdEntries: readonly string[];
          readonly scriptPath: string;
          readonly eventReadable: boolean;
          readonly forkSentinelFound: boolean;
          readonly config: string;
          readonly env: Record<string, string>;
        };
        expect(capture.cwdEntries).toEqual([]);
        expect(existsSync(capture.cwd)).toBe(false);
        expect(existsSync(capture.scriptPath)).toBe(false);
        expect(capture.scriptPath.startsWith(`${test.root}/`)).toBe(false);
        expect(capture.eventReadable).toBe(false);
        expect(capture.forkSentinelFound).toBe(false);
        expect(capture.config).toContain(
          "[model_providers.reviewrouter_fork_bootstrap]",
        );
        expect(capture.config).toContain("request_max_retries = 0");
        expect(capture.config).toContain("stream_max_retries = 0");
        expect(existsSync(capture.env.HOME!)).toBe(false);
        expect(existsSync(capture.env.CODEX_HOME!)).toBe(false);
        expect(capture.env).toMatchObject({
          CI: "true",
          HOME: expect.any(String),
          CODEX_HOME: expect.any(String),
        });
        for (const forbidden of [
          "GITHUB_EVENT_PATH",
          "GITHUB_WORKSPACE",
          "ACTIONS_ID_TOKEN_REQUEST_URL",
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
          "RUNNER_TEMP",
          "RUNNER_TOOL_CACHE",
          "TMPDIR",
          "TEMP",
          "TMP",
          "NODE_EXTRA_CA_CERTS",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "INPUT_SOURCE-REPOSITORY",
          "INPUT_REVIEW-HEAD-SHA",
          "FORK_ATTACK_METADATA",
        ]) {
          expect(capture.env).not.toHaveProperty(forbidden);
        }
        return jsonResponse({
          protocolVersion: 1,
          status: "ready",
          executionId: productionSizedExecutionId,
          contextHash,
          model: "gpt-5.6-sol",
          maxOutputTokens: 12_000,
          promptPacket: {
            protocolVersion: 1,
            contextHash,
            repository: {
              base: binding.baseRepository,
              source: binding.sourceRepository,
            },
            pullRequestNumber: binding.pullRequestNumber,
            baseSha: binding.baseSha,
            headSha: binding.reviewHeadSha,
            files: [
              {
                path: "src/index.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: "+export const safe = true;",
              },
            ],
          },
        });
      }
      if (href === "https://chatgpt.com/backend-api/codex/responses") {
        calls.push("provider");
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
          "account_test",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer refreshed-access-token",
        );
        return jsonResponse({
          status: "completed",
          output_text: JSON.stringify({
            protocolVersion: 1,
            summaryMarkdown: "Looks good.",
            findings: [],
          }),
        });
      }
      if (href.endsWith("/certified-fork-review/publish")) {
        publishAttempts += 1;
        calls.push(`publish-${publishAttempts}`);
        if (publishAttempts === 1) {
          throw new Error("socket_closed_after_publish");
        }
        return jsonResponse({
          protocolVersion: 1,
          status: "updated",
          commentId: "123",
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    const runtimeEnv = actionEnv(test.root, test.eventPath);
    try {
      await runCodexRotatingGitHubAction({
        env: runtimeEnv,
        fetchImpl,
        io: {
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
      });
      expect(calls).toEqual([
        "oidc-1",
        "prelease",
        "finalize",
        "public-key",
        "preflight",
        "writeback",
        "oidc-2",
        "prepare",
        "provider",
        "oidc-3",
        "publish-1",
        "oidc-4",
        "publish-2",
      ]);
      expect(oidcCount).toBe(4);
      const prelease = bodies.get(
        "https://api.reviewrouter.site/api/action/v1/codex-oauth/prelease",
      );
      expect(prelease).toMatchObject({
        oidcToken: "oidc-1",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
      });
      const prepare = bodies.get(
        "https://api.reviewrouter.site/api/action/v1/certified-fork-review/prepare",
      );
      expect(prepare).toEqual({
        oidcToken: "oidc-2",
        leaseId: "lease_fork_1",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
      });
      const publish = bodies.get(
        "https://api.reviewrouter.site/api/action/v1/certified-fork-review/publish",
      );
      expect(publish).toMatchObject({
        oidcToken: "oidc-4",
        leaseId: "lease_fork_1",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
        executionId: productionSizedExecutionId,
        contextHash,
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "Looks good.",
          findings: [],
        },
      });
      expect(calls.filter((call) => call === "provider")).toHaveLength(1);
      expect(runtimeEnv).not.toHaveProperty("INPUT_AUTH-JSON");
      expect(runtimeEnv).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
      expect(runtimeEnv).not.toHaveProperty("INPUT_SOURCE-REPOSITORY");
      expect(runtimeEnv).not.toHaveProperty("GITHUB_REPOSITORY");
      expect(runtimeEnv).toEqual({
        GITHUB_RUN_ID: "9001",
        GITHUB_RUN_ATTEMPT: "1",
      });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("builds an allowlisted bootstrap environment without GitHub or fork data", () => {
    expect(
      buildForkPromptOnlyBootstrapEnv(
        {
          PATH: "/usr/bin",
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          RUNNER_TEMP: "/runner-temp",
          TMPDIR: "/attacker/tmp",
          NODE_EXTRA_CA_CERTS: "/tls/ca.pem",
          GITHUB_EVENT_PATH: "/fork/event.json",
          GITHUB_WORKSPACE: "/fork/workspace",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
          "INPUT_SOURCE-REPOSITORY": "attacker/repo",
          CODEX_AUTH_JSON: "raw-auth",
        },
        "/empty-home",
        "/empty-codex-home",
      ),
    ).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/empty-home",
      CODEX_HOME: "/empty-codex-home",
      CI: "true",
    });
  });

  it("does not retry an ambiguous bootstrap stream", async () => {
    const test = await fixture({ bootstrapFails: true });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
        return jsonResponse({ value: "oidc-1" });
      }
      if (href.endsWith("/codex-oauth/prelease")) {
        return jsonResponse(readyPreleaseResponse());
      }
      if (href.endsWith("/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "base",
          repositoryName: "repository",
          publicKeyReadToken: "github-public-key-token",
          runtimeConfigVersion: 1,
          runtimeEnv: {},
        });
      }
      if (href.endsWith("public-key")) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: actionEnv(test.root, test.eventPath),
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(test.invocationPath, "utf8")).toBe("1\n");
      const capture = JSON.parse(readFileSync(test.capturePath, "utf8")) as {
        readonly config: string;
      };
      expect(capture.config).toContain("request_max_retries = 0");
      expect(capture.config).toContain("stream_max_retries = 0");
      expect(urls.some((url) => url.includes("certified-fork-review"))).toBe(
        false,
      );
      expect(urls).not.toContain(
        "https://chatgpt.com/backend-api/codex/responses",
      );
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it.each(["in_progress", "already_published"] as const)(
    "exits before auth and bootstrap for prelease status %s",
    async (status) => {
      const test = await fixture();
      const urls: string[] = [];
      let authReads = 0;
      const runtimeEnv = actionEnv(test.root, test.eventPath);
      Object.defineProperty(runtimeEnv, "INPUT_AUTH-JSON", {
        configurable: true,
        enumerable: true,
        get: () => {
          authReads += 1;
          return "must-not-be-read";
        },
      });
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = String(url);
        urls.push(href);
        if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
          return jsonResponse({ value: "oidc-1" });
        }
        if (href.endsWith("/codex-oauth/prelease")) {
          return jsonResponse(
            status === "already_published"
              ? {
                  protocolVersion: 1,
                  status,
                  commentId: "123",
                }
              : { protocolVersion: 1, status },
          );
        }
        throw new Error(`unexpected_fetch:${href}`);
      }) as typeof fetch;
      try {
        await expect(
          runCodexRotatingGitHubAction({
            env: runtimeEnv,
            fetchImpl,
            io: {
              stdout: { write: vi.fn() },
              stderr: { write: vi.fn() },
            },
          }),
        ).resolves.toBeUndefined();
        expect(authReads).toBe(0);
        expect(existsSync(test.eventPath)).toBe(false);
        expect(existsSync(test.capturePath)).toBe(false);
        expect(urls).toHaveLength(2);
        expect(urls[1]).toContain("/codex-oauth/prelease");
        expect(
          urls.some((url) =>
            /finalize|public-key|writeback|prepare|responses|publish/.test(url),
          ),
        ).toBe(false);
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
  );

  it("blocks prepare when writeback is ambiguous", async () => {
    const test = await fixture();
    const urls: string[] = [];
    let oidcCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
        oidcCount += 1;
        return jsonResponse({ value: `oidc-${oidcCount}` });
      }
      if (href.endsWith("/codex-oauth/prelease")) {
        return jsonResponse(readyPreleaseResponse());
      }
      if (href.endsWith("/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "base",
          repositoryName: "repository",
          publicKeyReadToken: "github-public-key-token",
          runtimeConfigVersion: 1,
          runtimeEnv: {},
        });
      }
      if (href.endsWith("public-key")) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "in_progress" });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: actionEnv(test.root, test.eventPath),
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("unknown_auth_state");
      expect(urls.some((url) => url.includes("certified-fork-review"))).toBe(
        false,
      );
      expect(urls).not.toContain(
        "https://chatgpt.com/backend-api/codex/responses",
      );
      expect(oidcCount).toBe(1);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("never publishes malformed provider output", async () => {
    const test = await fixture();
    const urls: string[] = [];
    let oidcCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
        oidcCount += 1;
        return jsonResponse({ value: `oidc-${oidcCount}` });
      }
      if (href.endsWith("/codex-oauth/prelease")) {
        return jsonResponse(readyPreleaseResponse());
      }
      if (href.endsWith("/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "base",
          repositoryName: "repository",
          publicKeyReadToken: "github-public-key-token",
          runtimeConfigVersion: 1,
          runtimeEnv: {},
        });
      }
      if (href.endsWith("public-key")) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/certified-fork-review/prepare")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "ready",
          executionId: productionSizedExecutionId,
          contextHash,
          model: "gpt-5.6-sol",
          maxOutputTokens: 12_000,
          promptPacket: {
            protocolVersion: 1,
            contextHash,
            repository: {
              base: binding.baseRepository,
              source: binding.sourceRepository,
            },
            pullRequestNumber: binding.pullRequestNumber,
            baseSha: binding.baseSha,
            headSha: binding.reviewHeadSha,
            files: [],
          },
        });
      }
      if (href === "https://chatgpt.com/backend-api/codex/responses") {
        return jsonResponse({
          status: "completed",
          output_text: "not valid model JSON",
        });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: actionEnv(test.root, test.eventPath),
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("certified_fork_model_output_invalid_json");
      expect(
        urls.some((url) => url.endsWith("/certified-fork-review/publish")),
      ).toBe(false);
      expect(oidcCount).toBe(2);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("does not repeat the provider when a publish retry conflicts", async () => {
    const test = await fixture();
    let providerCalls = 0;
    let publishCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
        return jsonResponse({ value: `oidc-${Date.now()}` });
      }
      if (href.endsWith("/codex-oauth/prelease")) {
        return jsonResponse(readyPreleaseResponse());
      }
      if (href.endsWith("/codex-oauth/finalize")) {
        return jsonResponse({
          status: "finalized",
          nextGeneration: 2,
          repositoryOwner: "base",
          repositoryName: "repository",
          publicKeyReadToken: "github-public-key-token",
          runtimeConfigVersion: 1,
          runtimeEnv: {},
        });
      }
      if (href.endsWith("public-key")) {
        return jsonResponse({
          key: Buffer.alloc(32, 1).toString("base64"),
          key_id: "github-key-id",
        });
      }
      if (href.endsWith("/writeback-preflight")) {
        return jsonResponse({ protocolVersion: 1, status: "ready" });
      }
      if (href.endsWith("/codex-oauth/writeback")) {
        return jsonResponse({ protocolVersion: 1, status: "accepted" });
      }
      if (href.endsWith("/certified-fork-review/prepare")) {
        return jsonResponse({
          protocolVersion: 1,
          status: "ready",
          executionId: productionSizedExecutionId,
          contextHash,
          model: "gpt-5.6-sol",
          maxOutputTokens: 12_000,
          promptPacket: {
            protocolVersion: 1,
            contextHash,
            repository: {
              base: binding.baseRepository,
              source: binding.sourceRepository,
            },
            pullRequestNumber: binding.pullRequestNumber,
            baseSha: binding.baseSha,
            headSha: binding.reviewHeadSha,
            files: [],
          },
        });
      }
      if (href === "https://chatgpt.com/backend-api/codex/responses") {
        providerCalls += 1;
        return jsonResponse({
          status: "completed",
          output_text: JSON.stringify({
            protocolVersion: 1,
            summaryMarkdown: "Looks good.",
            findings: [],
          }),
        });
      }
      if (href.endsWith("/certified-fork-review/publish")) {
        publishCalls += 1;
        if (publishCalls === 1) throw new Error("lost_publish_response");
        return new Response(
          JSON.stringify({ error: "certified_fork_context_mismatch" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: actionEnv(test.root, test.eventPath),
          fetchImpl,
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("certified_fork_context_mismatch");
      expect(providerCalls).toBe(1);
      expect(publishCalls).toBe(2);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("accepts production-sized execution tickets and rejects oversized ones", () => {
    const response = {
      protocolVersion: 1,
      status: "ready" as const,
      executionId: productionSizedExecutionId,
      contextHash,
      model: "gpt-5.6-sol",
      maxOutputTokens: 12_000,
      promptPacket: {
        protocolVersion: 1,
        contextHash,
        repository: {
          base: binding.baseRepository,
          source: binding.sourceRepository,
        },
        pullRequestNumber: binding.pullRequestNumber,
        baseSha: binding.baseSha,
        headSha: binding.reviewHeadSha,
        files: [],
      },
    };
    const productionDisposition =
      resolveCertifiedForkPrepareDisposition(response);
    if (productionDisposition.status !== "ready") throw new Error("not_ready");
    expect(productionDisposition.prepare.executionId).toHaveLength(982);
    const maxDisposition = resolveCertifiedForkPrepareDisposition({
      ...response,
      executionId: "x".repeat(8_192),
    });
    if (maxDisposition.status !== "ready") throw new Error("not_ready");
    expect(maxDisposition.prepare.executionId).toHaveLength(8_192);
    expect(() =>
      parseCertifiedForkPrepareResponse({
        ...response,
        executionId: "x".repeat(8_193),
      }),
    ).toThrow("certified_fork_prepare_response_invalid");
  });

  it("runs the provider only for a ready prepare disposition", () => {
    expect(
      resolveCertifiedForkPrepareDisposition({
        protocolVersion: 1,
        status: "already_published",
        commentId: "123",
      }),
    ).toEqual({ status: "already_published" });
    expect(() =>
      resolveCertifiedForkPrepareDisposition({
        protocolVersion: 1,
        status: "in_progress",
      }),
    ).toThrow("certified_fork_prepare_in_progress");
    expect(() =>
      resolveCertifiedForkPrepareDisposition({
        protocolVersion: 1,
        status: "conflict",
      }),
    ).toThrow("certified_fork_prepare_conflict");
  });

  it("rejects a prepare claim outside the prelease context", () => {
    expect(() =>
      assertCertifiedForkPreleaseContextMatchesPrepare({
        preleaseContextHash: "a".repeat(64),
        prepareContextHash: "b".repeat(64),
      }),
    ).toThrow("certified_fork_prelease_context_mismatch");
  });

  it.each([
    ["already_published", false],
    ["in_progress", true],
    ["conflict", true],
  ] as const)(
    "makes zero provider and publish calls for prepare status %s",
    async (prepareStatus, rejects) => {
      const test = await fixture();
      let providerCalls = 0;
      let publishCalls = 0;
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.startsWith("https://vstoken.actions.githubusercontent.com")) {
          return jsonResponse({ value: "oidc" });
        }
        if (href.endsWith("/codex-oauth/prelease")) {
          return jsonResponse(readyPreleaseResponse());
        }
        if (href.endsWith("/codex-oauth/finalize")) {
          return jsonResponse({
            status: "finalized",
            nextGeneration: 2,
            repositoryOwner: "base",
            repositoryName: "repository",
            publicKeyReadToken: "github-public-key-token",
            runtimeConfigVersion: 1,
            runtimeEnv: {},
          });
        }
        if (href.endsWith("public-key")) {
          return jsonResponse({
            key: Buffer.alloc(32, 1).toString("base64"),
            key_id: "github-key-id",
          });
        }
        if (href.endsWith("/writeback-preflight")) {
          return jsonResponse({ protocolVersion: 1, status: "ready" });
        }
        if (href.endsWith("/codex-oauth/writeback")) {
          return jsonResponse({ protocolVersion: 1, status: "accepted" });
        }
        if (href.endsWith("/certified-fork-review/prepare")) {
          return jsonResponse(
            prepareStatus === "already_published"
              ? {
                  protocolVersion: 1,
                  status: prepareStatus,
                  commentId: "123",
                }
              : { protocolVersion: 1, status: prepareStatus },
          );
        }
        if (href === "https://chatgpt.com/backend-api/codex/responses") {
          providerCalls += 1;
          throw new Error("provider_must_not_run");
        }
        if (href.endsWith("/certified-fork-review/publish")) {
          publishCalls += 1;
          throw new Error("publish_must_not_run");
        }
        throw new Error(`unexpected_fetch:${href}`);
      }) as typeof fetch;
      const promise = runCodexRotatingGitHubAction({
        env: actionEnv(test.root, test.eventPath),
        fetchImpl,
        io: {
          stdout: { write: vi.fn() },
          stderr: { write: vi.fn() },
        },
      });
      try {
        if (rejects) {
          await expect(promise).rejects.toThrow(
            `certified_fork_prepare_${prepareStatus}`,
          );
        } else {
          await expect(promise).resolves.toBeUndefined();
        }
        expect(providerCalls).toBe(0);
        expect(publishCalls).toBe(0);
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
  );
});

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
