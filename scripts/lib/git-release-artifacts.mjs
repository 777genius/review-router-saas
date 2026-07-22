import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  assertFullCommitSha,
  assertSafeRelativePath,
} from "./review-action-v2-release-manifests.mjs";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

export function assertGitRepository(repo, label) {
  if (!existsSync(repo)) {
    throw new Error(`${label} repository not found: ${repo}`);
  }
  const root = gitText(repo, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== realpathSync(repo)) {
    throw new Error(`${label} repository path must be its Git root: ${repo}`);
  }
}

export function currentCommit(repo) {
  return assertFullCommitSha(
    gitText(repo, ["rev-parse", "HEAD"]),
    "current Git HEAD",
  );
}

export function currentBranch(repo) {
  const branch = gitText(repo, ["branch", "--show-current"]);
  if (!branch) {
    throw new Error("target repository must not use a detached HEAD");
  }
  return branch;
}

export function assertCommitExists(repo, commit, label) {
  assertFullCommitSha(commit, label);
  const result = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${label} does not exist as a commit in ${repo}`);
  }
}

export function assertPathClean(repo, relativePath, label) {
  const normalized = assertSafeRelativePath(relativePath, `${label} path`);
  const status = gitText(repo, ["status", "--porcelain=v1", "--", normalized]);
  if (status) {
    throw new Error(`${label} has uncommitted changes: ${normalized}`);
  }
}

export function assertRepositoryClean(repo, label) {
  const status = gitText(repo, ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error(`${label} repository must be clean`);
  }
}

export function assertAncestor(repo, ancestor, descendant) {
  assertFullCommitSha(ancestor, "ancestor commit");
  assertFullCommitSha(descendant, "descendant commit");
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `expected public Action base ${ancestor} is not an ancestor of ${descendant}`,
    );
  }
}

export function listCommitDirectory(repo, commit, relativeDirectory) {
  assertFullCommitSha(commit, "Git tree commit");
  const directory = assertSafeRelativePath(
    relativeDirectory,
    "Git tree directory",
  ).replace(/\/$/, "");
  const output = gitBuffer(repo, [
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    directory,
  ]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) {
        throw new Error(`unexpected git ls-tree record: ${record}`);
      }
      const [mode, type, object] = record.slice(0, separator).split(" ");
      const fullPath = record.slice(separator + 1);
      const prefix = `${directory}/`;
      if (!fullPath.startsWith(prefix)) {
        throw new Error(`Git tree path escaped ${directory}: ${fullPath}`);
      }
      return Object.freeze({
        mode,
        type,
        object,
        path: fullPath.slice(prefix.length),
      });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readCommitFile(repo, commit, relativePath) {
  assertFullCommitSha(commit, "Git file commit");
  const file = assertSafeRelativePath(relativePath, "Git file path");
  try {
    return gitBuffer(repo, ["show", `${commit}:${file}`]);
  } catch {
    throw new Error(`Git file is missing at ${commit}: ${file}`);
  }
}

export function gitText(repo, args) {
  return gitBuffer(repo, args).toString("utf8").trim();
}

function gitBuffer(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
