import { describe, expect, it } from "vitest";
import {
  GitCliConflictCheckout,
  GitCliConflictDiffSource,
} from "../infrastructure/git-cli-conflict-runtime.js";
import type {
  ConflictRuntimeCommandInput,
  ConflictRuntimeCommandOutput,
} from "../infrastructure/node-command-runner.js";

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

describe("git cli conflict runtime", () => {
  it("verifies exact detached head checkout and no persisted credentials", async () => {
    const calls: ConflictRuntimeCommandInput[] = [];
    const runner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      calls.push(input);
      if (input.args[0] === "rev-parse") {
        return output(`${"a".repeat(40)}\n`);
      }
      return output("");
    };

    await new GitCliConflictCheckout({
      workspace: "/repo",
      runCommand: runner,
    }).checkoutExactHead(config.checkout);

    expect(calls.map((call) => call.args)).toEqual([
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      [
        "config",
        "--get-regexp",
        "^(http\\..*\\.extraheader|credential\\.|url\\..*\\.insteadOf)",
      ],
    ]);
  });

  it("fails closed when checkout head mismatches or credentials are persisted", async () => {
    await expect(
      new GitCliConflictCheckout({
        workspace: "/repo",
        runCommand: async (input) =>
          input.args[0] === "rev-parse"
            ? output(`${"c".repeat(40)}\n`)
            : output(""),
      }).checkoutExactHead(config.checkout),
    ).rejects.toThrow("conflict_checkout_head_mismatch");

    await expect(
      new GitCliConflictCheckout({
        workspace: "/repo",
        runCommand: async (input) =>
          input.args[0] === "config"
            ? output("http.https://github.com/.extraheader AUTHORIZATION\n")
            : input.args[0] === "rev-parse"
              ? output(`${"a".repeat(40)}\n`)
              : output(""),
      }).checkoutExactHead(config.checkout),
    ).rejects.toThrow("conflict_checkout_credentials_persisted");
  });

  it("collects deterministic git name-status entries and bounded file patches", async () => {
    const calls: ConflictRuntimeCommandInput[] = [];
    const runner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      calls.push(input);
      if (input.args[0] === "cat-file") {
        return output("");
      }
      if (input.args.includes("--name-status")) {
        return output(
          ["M", "src/a.ts", "R100", "src/old.ts", "src/new.ts", ""].join("\0"),
        );
      }
      return output(
        `diff --git a/${input.args.at(-1)} b/${input.args.at(-1)}\n+change\n`,
      );
    };

    const files = await new GitCliConflictDiffSource({
      workspace: "/repo",
      runCommand: runner,
    }).collectDiff({ config });

    expect(files).toEqual([
      expect.objectContaining({ path: "src/a.ts", status: "modified" }),
      expect.objectContaining({
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
      }),
    ]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        args: [
          "--literal-pathspecs",
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          "--find-copies",
          "b".repeat(40),
          "a".repeat(40),
          "--",
        ],
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--literal-pathspecs", "--", "src/a.ts"]),
      }),
    );
  });

  it("uses literal pathspecs for pathspec-like repository paths", async () => {
    const calls: ConflictRuntimeCommandInput[] = [];
    const runner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      calls.push(input);
      if (input.args[0] === "cat-file") {
        return output("");
      }
      if (input.args.includes("--name-status")) {
        return output(["M", ":(glob)*.ts", ""].join("\0"));
      }
      return output("diff --git a/:(glob)*.ts b/:(glob)*.ts\n+change\n");
    };

    const files = await new GitCliConflictDiffSource({
      workspace: "/repo",
      runCommand: runner,
    }).collectDiff({ config });

    expect(files).toEqual([
      expect.objectContaining({ path: ":(glob)*.ts", status: "modified" }),
    ]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        args: [
          "--literal-pathspecs",
          "diff",
          "--binary",
          "--no-ext-diff",
          "--find-renames",
          "--find-copies",
          "b".repeat(40),
          "a".repeat(40),
          "--",
          ":(glob)*.ts",
        ],
      }),
    );
  });

  it("rejects unsafe repository paths before per-file diff commands", async () => {
    const calls: ConflictRuntimeCommandInput[] = [];
    const runner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      calls.push(input);
      if (input.args[0] === "cat-file") {
        return output("");
      }
      if (input.args.includes("--name-status")) {
        return output(["M", "src/\u202ehidden.ts", ""].join("\0"));
      }
      throw new Error("per_file_diff_should_not_run");
    };

    await expect(
      new GitCliConflictDiffSource({
        workspace: "/repo",
        runCommand: runner,
      }).collectDiff({ config }),
    ).rejects.toThrow("conflict_diff_path_unsafe");

    expect(calls.some((call) => call.args.includes("--binary"))).toBe(false);
  });

  it("rejects unsafe non-sha diff inputs before invoking git", async () => {
    const calls: ConflictRuntimeCommandInput[] = [];
    await expect(
      new GitCliConflictDiffSource({
        workspace: "/repo",
        runCommand: async (input) => {
          calls.push(input);
          return output("");
        },
      }).collectDiff({
        config: {
          ...config,
          diff: { ...config.diff, headSha: "main;rm -rf ." },
        },
      }),
    ).rejects.toThrow("conflict_head_sha_invalid");
    expect(calls).toHaveLength(0);
  });

  it("rejects symlink and submodule diff entries before prompt construction", async () => {
    const symlinkRunner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      if (input.args[0] === "cat-file") {
        return output("");
      }
      if (input.args.includes("--name-status")) {
        return output(["M", "link", ""].join("\0"));
      }
      return output(
        [
          "diff --git a/link b/link",
          "index 7898192..6178079 120000",
          "--- a/link",
          "+++ b/link",
          "@@ -1 +1 @@",
          "-old-target",
          "+new-target",
          "",
        ].join("\n"),
      );
    };

    await expect(
      new GitCliConflictDiffSource({
        workspace: "/repo",
        runCommand: symlinkRunner,
      }).collectDiff({ config }),
    ).rejects.toThrow("conflict_diff_file_type_unsupported");

    const submoduleRunner = async (
      input: ConflictRuntimeCommandInput,
    ): Promise<ConflictRuntimeCommandOutput> => {
      if (input.args[0] === "cat-file") {
        return output("");
      }
      if (input.args.includes("--name-status")) {
        return output(["M", "vendor/lib", ""].join("\0"));
      }
      return output(
        [
          "diff --git a/vendor/lib b/vendor/lib",
          "index 1111111..2222222 160000",
          "--- a/vendor/lib",
          "+++ b/vendor/lib",
          "@@ -1 +1 @@",
          "-Subproject commit 1111111111111111111111111111111111111111",
          "+Subproject commit 2222222222222222222222222222222222222222",
          "",
        ].join("\n"),
      );
    };

    await expect(
      new GitCliConflictDiffSource({
        workspace: "/repo",
        runCommand: submoduleRunner,
      }).collectDiff({ config }),
    ).rejects.toThrow("conflict_diff_file_type_unsupported");
  });
});

function output(stdout: string): ConflictRuntimeCommandOutput {
  return {
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
