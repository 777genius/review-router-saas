#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const dependencySource =
  manifest.optionalDependencies?.["@777genius/subscription-runtime"];
const sourceMatch =
  /^git\+ssh:\/\/git@github\.com\/777genius\/ar\.git#([0-9a-f]{40})$/u.exec(
    dependencySource ?? "",
  );

if (!sourceMatch) {
  throw new Error(
    "subscription runtime must be pinned to an immutable 777genius/ar commit SHA",
  );
}

const pinnedCommit = sourceMatch[1];
const lockfile = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
if (
  !lockfile.includes(`commit: ${pinnedCommit}`) ||
  !lockfile.includes(
    `specifier: git+ssh://git@github.com/777genius/ar.git#${pinnedCommit}`,
  )
) {
  throw new Error(
    "subscription runtime package.json and pnpm lockfile pins do not match",
  );
}

const checks = [
  ["@777genius/subscription-runtime/core", "createSubscriptionRuntime"],
  ["@777genius/subscription-runtime/provider-codex", "CodexCliSessionDriver"],
  [
    "@777genius/subscription-runtime/runner-github-action",
    "GitHubActionRunner",
  ],
  [
    "@777genius/subscription-runtime/store-local-file",
    "createLocalFileBackendRuntimeAdapters",
  ],
  [
    "@777genius/subscription-runtime/worker-core",
    "BoundedSubscriptionWorkerPool",
  ],
  ["@777genius/subscription-runtime/worker-codex", "FileBackendCodexWorker"],
  [
    "@777genius/subscription-runtime/queue-core",
    "InMemorySubscriptionTaskQueue",
  ],
  ["@777genius/subscription-runtime/queue-bullmq", "BullSubscriptionTaskQueue"],
  ["@777genius/subscription-runtime/testing", "InMemorySessionStore"],
];

for (const [specifier, exportName] of checks) {
  const mod = await import(specifier);
  if (typeof mod[exportName] !== "function") {
    throw new Error(`${specifier} is missing ${exportName}`);
  }
}

console.log("External subscription runtime imports OK.");
