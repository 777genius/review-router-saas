#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const saasRepo = path.resolve(
  args.saasRepo ?? process.env.REVIEW_ROUTER_SAAS_REPO_PATH ?? process.cwd(),
);
const actionRepo = path.resolve(
  args.actionRepo ??
    process.env.REVIEW_ROUTER_ACTION_REPO_PATH ??
    path.join(saasRepo, "..", "review-router-action"),
);
const write = isTrue(args.write) || isTrue(args.confirm);

const syncedFiles = [
  "action.yml",
  "action-dist/index.cjs",
  "action-dist/codex/linux-x64/codex-linux-x64.tgz",
  "action-dist/codex/linux-x64/manifest.json",
];

assertGitRepo("saas", saasRepo);
assertGitRepo("action", actionRepo);
assertActionRepoOnMain(actionRepo);

for (const file of syncedFiles) {
  assertReadableFile(path.join(saasRepo, file));
}

assertFreshExternalSubscriptionRuntime(
  path.join(saasRepo, "action-dist/index.cjs"),
);

console.log(`SaaS repo: ${saasRepo}`);
console.log(`Action repo: ${actionRepo}`);
console.log(`Mode: ${write ? "write" : "dry-run"}`);

for (const file of syncedFiles) {
  const source = path.join(saasRepo, file);
  const target = path.join(actionRepo, file);
  const sourceStats = statSync(source);
  const targetStats = existsSync(target) ? statSync(target) : null;
  const targetLabel = targetStats ? `${targetStats.size} bytes` : "missing";
  console.log(`${file}: ${targetLabel} -> ${sourceStats.size} bytes`);

  if (write) {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

if (!write) {
  console.log("Dry-run only. Re-run with --write to copy files.");
  process.exit(0);
}

console.log("");
console.log("Action repo status after sync:");
console.log(
  git(actionRepo, ["status", "--short", "--", ...syncedFiles]) || "<clean>",
);

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      continue;
    }
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

function isTrue(value) {
  return value === true || value === "1" || value === "true";
}

function assertGitRepo(name, repo) {
  if (!existsSync(repo)) {
    throw new Error(`${name} repo not found: ${repo}`);
  }
  const topLevel = git(repo, ["rev-parse", "--show-toplevel"]);
  if (path.resolve(topLevel) !== repo) {
    throw new Error(`${name} repo path is not its git root: ${repo}`);
  }
}

function assertActionRepoOnMain(repo) {
  const branch = git(repo, ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(
      `action repo must be on main before syncing public @main, got ${branch || "<detached>"}`,
    );
  }
}

function assertReadableFile(file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`required source file is missing: ${file}`);
  }
}

function assertFreshExternalSubscriptionRuntime(bundlePath) {
  const bundle = readFileSync(bundlePath, "utf8");
  if (!bundle.includes("@vioxen/subscription-runtime")) {
    throw new Error(
      "action bundle does not include external @vioxen/subscription-runtime; run pnpm action:build from the updated SaaS repo first",
    );
  }
  if (!bundle.includes("777genius+ar")) {
    throw new Error(
      "action bundle does not include 777genius/ar dependency metadata; refresh dependencies and rebuild before syncing",
    );
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
