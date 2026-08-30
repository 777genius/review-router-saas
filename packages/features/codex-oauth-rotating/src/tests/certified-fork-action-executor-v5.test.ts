import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildForkPromptOnlyBootstrapEnv,
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
    GITHUB_WORKSPACE: "/untrusted/fork/workspace",
    REVIEW_ROUTER_PR_WORKSPACE: "/untrusted/fork/workspace/safe-workspace",
    GITHUB_ACTION_PATH: actionPath,
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    RUNNER_TEMP: "/tmp",
    ImageOS: "ubuntu24",
    ImageVersion: "20260518.1.0",
    PATH: process.env.PATH ?? "",
    FORK_ATTACK_METADATA: "must-not-reach-bootstrap",
  };
}

async function fixture(): Promise<{
  readonly root: string;
  readonly eventPath: string;
  readonly capturePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rr-fork-executor-v5-"));
  const eventPath = join(root, "event.json");
  const capturePath = join(root, "bootstrap.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      number: binding.pullRequestNumber,
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
      "const { readFileSync, readdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: process.env }));`,
      "const authPath = join(process.env.CODEX_HOME, 'auth.json');",
      "readFileSync(authPath, 'utf8');",
      `writeFileSync(authPath, ${JSON.stringify(refreshedAuthJson)});`,
      "process.stdout.write('OK\\n');",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(binaryPath, 0o700);
  await writeCodexManifest(binaryPath);
  return { root, eventPath, capturePath };
}

describe("certified fork V5 production executor", () => {
  it("cleans refreshed auth before prepare and publishes one valid result", async () => {
    const test = await fixture();
    const calls: string[] = [];
    const bodies = new Map<string, Record<string, unknown>>();
    let oidcCount = 0;
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
        return jsonResponse({
          leaseId: "lease_fork_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          accountFingerprintSalt:
            "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
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
          readonly env: Record<string, string>;
        };
        expect(capture.cwdEntries).toEqual([]);
        expect(existsSync(capture.cwd)).toBe(false);
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
          "INPUT_SOURCE-REPOSITORY",
          "INPUT_REVIEW-HEAD-SHA",
          "FORK_ATTACK_METADATA",
        ]) {
          expect(capture.env).not.toHaveProperty(forbidden);
        }
        return jsonResponse({
          protocolVersion: 1,
          executionId: "execution_1",
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
      if (href === "https://provider.test/codex/responses") {
        calls.push("provider");
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
          "account_test",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer refreshed-access-token",
        );
        return jsonResponse({
          output_text: JSON.stringify({
            protocolVersion: 1,
            summaryMarkdown: "Looks good.",
            findings: [],
          }),
        });
      }
      if (href.endsWith("/certified-fork-review/publish")) {
        calls.push("publish");
        return jsonResponse({
          protocolVersion: 1,
          status: "created",
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
        certifiedForkResponsesUrlForTest:
          "https://provider.test/codex/responses",
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
        "publish",
      ]);
      expect(oidcCount).toBe(3);
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
        oidcToken: "oidc-3",
        leaseId: "lease_fork_1",
        providerInstanceId: "codex-rotating:123456",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
        executionId: "execution_1",
        contextHash,
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "Looks good.",
          findings: [],
        },
      });
      expect(runtimeEnv).not.toHaveProperty("INPUT_AUTH-JSON");
      expect(runtimeEnv).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
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
      PATH: "/usr/bin",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      RUNNER_TEMP: "/runner-temp",
      NODE_EXTRA_CA_CERTS: "/tls/ca.pem",
      HOME: "/empty-home",
      CODEX_HOME: "/empty-codex-home",
      CI: "true",
    });
  });

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
        return jsonResponse({
          leaseId: "lease_fork_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          accountFingerprintSalt:
            "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
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
          certifiedForkResponsesUrlForTest:
            "https://provider.test/codex/responses",
          io: {
            stdout: { write: vi.fn() },
            stderr: { write: vi.fn() },
          },
        }),
      ).rejects.toThrow("unknown_auth_state");
      expect(urls.some((url) => url.includes("certified-fork-review"))).toBe(
        false,
      );
      expect(urls).not.toContain("https://provider.test/codex/responses");
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
        return jsonResponse({
          leaseId: "lease_fork_1",
          generationHashSalt: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          accountFingerprintSalt:
            "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        });
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
          executionId: "execution_1",
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
      if (href === "https://provider.test/codex/responses") {
        return jsonResponse({ output_text: "not valid model JSON" });
      }
      throw new Error(`unexpected_fetch:${href}`);
    }) as typeof fetch;
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: actionEnv(test.root, test.eventPath),
          fetchImpl,
          certifiedForkResponsesUrlForTest:
            "https://provider.test/codex/responses",
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
