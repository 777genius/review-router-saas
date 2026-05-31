#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const outfile = "action-dist/index.cjs";
const bundledCodexOutfile = "action-dist/codex/linux-x64/codex";
const bundledCodexArchiveOutfile =
  "action-dist/codex/linux-x64/codex-linux-x64.tgz";
const bundledCodexManifestOutfile = "action-dist/codex/linux-x64/manifest.json";
const codexPackageVersion = "0.135.0";
const codexPlatform = "linux-x64";
const codexBinaryPathInArchive =
  "package/vendor/x86_64-unknown-linux-musl/bin/codex";

mkdirSync(dirname(outfile), { recursive: true });

run("pnpm", [
  "exec",
  "esbuild",
  "packages/features/codex-oauth-rotating/src/action/github-action.ts",
  "--bundle",
  "--platform=node",
  "--target=node20",
  "--format=cjs",
  "--legal-comments=none",
  `--outfile=${outfile}`,
]);

rmSync(bundledCodexOutfile, { force: true });

const codexLinuxX64PackageTarball =
  process.env.REVIEWROUTER_CODEX_LINUX_X64_PACKAGE_TARBALL;
const codexLinuxX64Binary = process.env.REVIEWROUTER_CODEX_LINUX_X64_BINARY;

if (codexLinuxX64PackageTarball) {
  const sourceStats = statSync(codexLinuxX64PackageTarball);
  if (!sourceStats.isFile()) {
    throw new Error(
      "REVIEWROUTER_CODEX_LINUX_X64_PACKAGE_TARBALL must point to a file",
    );
  }
  mkdirSync(dirname(bundledCodexArchiveOutfile), { recursive: true });
  copyFileSync(codexLinuxX64PackageTarball, bundledCodexArchiveOutfile);
  await writeArchiveManifest(bundledCodexArchiveOutfile);
  console.log(
    `Bundled Codex linux-x64 archive: ${join(process.cwd(), bundledCodexArchiveOutfile)}`,
  );
} else if (codexLinuxX64Binary) {
  const sourceStats = statSync(codexLinuxX64Binary);
  if (!sourceStats.isFile()) {
    throw new Error("REVIEWROUTER_CODEX_LINUX_X64_BINARY must point to a file");
  }
  mkdirSync(dirname(bundledCodexArchiveOutfile), { recursive: true });
  const stagingDir = mkdtempSync(join(tmpdir(), "reviewrouter-codex-package-"));
  const stagedBinary = join(stagingDir, codexBinaryPathInArchive);
  mkdirSync(dirname(stagedBinary), { recursive: true });
  copyFileSync(codexLinuxX64Binary, stagedBinary);
  chmodSync(stagedBinary, 0o755);
  run("tar", [
    "-czf",
    join(process.cwd(), bundledCodexArchiveOutfile),
    "-C",
    stagingDir,
    "package",
  ]);
  rmSync(stagingDir, { recursive: true, force: true });
  await writeArchiveManifest(bundledCodexArchiveOutfile);
  console.log(
    `Bundled Codex linux-x64 archive: ${join(process.cwd(), bundledCodexArchiveOutfile)}`,
  );
}

async function writeArchiveManifest(archivePath) {
  const archiveStats = statSync(archivePath);
  if (!archiveStats.isFile()) {
    throw new Error("Codex linux-x64 archive must be a file");
  }
  const extractionDir = mkdtempSync(
    join(tmpdir(), "reviewrouter-codex-verify-"),
  );
  run("tar", ["-xzf", join(process.cwd(), archivePath), "-C", extractionDir]);
  const binaryPath = join(extractionDir, codexBinaryPathInArchive);
  const binaryStats = statSync(binaryPath);
  if (!binaryStats.isFile()) {
    throw new Error("Codex linux-x64 archive does not contain codex binary");
  }
  await writeFile(
    bundledCodexManifestOutfile,
    `${JSON.stringify(
      {
        protocolVersion: 1,
        packageName: "@openai/codex",
        version: codexPackageVersion,
        platform: codexPlatform,
        archive: "codex-linux-x64.tgz",
        archiveSize: archiveStats.size,
        archiveSha256: await sha256File(archivePath),
        binaryPathInArchive: codexBinaryPathInArchive,
        binary: "codex",
        size: binaryStats.size,
        sha256: await sha256File(binaryPath),
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  rmSync(extractionDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
