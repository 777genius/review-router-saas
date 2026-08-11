#!/usr/bin/env node
import { App } from "@octokit/app";
import {
  cleanupRunnerWorkspace,
  requestJitConfiguration,
  runOneJobRunner,
} from "../../packages/features/release-rollout/dist/adapters/github-jit-bootstrap.js";

const allowed = new Set([
  "--repository",
  "--run-id",
  "--run-attempt",
  "--sha",
  "--label",
]);
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key || !allowed.has(key) || !value || values.has(key))
    throw new Error("private_runner_arguments_invalid");
  values.set(key, value);
}
if (values.size !== allowed.size)
  throw new Error("private_runner_arguments_incomplete");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`private_runner_environment_missing:${name}`);
  return value;
};
const context = {
  repository: values.get("--repository"),
  runId: values.get("--run-id"),
  runAttempt: Number(values.get("--run-attempt")),
  commitSha: values.get("--sha"),
  actor: required("REVIEW_ROUTER_RUNNER_EXPECTED_ACTOR"),
  label: values.get("--label"),
  runnerName: `rr-${values.get("--run-id")}-${values.get("--run-attempt")}`,
};
if (context.repository !== required("REVIEW_ROUTER_RUNNER_EXPECTED_REPOSITORY"))
  throw new Error("private_runner_context_mismatch");

const app = new App({
  appId: required("REVIEW_ROUTER_RUNNER_GITHUB_APP_ID"),
  privateKey: required("REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY"),
});
const response = await app.octokit.request(
  "POST /app/installations/{installation_id}/access_tokens",
  {
    installation_id: Number(
      required("REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID"),
    ),
    repositories: [context.repository.split("/")[1]],
    permissions: { actions: "write", metadata: "read" },
  },
);
const token = response.data.token;
const jitConfig = await requestJitConfiguration(context, token);
for (const name of [
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_ID",
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID",
  "REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
])
  delete process.env[name];
try {
  await runOneJobRunner({
    runnerPath: "/runner/bin/Runner.Listener",
    jitConfig,
    workingDirectory: "/runner",
    timeoutMs: Number(
      process.env.REVIEW_ROUTER_RUNNER_NO_JOB_TIMEOUT_MS ?? "900000",
    ),
  });
} finally {
  await cleanupRunnerWorkspace(["/runner/_work/job", "/runner/tmp/bootstrap"]);
}
