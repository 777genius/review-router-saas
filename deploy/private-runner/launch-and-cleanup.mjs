#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import {
  cleanupRunnerWorkspace,
  runOneJobRunner,
} from "../../packages/features/release-rollout/dist/adapters/github-jit-bootstrap.js";

if (
  Object.keys(process.env).some(
    (name) =>
      name.includes("TOKEN") ||
      name.includes("PRIVATE_KEY") ||
      name.startsWith("REVIEW_ROUTER_RUNNER_GITHUB_APP_"),
  )
)
  throw new Error("private_runner_launcher_credential_inheritance_forbidden");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`private_runner_launcher_missing:${name}`);
  return value;
};
const jitPath = required("REVIEW_ROUTER_RUNNER_JIT_CONFIG_FILE");
const jitConfig = readFileSync(jitPath, "utf8");
unlinkSync(jitPath);
process.setgid?.(10001);
process.setuid?.(10001);
try {
  await runOneJobRunner({
    runnerPath: "/runner/bin/Runner.Listener",
    jitConfig,
    workingDirectory: "/runner",
    timeoutMs: Number(required("REVIEW_ROUTER_RUNNER_NO_JOB_TIMEOUT_MS")),
    environment: process.env,
  });
} finally {
  const cleanup = await cleanupRunnerWorkspace([
    required("REVIEW_ROUTER_RUNNER_WORK_ROOT"),
  ]);
  process.stdout.write(
    `${JSON.stringify({ canary: required("REVIEW_ROUTER_RUNNER_CLEANUP_CANARY"), cleanup })}\n`,
  );
}
