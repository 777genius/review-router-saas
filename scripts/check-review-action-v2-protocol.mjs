#!/usr/bin/env node
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedRoot = join(
  root,
  "packages",
  "protocol-review-action-v2",
  "src",
);
const contractSourceProducers = [
  "@reviewrouter/features-review-run-control",
  "@reviewrouter/features-review-executions",
  "@reviewrouter/features-review-evidence",
  "@reviewrouter/features-review-investigations",
  "@reviewrouter/features-review-snapshots",
  "@reviewrouter/features-review-publishing",
  "@reviewrouter/features-action-control-plane",
];
const contextAttestationPackageDirectory =
  "packages/features/review-context-attestation";

await bootstrapContractSource();
if (process.argv.includes("--bootstrap-only")) {
  process.exit(0);
}

const before = await snapshotGeneratedFiles();
run(process.execPath, [
  "--conditions=production",
  "scripts/generate-review-action-v2-protocol.mjs",
]);
const first = await snapshotGeneratedFiles();
run(process.execPath, [
  "--conditions=production",
  "scripts/generate-review-action-v2-protocol.mjs",
]);
const second = await snapshotGeneratedFiles();

if (!snapshotsEqual(first, second)) {
  throw new Error("review_action_v2_protocol_generation_nondeterministic");
}

run("pnpm", ["--filter", "@reviewrouter/protocol-review-action-v2", "build"]);
run("pnpm", [
  "--filter",
  "@reviewrouter/features-action-control-plane",
  "typecheck",
]);
run("pnpm", ["--filter", "@reviewrouter/api", "typecheck"]);

if (!snapshotsEqual(before, first)) {
  const changed = changedPaths(before, first);
  console.error(
    `Review Action v2 generated protocol was stale: ${changed.join(", ")}`,
  );
  process.exit(1);
}

console.log("Review Action v2 protocol is deterministic and current.");

async function bootstrapContractSource() {
  for (const packageName of contractSourceProducers) {
    const packageDirectory = packageName.replace(
      "@reviewrouter/features-",
      "packages/features/",
    );
    await rm(join(root, packageDirectory, "dist"), {
      recursive: true,
      force: true,
    });
    run("pnpm", ["--filter", packageName, "build:contract-source"]);
  }
  await rm(
    join(root, contextAttestationPackageDirectory, "dist/contract-source"),
    {
      recursive: true,
      force: true,
    },
  );
  run("pnpm", [
    "exec",
    "tsc",
    "--ignoreConfig",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--rootDir",
    join(root, contextAttestationPackageDirectory, "src"),
    "--outDir",
    join(root, contextAttestationPackageDirectory, "dist"),
    join(
      root,
      contextAttestationPackageDirectory,
      "src/contract-source/index.ts",
    ),
  ]);
  run(process.execPath, ["scripts/rewrite-dist-esm-imports.mjs"]);
}

async function snapshotGeneratedFiles() {
  const files = new Map();
  for (const path of await collectFiles(generatedRoot)) {
    if (path.endsWith("/src/index.ts") || path.includes("/src/generated/")) {
      files.set(relative(generatedRoot, path), await readFile(path, "utf8"));
    }
  }
  return files;
}

async function collectFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function snapshotsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, contents] of left) {
    if (right.get(path) !== contents) return false;
  }
  return true;
}

function changedPaths(left, right) {
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((path) => left.get(path) !== right.get(path))
    .sort();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
}
