import { describe, expect, it } from "vitest";
import {
  buildBoundedConflictDiffPacket,
  buildConflictProviderEnvironment,
  buildConflictRuntimeCheckoutPlan,
  buildConflictRuntimeSummaryMarkdown,
  parseConflictRuntimeModelOutput,
  parseConflictRuntimeConfig,
  type ConflictRuntimeFileDiff,
} from "../domain/conflict-runtime.js";

const runtimeConfig = {
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
    maxFiles: 2,
    maxBytes: 80,
    maxPatchBytesPerFile: 60,
  },
  posting: {
    mode: "disabled",
    reason: "posting_proxy_not_enabled",
  },
} as const;

const proxyRuntimeConfig = {
  ...runtimeConfig,
  posting: {
    mode: "proxy",
    sessionEndpoint: "/api/action/v1/conflict-posting/session",
    summaryEndpoint: "/api/action/v1/conflict-posting/summary",
    statusEndpoint: "/api/action/v1/conflict-posting/status",
    allowedOperations: ["summary_comment", "advisory_status"],
    summaryMaxBytes: 60_000,
    statusContext: "ReviewRouter conflict review",
  },
} as const;

describe("conflict runtime", () => {
  it("accepts only the runtime v1 conflict config and builds exact checkout plans", () => {
    expect(parseConflictRuntimeConfig(runtimeConfig)).toEqual(runtimeConfig);
    expect(buildConflictRuntimeCheckoutPlan(runtimeConfig)).toEqual({
      mode: "exact_head_sha",
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "b".repeat(40),
      persistCredentials: false,
    });
    expect(parseConflictRuntimeConfig(proxyRuntimeConfig)).toEqual(
      proxyRuntimeConfig,
    );
    expect(() =>
      parseConflictRuntimeConfig({
        ...runtimeConfig,
        posting: { mode: "github_token" },
      }),
    ).toThrow();
  });

  it("builds deterministic bounded diff packets and manifest hashes", () => {
    const files: ConflictRuntimeFileDiff[] = [
      {
        path: "src/z.ts",
        status: "modified",
        patch: "+".repeat(120),
      },
      {
        path: "src/a.ts",
        status: "added",
        patch: "export const a = 1;\n",
      },
      {
        path: "src/omitted.ts",
        status: "added",
        patch: "ignored",
      },
    ];

    const first = buildBoundedConflictDiffPacket({
      config: runtimeConfig,
      files,
    });
    const second = buildBoundedConflictDiffPacket({
      config: runtimeConfig,
      files: [...files].reverse(),
    });

    expect(first.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/omitted.ts",
    ]);
    expect(first.omittedFileCount).toBe(1);
    expect(first.totalPatchBytes).toBeLessThanOrEqual(
      runtimeConfig.diff.maxBytes,
    );
    expect(first.truncated).toBe(true);
    expect(first.manifestHash).toEqual(second.manifestHash);
  });

  it("rejects unsafe repository paths and unicode normalization collisions", () => {
    expect(() =>
      buildBoundedConflictDiffPacket({
        config: runtimeConfig,
        files: [{ path: "../secret", status: "modified", patch: "x" }],
      }),
    ).toThrow("conflict_diff_path_unsafe");
    expect(() =>
      buildBoundedConflictDiffPacket({
        config: runtimeConfig,
        files: [{ path: "src/\u202eevil.ts", status: "modified", patch: "x" }],
      }),
    ).toThrow("conflict_diff_path_unsafe");
    expect(() =>
      buildBoundedConflictDiffPacket({
        config: runtimeConfig,
        files: [{ path: "src/\u0001evil.ts", status: "modified", patch: "x" }],
      }),
    ).toThrow("conflict_diff_path_unsafe");
    expect(() =>
      buildBoundedConflictDiffPacket({
        config: runtimeConfig,
        files: [
          { path: "src/cafe\u0301.ts", status: "modified", patch: "x" },
          { path: "src/caf\u00e9.ts", status: "modified", patch: "x" },
        ],
      }),
    ).toThrow("conflict_diff_path_collision");
    expect(() =>
      buildBoundedConflictDiffPacket({
        config: runtimeConfig,
        files: [
          { path: "src/Case.ts", status: "modified", patch: "x" },
          { path: "src/case.ts", status: "modified", patch: "x" },
        ],
      }),
    ).toThrow("conflict_diff_path_collision");
  });

  it("keeps truncated UTF-8 patches within the byte budget", () => {
    const packet = buildBoundedConflictDiffPacket({
      config: {
        ...runtimeConfig,
        diff: {
          ...runtimeConfig.diff,
          maxBytes: 5,
          maxPatchBytesPerFile: 5,
        },
      },
      files: [
        {
          path: "src/emoji.ts",
          status: "modified",
          patch: "🙂🙂🙂",
        },
      ],
    });

    expect(packet.files[0]?.patchBytes).toBeLessThanOrEqual(5);
    expect(packet.totalPatchBytes).toBeLessThanOrEqual(5);
    expect(packet.truncated).toBe(true);
  });

  it("keeps provider subprocess env scoped away from runtime and posting secrets", () => {
    expect(
      buildConflictProviderEnvironment({
        sourceEnv: {
          CODEX_MODEL: "gpt-5.5",
          OPENAI_API_KEY: "sk-provider",
          OPENROUTER_API_KEY: "sk-openrouter",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
          CLAUDE_MODEL: "sonnet",
          GITHUB_TOKEN: "ghs_write_token",
          REVIEW_ROUTER_CONFLICT_DISPATCH_ID:
            "cr_123e4567-e89b-12d3-a456-426614174000",
          REVIEW_ROUTER_CONFLICT_DISPATCH_NONCE: "n".repeat(40),
          REVIEW_ROUTER_POSTING_TOKEN: "posting",
        },
      }),
    ).toEqual({
      CODEX_MODEL: "gpt-5.5",
      OPENAI_API_KEY: "sk-provider",
    });

    expect(() =>
      buildConflictProviderEnvironment({
        sourceEnv: { CODEX_MODEL: "gpt-5.5" },
        allowlist: ["GITHUB_TOKEN" as never],
      }),
    ).toThrow("conflict_provider_env_contains_runtime_secret");
  });

  it("validates model output without giving the model posting control", () => {
    const output = parseConflictRuntimeModelOutput({
      protocolVersion: 1,
      summaryMarkdown: "Conflict-head review found a risky change.",
      findings: [
        {
          severity: "major",
          title: "Validate conflict branch behavior",
          body: "The branch-specific behavior needs a stale-head guard.",
          path: "src/review.ts",
          startLine: 12,
          endLine: 14,
        },
        {
          severity: "info",
          title: "No line location",
          body: "Provider schemas require nullable fields instead of omitted optional fields.",
          path: null,
          startLine: null,
          endLine: null,
        },
      ],
    });

    expect(buildConflictRuntimeSummaryMarkdown(output)).toContain(
      "[major] Validate conflict branch behavior (src/review.ts:12)",
    );
    expect(output.findings[1]?.title).toBe("No line location");
    expect(output.findings[1]?.path).toBeUndefined();
    expect(output.findings[1]?.startLine).toBeUndefined();
    expect(output.findings[1]?.endLine).toBeUndefined();
    expect(() =>
      parseConflictRuntimeModelOutput({
        protocolVersion: 1,
        summaryMarkdown:
          "<!-- reviewrouter:conflict-review:v1 --> required review passed",
        statusContext: "ReviewRouter",
        targetSha: "a".repeat(40),
      }),
    ).toThrow();
    expect(() =>
      parseConflictRuntimeModelOutput({
        protocolVersion: 1,
        summaryMarkdown: "Looks okay.",
        findings: [
          {
            severity: "major",
            title: "Unsafe path",
            body: "Path traversal should not become a comment target.",
            path: "../secret",
          },
        ],
      }),
    ).toThrow("conflict_diff_path_unsafe");
  });

  it("escapes repository paths when rendering model findings to markdown", () => {
    const output = parseConflictRuntimeModelOutput({
      protocolVersion: 1,
      summaryMarkdown: "Conflict-head review found a risky change.",
      findings: [
        {
          severity: "minor",
          title: "Check rendered path",
          body: "Path punctuation must stay inert in markdown.",
          path: "src/[link](target).ts",
          startLine: 3,
        },
      ],
    });

    expect(buildConflictRuntimeSummaryMarkdown(output)).toContain(
      "(src/\\[link\\]\\(target\\).ts:3)",
    );
  });
});
