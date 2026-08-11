#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runRenderRoleBootstrapJob } from "./run-render-codex-rotating-migration-job.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runRenderRoleBootstrapJob(process.env))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "render_role_bootstrap_job_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
