#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import path, { posix as posixPath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFullCommitSha,
  assertSafeRelativePath,
  buildHandoffManifest,
  canonicalJson,
  HANDOFF_MANIFEST_FILE,
  parseHandoffManifest,
  parseProtocolGenerationManifest,
  PROTOCOL_GENERATION_MANIFEST_FILE,
  PUBLIC_GENERATED_DIRECTORY,
  sha256Digest,
  validateContractExportDescriptor,
} from "./lib/review-action-v2-release-manifests.mjs";
import {
  assertGitRepository,
  assertPathClean,
  currentBranch,
  currentCommit,
  listCommitDirectory,
  readCommitFile,
} from "./lib/git-release-artifacts.mjs";

export const DEFAULT_SOURCE_DIRECTORY =
  "packages/protocol-review-action-v2/src/generated";

export function parseArgs(argv, cwd = process.cwd()) {
  const values = {
    saasRepo: path.resolve(cwd),
    actionRepo: "",
    sourceDirectory: DEFAULT_SOURCE_DIRECTORY,
    targetBranch: "",
    expectedHead: "",
    expectedSaasHead: "",
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${option}`);
      }
      index += 1;
      return value;
    };
    if (option === "--saas-repo") values.saasRepo = path.resolve(next());
    else if (option === "--action-repo")
      values.actionRepo = path.resolve(next());
    else if (option === "--source-directory") values.sourceDirectory = next();
    else if (option === "--target-branch") values.targetBranch = next();
    else if (option === "--expected-head") values.expectedHead = next();
    else if (option === "--expected-saas-head")
      values.expectedSaasHead = next();
    else if (option === "--write") values.write = true;
    else if (option === "--help" || option === "-h") {
      return { help: true };
    } else throw new Error(`unknown option: ${option}`);
  }

  values.sourceDirectory = assertSafeRelativePath(
    values.sourceDirectory,
    "--source-directory",
  );
  values.targetBranch = assertTargetBranch(values.targetBranch);
  values.expectedHead = assertFullCommitSha(
    values.expectedHead,
    "--expected-head",
  );
  if (values.expectedSaasHead) {
    assertFullCommitSha(values.expectedSaasHead, "--expected-saas-head");
  }
  if (!values.actionRepo) {
    values.actionRepo = path.resolve(
      process.env.REVIEW_ROUTER_ACTION_REPO_PATH ??
        path.join(values.saasRepo, "..", "review-router-action"),
    );
  }
  return Object.freeze(values);
}

export function assertTargetBranch(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "main" ||
    value.startsWith("refs/") ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes(" ")
  ) {
    throw new Error(
      "--target-branch must be an explicit non-main local feature branch",
    );
  }
  return value;
}

export async function exportPublicContract(input) {
  assertGitRepository(input.saasRepo, "SaaS");
  assertGitRepository(input.actionRepo, "public Action");

  const saasSourceCommit = currentCommit(input.saasRepo);
  if (input.expectedSaasHead && input.expectedSaasHead !== saasSourceCommit) {
    throw new Error(
      `SaaS HEAD ${saasSourceCommit} does not match --expected-saas-head ${input.expectedSaasHead}`,
    );
  }
  const branch = currentBranch(input.actionRepo);
  if (branch !== input.targetBranch) {
    throw new Error(
      `public Action worktree is on ${branch}, expected ${input.targetBranch}`,
    );
  }
  const actionHead = currentCommit(input.actionRepo);
  if (actionHead !== input.expectedHead) {
    throw new Error(
      `public Action HEAD ${actionHead} does not match --expected-head ${input.expectedHead}`,
    );
  }

  assertPathClean(
    input.saasRepo,
    input.sourceDirectory,
    "canonical contract output",
  );
  assertPathClean(
    input.actionRepo,
    PUBLIC_GENERATED_DIRECTORY,
    "public generated contract directory",
  );

  const source = loadContractSource(
    input.saasRepo,
    saasSourceCommit,
    input.sourceDirectory,
  );
  const handoff = buildHandoffManifest({
    contract: source.descriptor,
    saasSourceCommit,
    expectedPublicActionBaseCommit: actionHead,
  });
  const handoffBytes = Buffer.from(canonicalJson(handoff));
  const targetRoot = path.join(
    input.actionRepo,
    ...PUBLIC_GENERATED_DIRECTORY.split("/"),
  );
  await assertManagedTarget(input.actionRepo, targetRoot);

  if (input.write) {
    replaceManagedTarget(targetRoot, source.files, handoffBytes);
    await assertExportedTarget(targetRoot, handoff);
  }

  return Object.freeze({
    mode: input.write ? "write" : "dry-run",
    sourceDirectory: input.sourceDirectory,
    targetDirectory: PUBLIC_GENERATED_DIRECTORY,
    targetBranch: input.targetBranch,
    handoff,
    handoffDigest: sha256Digest(handoffBytes),
  });
}

export function loadContractSource(repo, commit, sourceDirectory) {
  const entries = listCommitDirectory(repo, commit, sourceDirectory);
  const manifestEntry = entries.find(
    (entry) => entry.path === PROTOCOL_GENERATION_MANIFEST_FILE,
  );
  if (!manifestEntry) {
    throw new Error(
      `canonical contract output is missing ${PROTOCOL_GENERATION_MANIFEST_FILE}`,
    );
  }
  const generationManifest = parseProtocolGenerationManifest(
    readCommitFile(
      repo,
      commit,
      posixPath.join(sourceDirectory, PROTOCOL_GENERATION_MANIFEST_FILE),
    ).toString("utf8"),
  );
  const files = new Map();
  const generatedFileDigests = {};
  const generatedCodeDigests = {};
  for (const entry of entries) {
    assertRegularGeneratedEntry(entry);
    const bytes = readCommitFile(
      repo,
      commit,
      posixPath.join(sourceDirectory, entry.path),
    );
    const digest = sha256Digest(bytes);
    generatedFileDigests[entry.path] = digest;
    if (/\.(?:[cm]?[jt]s)$/.test(entry.path)) {
      generatedCodeDigests[entry.path] = digest;
    }
    files.set(entry.path, bytes);
  }
  if (
    !generationManifest.canonicalizerDigest &&
    Object.keys(generatedCodeDigests).length === 0
  ) {
    throw new Error(
      "canonical contract output must contain generated code or declare canonicalizerDigest",
    );
  }
  const descriptor = validateContractExportDescriptor({
    contractExportVersion: 1,
    protocolVersion: generationManifest.protocolVersion,
    schemaDigest: generationManifest.schemaDigest,
    canonicalizerDigest:
      generationManifest.canonicalizerDigest ??
      sha256Digest(canonicalJson(generatedCodeDigests)),
    goldenFixtureDigest: generationManifest.goldenFixtureDigest,
    generatedFileDigests,
  });
  return Object.freeze({ descriptor, files });
}

function assertRegularGeneratedEntry(entry) {
  if (entry.type !== "blob" || entry.mode !== "100644") {
    throw new Error(
      `generated contract entry must be a non-executable regular file: ${entry.path}`,
    );
  }
}

async function assertManagedTarget(actionRepo, targetRoot) {
  assertNoSymlinkAncestors(actionRepo, targetRoot);
  if (!existsSync(targetRoot)) return;
  if (!lstatSync(targetRoot).isDirectory()) {
    throw new Error("public generated contract target must be a directory");
  }
  const files = await collectFiles(targetRoot);
  if (files.length === 0) return;
  if (!files.includes(HANDOFF_MANIFEST_FILE)) {
    throw new Error(
      "refusing to overwrite public generated target without a handoff manifest",
    );
  }
  const handoff = parseHandoffManifest(
    readFileSync(path.join(targetRoot, HANDOFF_MANIFEST_FILE), "utf8"),
  );
  const expected = [
    ...Object.keys(handoff.generatedFileDigests),
    HANDOFF_MANIFEST_FILE,
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(
      "refusing to overwrite handwritten or unmanaged files in public generated target",
    );
  }
  for (const file of Object.keys(handoff.generatedFileDigests)) {
    const digest = sha256Digest(readFileSync(path.join(targetRoot, file)));
    if (digest !== handoff.generatedFileDigests[file]) {
      throw new Error(
        `existing generated file does not match handoff: ${file}`,
      );
    }
  }
}

function replaceManagedTarget(targetRoot, files, handoffBytes) {
  const parent = path.dirname(targetRoot);
  mkdirSync(parent, { recursive: true });
  const suffix = randomUUID();
  const staging = `${targetRoot}.staging-${suffix}`;
  const backup = `${targetRoot}.backup-${suffix}`;
  mkdirSync(staging, { recursive: true, mode: 0o755 });
  try {
    for (const [relativeFile, bytes] of files) {
      const destination = path.join(staging, ...relativeFile.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      writeFileSync(destination, bytes, { mode: 0o644 });
    }
    writeFileSync(path.join(staging, HANDOFF_MANIFEST_FILE), handoffBytes, {
      mode: 0o644,
    });
    if (existsSync(targetRoot)) renameSync(targetRoot, backup);
    try {
      renameSync(staging, targetRoot);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, targetRoot);
      throw error;
    }
    rmSync(backup, { force: true, recursive: true });
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

async function assertExportedTarget(targetRoot, handoff) {
  const files = await collectFiles(targetRoot);
  const expected = [
    ...Object.keys(handoff.generatedFileDigests),
    HANDOFF_MANIFEST_FILE,
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error("exported target file inventory is incomplete");
  }
  for (const file of Object.keys(handoff.generatedFileDigests)) {
    const actual = sha256Digest(readFileSync(path.join(targetRoot, file)));
    if (actual !== handoff.generatedFileDigests[file]) {
      throw new Error(`exported target digest mismatch for ${file}`);
    }
  }
  parseHandoffManifest(
    readFileSync(path.join(targetRoot, HANDOFF_MANIFEST_FILE), "utf8"),
  );
}

async function collectFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(
        `generated target must not contain symlinks: ${relative}`,
      );
    }
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(root, absolute)));
    } else if (entry.isFile()) {
      result.push(relative);
    } else {
      throw new Error(
        `generated target contains an unsupported entry: ${relative}`,
      );
    }
  }
  return result.sort();
}

function assertNoSymlinkAncestors(repository, target) {
  const relativeTarget = path.relative(repository, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(
      "generated target must stay inside the public Action repository",
    );
  }
  let current = repository;
  for (const segment of relativeTarget.split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`generated target path contains a symlink: ${current}`);
    }
  }
}

function usage() {
  return `Usage:
  pnpm protocol:export-public --target-branch <feature-branch> --expected-head <40-char-sha> [options]

Options:
  --action-repo <path>         Public Action Git worktree.
  --saas-repo <path>           SaaS Git worktree. Default: current directory.
  --source-directory <path>    Canonical generated source within SaaS.
  --expected-saas-head <sha>   Optional exact SaaS HEAD fence.
  --write                      Atomically replace only the managed generated target.
  --help                       Show this help.

Without --write the command validates both repositories and prints a dry-run manifest.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  console.log(canonicalJson(await exportPublicContract(args)).trimEnd());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
