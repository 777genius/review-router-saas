import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import type {
  ConflictRuntimeCheckoutPort,
  ConflictRuntimeDiffSourcePort,
} from "../application/conflict-runtime-runner.js";
import {
  normalizeConflictRuntimeRepositoryPath,
  type ConflictRuntimeFileDiff,
} from "../domain/conflict-runtime.js";
import {
  nodeCommandRunner,
  type ConflictRuntimeCommandRunner,
} from "./node-command-runner.js";

export type GitCliConflictRuntimeOptions = {
  readonly workspace: string;
  readonly runCommand?: ConflictRuntimeCommandRunner | undefined;
  readonly commandTimeoutMs?: number | undefined;
};

const defaultCommandTimeoutMs = 30_000;

export class GitCliConflictCheckout implements ConflictRuntimeCheckoutPort {
  private readonly workspace: string;
  private readonly runCommand: ConflictRuntimeCommandRunner;
  private readonly commandTimeoutMs: number;

  constructor(options: GitCliConflictRuntimeOptions) {
    this.workspace = options.workspace;
    this.runCommand = options.runCommand ?? nodeCommandRunner;
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  }

  async checkoutExactHead(input: {
    readonly mode: "exact_head_sha";
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly persistCredentials: false;
  }): Promise<void> {
    if (input.mode !== "exact_head_sha" || input.persistCredentials !== false) {
      throw new Error("conflict_checkout_plan_invalid");
    }
    const headSha = assertSha(input.headSha, "head");
    assertSha(input.baseSha, "base");
    if (input.baseRef.trim().length === 0) {
      throw new Error("conflict_checkout_base_ref_invalid");
    }

    const actualHead = (
      await this.git(["rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (actualHead.toLowerCase() !== headSha.toLowerCase()) {
      throw new Error("conflict_checkout_head_mismatch");
    }

    const branch = (
      await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowFailure: true,
      })
    ).stdout.trim();
    if (branch.length > 0) {
      throw new Error("conflict_checkout_not_detached");
    }

    const credentialConfig = (
      await this.git(
        [
          "config",
          "--get-regexp",
          "^(http\\..*\\.extraheader|credential\\.|url\\..*\\.insteadOf)",
        ],
        { allowFailure: true },
      )
    ).stdout.trim();
    if (credentialConfig.length > 0) {
      throw new Error("conflict_checkout_credentials_persisted");
    }
  }

  private async git(
    args: readonly string[],
    options: { readonly allowFailure?: boolean } = {},
  ) {
    try {
      return await this.runCommand({
        command: "git",
        args,
        cwd: this.workspace,
        timeoutMs: this.commandTimeoutMs,
        maxStdoutBytes: 128 * 1024,
      });
    } catch (error) {
      if (
        options.allowFailure === true &&
        error instanceof Error &&
        error.message === "conflict_runtime_command_failed:git:1"
      ) {
        return {
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      throw error;
    }
  }
}

export class GitCliConflictDiffSource implements ConflictRuntimeDiffSourcePort {
  private readonly workspace: string;
  private readonly runCommand: ConflictRuntimeCommandRunner;
  private readonly commandTimeoutMs: number;

  constructor(options: GitCliConflictRuntimeOptions) {
    this.workspace = options.workspace;
    this.runCommand = options.runCommand ?? nodeCommandRunner;
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  }

  async collectDiff(input: {
    readonly config: ActionConflictReviewRuntimeConfig;
  }): Promise<readonly ConflictRuntimeFileDiff[]> {
    const baseSha = assertSha(input.config.diff.baseSha, "base");
    const headSha = assertSha(input.config.diff.headSha, "head");
    await this.assertCommitExists(baseSha);
    await this.assertCommitExists(headSha);

    const statusOutput = await this.git([
      "--literal-pathspecs",
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      baseSha,
      headSha,
      "--",
    ]);
    const entries = parseGitNameStatusZ(statusOutput.stdout);
    const maxPatchBytes = Math.max(
      input.config.diff.maxPatchBytesPerFile + 16 * 1024,
      64 * 1024,
    );

    const files: ConflictRuntimeFileDiff[] = [];
    for (const entry of entries) {
      const path = normalizeConflictRuntimeRepositoryPath(entry.path);
      const previousPath =
        entry.previousPath === undefined
          ? undefined
          : normalizeConflictRuntimeRepositoryPath(entry.previousPath);
      const patch = await this.git(
        [
          "--literal-pathspecs",
          "diff",
          "--binary",
          "--no-ext-diff",
          "--find-renames",
          "--find-copies",
          baseSha,
          headSha,
          "--",
          path,
        ],
        { maxStdoutBytes: maxPatchBytes },
      );
      if (hasUnsupportedGitFileMode(patch.stdout)) {
        throw new Error("conflict_diff_file_type_unsupported");
      }
      files.push({
        path,
        ...(previousPath ? { previousPath } : {}),
        status: entry.status,
        patch: patch.stdout,
        binary: looksLikeBinaryDiff(patch.stdout),
      });
    }
    return files;
  }

  private async assertCommitExists(sha: string): Promise<void> {
    await this.git(["cat-file", "-e", `${sha}^{commit}`]);
  }

  private async git(
    args: readonly string[],
    options: { readonly maxStdoutBytes?: number | undefined } = {},
  ) {
    return await this.runCommand({
      command: "git",
      args,
      cwd: this.workspace,
      timeoutMs: this.commandTimeoutMs,
      maxStdoutBytes: options.maxStdoutBytes ?? 1024 * 1024,
    });
  }
}

type ParsedNameStatusEntry = {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: ConflictRuntimeFileDiff["status"];
};

function parseGitNameStatusZ(output: string): readonly ParsedNameStatusEntry[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const entries: ParsedNameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; ) {
    const rawStatus = tokens[index++];
    if (!rawStatus) break;
    const statusCode = rawStatus[0];
    if (statusCode === "R" || statusCode === "C") {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (!previousPath || !path) {
        throw new Error("conflict_git_name_status_invalid");
      }
      entries.push({
        path,
        previousPath,
        status: statusCode === "R" ? "renamed" : "copied",
      });
      continue;
    }
    const path = tokens[index++];
    if (!path) {
      throw new Error("conflict_git_name_status_invalid");
    }
    entries.push({
      path,
      status: mapGitStatus(statusCode),
    });
  }
  return entries;
}

function mapGitStatus(
  status: string | undefined,
): ConflictRuntimeFileDiff["status"] {
  switch (status) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "removed";
    case "T":
    case "U":
    case "X":
      return "changed";
    default:
      throw new Error("conflict_git_name_status_unsupported");
  }
}

function looksLikeBinaryDiff(patch: string): boolean {
  return /^(Binary files|GIT binary patch)/m.test(patch);
}

function hasUnsupportedGitFileMode(patch: string): boolean {
  return (
    /^(?:old mode|new mode|deleted file mode|new file mode) (?:120000|160000)$/m.test(
      patch,
    ) ||
    /^index [a-f0-9.]+\.\.[a-f0-9.]+ (?:120000|160000)$/im.test(patch) ||
    /^Subproject commit /m.test(patch)
  );
}

function assertSha(value: string, label: "base" | "head"): string {
  if (!/^[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`conflict_${label}_sha_invalid`);
  }
  return value;
}
