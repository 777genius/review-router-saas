#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntrypoint = path.join(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "reviewrouter-operator-cli.ts",
);
const binDirectory =
  process.env.REVIEW_ROUTER_CLI_BIN_DIR?.trim() ||
  path.join(homedir(), ".local", "bin");
const dataDirectory =
  process.env.REVIEW_ROUTER_CLI_DATA_DIR?.trim() ||
  path.join(
    process.env.XDG_DATA_HOME?.trim() ||
      path.join(homedir(), ".local", "share"),
    "reviewrouter",
  );

const bundle = await build({
  entryPoints: [cliEntrypoint],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  legalComments: "none",
});
const bundleBytes = bundle.outputFiles[0]?.contents;
if (!bundleBytes) throw new Error("reviewrouter_cli_bundle_missing");

const digest = createHash("sha256")
  .update(bundleBytes)
  .digest("hex")
  .slice(0, 16);
const installedBundlePath = path.join(
  dataDirectory,
  `reviewrouter-operator-cli-${digest}.mjs`,
);
const installedPath = path.join(binDirectory, "reviewrouter");
const wrapper = [
  "#!/bin/sh",
  `exec node --conditions=production ${shellQuote(installedBundlePath)} "$@"`,
  "",
].join("\n");

await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
await mkdir(binDirectory, { recursive: true, mode: 0o755 });
await atomicReplace(installedBundlePath, bundleBytes, 0o500);
await atomicReplace(installedPath, wrapper, 0o755);

process.stdout.write(`${installedPath}\n`);

async function atomicReplace(destination, contents, mode) {
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
