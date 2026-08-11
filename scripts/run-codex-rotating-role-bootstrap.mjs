#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { executeCanonicalRoleBootstrap } from "./run-codex-rotating-release-migration.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(executeCanonicalRoleBootstrap())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "role_bootstrap_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
