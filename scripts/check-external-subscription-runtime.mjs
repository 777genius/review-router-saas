#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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
const expectedSpecifier = `git+ssh://git@github.com/777genius/ar.git#${pinnedCommit}`;
const expectedTarball = `https://codeload.github.com/777genius/ar/tar.gz/${pinnedCommit}`;
const expectedPackageKey = `@vioxen/subscription-runtime@${expectedTarball}`;
const lockfile = parse(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
const importerDependency =
  lockfile?.importers?.["."]?.optionalDependencies?.[
    "@777genius/subscription-runtime"
  ];
const linkedPackageKey =
  typeof importerDependency?.version === "string"
    ? importerDependency.version.match(
        /^(@vioxen\/subscription-runtime@https:\/\/codeload\.github\.com\/777genius\/ar\/tar\.gz\/[0-9a-f]{40})(?:\(|$)/u,
      )?.[1]
    : undefined;
const resolution =
  linkedPackageKey === undefined
    ? undefined
    : lockfile?.packages?.[linkedPackageKey]?.resolution;

if (
  importerDependency?.specifier !== expectedSpecifier ||
  linkedPackageKey !== expectedPackageKey ||
  resolution?.tarball !== expectedTarball
) {
  throw new Error(
    "subscription runtime package.json, importer, and immutable codeload package do not match",
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
