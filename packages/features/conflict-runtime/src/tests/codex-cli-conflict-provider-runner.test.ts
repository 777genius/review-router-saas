import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCliConflictProviderRunner } from "../infrastructure/codex-cli-conflict-provider-runner.js";
import type { ConflictRuntimeCommandInput } from "../infrastructure/node-command-runner.js";

const config = {
  protocolVersion: 1,
  reviewKind: "conflict-head",
  dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
  pullRequestNumber: 7,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  checkout: {
    mode: "exact_head_sha",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    persistCredentials: false,
  },
  diff: {
    mode: "expected_base_to_head",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    maxFiles: 10,
    maxBytes: 1024,
    maxPatchBytesPerFile: 512,
  },
  posting: {
    mode: "disabled",
    reason: "posting_proxy_not_enabled",
  },
} as const;

const diffPacket = {
  protocolVersion: 1,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      binary: false,
      patch: "@@ -1 +1 @@\n-a\n+b\n",
      patchBytes: 18,
      patchSha256: "c".repeat(64),
      truncated: false,
    },
  ],
  omittedFileCount: 0,
  totalPatchBytes: 18,
  truncated: false,
  manifestHash: "d".repeat(64),
} as const;

describe("CodexCliConflictProviderRunner", () => {
  it("runs codex with read-only sandbox, schema output, and no runtime/posting secrets", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "rr-codex-test-"));
    const calls: ConflictRuntimeCommandInput[] = [];
    let schema: unknown;
    try {
      const result = await new CodexCliConflictProviderRunner({
        workspace: "/repo",
        tempRoot,
        runCommand: async (input) => {
          calls.push(input);
          const schemaPath =
            input.args[input.args.indexOf("--output-schema") + 1];
          schema = JSON.parse(await readFile(String(schemaPath), "utf8"));
          const outputPath =
            input.args[input.args.indexOf("--output-last-message") + 1];
          await writeFile(
            String(outputPath),
            JSON.stringify({
              protocolVersion: 1,
              summaryMarkdown: "Conflict-head review completed.",
              findings: [],
            }),
          );
          return {
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      }).runReview({
        config,
        diffPacket,
        providerEnv: {
          REVIEW_AUTH_MODE: "codex-oauth",
          CODEX_MODEL: "gpt-5.5",
          CODEX_REASONING_EFFORT: "high",
          CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}',
          CODEX_CONFIG_TOML: "model = 'gpt-5.5'",
          OPENAI_API_KEY: "sk-provider",
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        summaryMarkdown: "Conflict-head review completed.",
        findings: [],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(
        expect.arrayContaining([
          "exec",
          "--sandbox",
          "read-only",
          "--config",
          'approval_policy="never"',
          "--config",
          'model_reasoning_effort="high"',
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--output-schema",
          "--output-last-message",
        ]),
      );
      expect(calls[0]?.args).not.toContain("--ask-for-approval");
      expect(schema).toMatchObject({
        properties: {
          protocolVersion: {
            type: "integer",
            const: 1,
          },
        },
      });
      const schemaObject = schema as {
        properties: {
          findings: {
            items: {
              required: readonly string[];
              properties: { path: { type: readonly string[] } };
            };
          };
        };
      };
      expect(schemaObject.properties.findings.items.required).toEqual([
        "severity",
        "title",
        "body",
        "path",
        "startLine",
        "endLine",
      ]);
      expect(
        schemaObject.properties.findings.items.properties.path.type,
      ).toEqual(["string", "null"]);
      expect(calls[0]?.env).toMatchObject({
        CODEX_HOME: expect.stringContaining("reviewrouter-conflict-"),
        HOME: calls[0]?.env?.CODEX_HOME,
        XDG_CONFIG_HOME: join(String(calls[0]?.env?.CODEX_HOME), "config"),
        XDG_CACHE_HOME: join(String(calls[0]?.env?.CODEX_HOME), "cache"),
        OPENAI_API_KEY: "sk-provider",
      });
      expect(calls[0]?.env?.HOME).not.toBe(process.env.HOME);
      expect(calls[0]?.env).not.toHaveProperty("CODEX_AUTH_JSON");
      expect(calls[0]?.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(calls[0]?.env).not.toHaveProperty("REVIEW_ROUTER_POSTING_TOKEN");
      expect(calls[0]?.stdin).toContain("Bounded diff packet");
      expect(calls[0]?.stdin).not.toContain("sk-provider");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for unsupported primary providers", async () => {
    await expect(
      new CodexCliConflictProviderRunner({
        workspace: "/repo",
      }).runReview({
        config,
        diffPacket,
        providerEnv: {
          REVIEW_AUTH_MODE: "claude-oauth",
          CLAUDE_MODEL: "claude-sonnet-4.5",
        },
      }),
    ).rejects.toThrow("conflict_provider_runtime_unsupported");
  });
});
