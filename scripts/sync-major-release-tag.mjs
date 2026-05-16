import { execFileSync } from "node:child_process";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const version = requiredArg(args, "version");
const major = args.major ?? deriveMajorTag(version);
const confirm = args.confirm === "1" || args.confirm === "true";
const saasRepo = path.resolve(
  args.saasRepo ?? process.env.REVIEW_ROUTER_SAAS_REPO_PATH ?? process.cwd(),
);
const actionRepo = path.resolve(
  args.actionRepo ??
    process.env.REVIEW_ROUTER_ACTION_REPO_PATH ??
    path.join(saasRepo, "..", "review-router-action"),
);

if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  throw new Error("--version must look like v1.0.37");
}
if (!/^v[0-9]+$/.test(major)) {
  throw new Error("--major must look like v1");
}

const repos = [
  { name: "saas", cwd: saasRepo },
  { name: "action", cwd: actionRepo },
];

for (const repo of repos) {
  assertCleanRepo(repo);
  const targetSha = git(repo.cwd, ["rev-parse", `${version}^{}`]);
  const remoteTargetSha = lsRemoteTag(repo.cwd, version);
  if (remoteTargetSha && remoteTargetSha !== targetSha) {
    throw new Error(
      `${repo.name} local ${version} ${targetSha} does not match remote ${remoteTargetSha}`,
    );
  }
  const currentMajorSha = lsRemoteTag(repo.cwd, major);
  console.log(
    `${repo.name}: ${major} ${currentMajorSha || "<missing>"} -> ${targetSha}`,
  );
}

if (!confirm) {
  console.log("dry-run only. Re-run with --confirm to move remote tags.");
  process.exit(0);
}

for (const repo of repos) {
  git(repo.cwd, ["tag", "-f", major, version], { stdio: "inherit" });
  git(repo.cwd, ["push", "--force", "origin", `refs/tags/${major}`], {
    stdio: "inherit",
  });
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = rawArgs[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function deriveMajorTag(version) {
  return version.split(".")[0];
}

function assertCleanRepo(repo) {
  const topLevel = git(repo.cwd, ["rev-parse", "--show-toplevel"]);
  const status = git(repo.cwd, ["status", "--short"]);
  if (status.trim()) {
    throw new Error(`${repo.name} repo is not clean: ${topLevel}`);
  }
}

function lsRemoteTag(cwd, tag) {
  const output = git(cwd, [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);
  const sha = output.trim().split(/\s+/)[0];
  return sha || null;
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}
