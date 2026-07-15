#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const actionYmlPath = join(root, "action.yml");
const bundlePath = join(root, "action-dist", "index.cjs");
const codexRawBinaryPath = join(
  root,
  "action-dist",
  "codex",
  "linux-x64",
  "codex",
);
const codexArchivePath = join(
  root,
  "action-dist",
  "codex",
  "linux-x64",
  "codex-linux-x64.tgz",
);
const codexManifestPath = join(
  root,
  "action-dist",
  "codex",
  "linux-x64",
  "manifest.json",
);
const codexPackageName = "@openai/codex";
const codexVersion = "0.135.0";
const codexPlatform = "linux-x64";
const codexBinaryPathInArchive =
  "package/vendor/x86_64-unknown-linux-musl/bin/codex";
const maxGitHubFileBytes = 100 * 1024 * 1024;
const requireBinary =
  process.env.REVIEWROUTER_CODEX_ROTATING_ACTION_REQUIRE_BINARY !== "0";

const actionYml = readFileSync(actionYmlPath, "utf8");
const bundle = readFileSync(bundlePath, "utf8");

assertIncludes(actionYml, "using: node24", "action.yml must use node24");
assertIncludes(
  actionYml,
  "main: action-dist/index.cjs",
  "action.yml must point at the bundled runtime",
);
assertIncludes(
  actionYml,
  "provider-instance-id:\n    description:",
  "action.yml must expose provider-instance-id",
);
assertIncludes(
  actionYml,
  "auth-json:\n    description:",
  "action.yml must expose auth-json",
);
assertIncludes(
  actionYml,
  "review-drafts:\n    description:",
  "action.yml must expose review-drafts",
);
assertIncludes(
  actionYml,
  "max-changed-lines:\n    description:",
  "action.yml must expose max-changed-lines",
);

for (const forbidden of [
  "runs.pre",
  "pre-if:",
  "post:",
  "post-if:",
  "codex-package-version",
  "codex-binary",
]) {
  assertNotIncludes(
    actionYml,
    forbidden,
    `action.yml must not contain ${forbidden}`,
  );
}

if (/\bdefault:\s*["']?codex-oauth-rotating["']?\b/.test(actionYml)) {
  fail("action.yml must not default mode to codex-oauth-rotating");
}

for (const forbidden of [
  "npx",
  "@openai/codex",
  "codex-package-version",
  "codex-binary",
  "INPUT_CODEX",
]) {
  assertNotIncludes(
    bundle,
    forbidden,
    `action bundle must not contain ${forbidden}`,
  );
}

assertIncludes(
  bundle,
  "codex_bundled_binary_missing",
  "action bundle must fail closed when bundled Codex is missing",
);
assertIncludes(
  bundle,
  "codex_bundled_archive_hash_mismatch",
  "action bundle must validate bundled Codex archive integrity",
);
assertIncludes(
  bundle,
  "codex_bundled_binary_hash_mismatch",
  "action bundle must validate extracted Codex binary integrity",
);
assertIncludes(
  bundle,
  "unsupported_runner_os",
  "action bundle must fail closed on unsupported runner OS before auth",
);
assertIncludes(
  bundle,
  "runner_disk_budget_too_low",
  "action bundle must fail closed on low runner disk before auth",
);
assertIncludes(
  bundle,
  "max_changed_lines_exceeded",
  "action bundle must enforce the changed-line admission limit",
);

if (requireBinary) {
  if (existsSync(codexRawBinaryPath)) {
    fail(
      `Bundled raw Codex binary must not be stored in git-sized action-dist; ${codexRawBinaryPath} exceeds GitHub's 100 MiB file limit. Bundle codex-linux-x64.tgz instead.`,
    );
  }
  if (!existsSync(codexArchivePath)) {
    fail(
      `Bundled Codex linux-x64 archive is missing at ${codexArchivePath}. Build with REVIEWROUTER_CODEX_LINUX_X64_PACKAGE_TARBALL=/path/to/openai-codex-0.135.0-linux-x64.tgz pnpm action:build.`,
    );
  }
  if (!existsSync(codexManifestPath)) {
    fail(
      `Bundled Codex linux-x64 manifest is missing at ${codexManifestPath}.`,
    );
  }
  const archiveLinkStats = lstatSync(codexArchivePath);
  if (archiveLinkStats.isSymbolicLink()) {
    fail("Bundled Codex linux-x64 archive must not be a symlink");
  }
  const manifestLinkStats = lstatSync(codexManifestPath);
  if (manifestLinkStats.isSymbolicLink()) {
    fail("Bundled Codex linux-x64 manifest must not be a symlink");
  }
  const archiveStats = statSync(codexArchivePath);
  if (!archiveStats.isFile()) {
    fail("Bundled Codex linux-x64 archive must be a file");
  }
  if (archiveStats.size < 1_000_000) {
    fail("Bundled Codex linux-x64 archive is unexpectedly small");
  }
  if (archiveStats.size >= maxGitHubFileBytes) {
    fail(
      "Bundled Codex linux-x64 archive must stay below GitHub's 100 MiB file limit",
    );
  }
  const manifest = JSON.parse(readFileSync(codexManifestPath, "utf8"));
  const extracted = extractArchive(codexArchivePath);
  try {
    const binaryPath = join(extracted, codexBinaryPathInArchive);
    const binaryStats = statSync(binaryPath);
    assertManifest(
      manifest,
      archiveStats.size,
      await sha256File(codexArchivePath),
      binaryStats.size,
      await sha256File(binaryPath),
    );
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

console.log(
  requireBinary
    ? "Codex rotating action artifact check passed."
    : "Codex rotating action artifact smoke passed.",
);

function extractArchive(archivePath) {
  const extractionDir = mkdtempSync(
    join(tmpdir(), "reviewrouter-codex-check-"),
  );
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractionDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `Bundled Codex archive could not be extracted: ${result.stderr.trim()}`,
    );
  }
  return extractionDir;
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    fail(message);
  }
}

function assertNotIncludes(haystack, needle, message) {
  if (haystack.includes(needle)) {
    fail(message);
  }
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function assertManifest(
  manifest,
  archiveSize,
  archiveSha256,
  binarySize,
  binarySha256,
) {
  if (
    manifest?.protocolVersion !== 1 ||
    manifest?.packageName !== codexPackageName ||
    manifest?.version !== codexVersion ||
    manifest?.platform !== codexPlatform ||
    manifest?.archive !== "codex-linux-x64.tgz" ||
    manifest?.archiveSize !== archiveSize ||
    manifest?.archiveSha256 !== archiveSha256 ||
    manifest?.binaryPathInArchive !== codexBinaryPathInArchive ||
    manifest?.binary !== "codex" ||
    manifest?.size !== binarySize ||
    manifest?.sha256 !== binarySha256
  ) {
    fail("Bundled Codex linux-x64 manifest does not match the archive");
  }
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
