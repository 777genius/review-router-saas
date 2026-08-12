#!/usr/bin/env node
import { App } from "@octokit/app";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { requestJitConfiguration } from "../../packages/features/release-rollout/dist/adapters/github-jit-bootstrap.js";

if (process.getuid?.() !== 0)
  throw new Error("private_runner_credential_bootstrap_must_be_root");
if (process.env.REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY)
  throw new Error("private_runner_private_key_environment_forbidden");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`private_runner_environment_missing:${name}`);
  return value;
};
if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--context" ||
  !/^[A-Za-z0-9_-]+$/u.test(process.argv[3] ?? "")
)
  throw new Error("private_runner_arguments_invalid");
const context = JSON.parse(
  Buffer.from(process.argv[3], "base64url").toString("utf8"),
);
const keyPath = required("REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY_FILE");
if (!keyPath.startsWith("/run/secrets/"))
  throw new Error("private_runner_private_key_path_invalid");
const keyStat = lstatSync(keyPath);
if (!keyStat.isFile() || keyStat.uid !== 0 || (keyStat.mode & 0o077) !== 0)
  throw new Error("private_runner_private_key_permissions_invalid");
const privateKey = readFileSync(keyPath, "utf8");
unlinkSync(keyPath);
const app = new App({
  appId: required("REVIEW_ROUTER_RUNNER_GITHUB_APP_ID"),
  privateKey,
});
const response = await app.octokit.request(
  "POST /app/installations/{installation_id}/access_tokens",
  {
    installation_id: Number(
      required("REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID"),
    ),
    repositories: [String(context.repository).split("/")[1]],
    permissions: {
      organization_self_hosted_runners: "write",
      actions: "read",
      metadata: "read",
    },
  },
);
const jitConfig = await requestJitConfiguration(context, response.data.token);
const jitPath = "/run/reviewrouter/jit-config";
writeFileSync(jitPath, jitConfig, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
chmodSync(jitPath, 0o600);
for (const name of Object.keys(process.env)) {
  if (
    name.includes("TOKEN") ||
    name.includes("PRIVATE_KEY") ||
    name.startsWith("REVIEW_ROUTER_RUNNER_GITHUB_APP_")
  )
    delete process.env[name];
}
const environment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  LANG: process.env.LANG ?? "C.UTF-8",
  HOME: "/home/runner",
  REVIEW_ROUTER_RUNNER_JIT_CONFIG_FILE: jitPath,
  REVIEW_ROUTER_RUNNER_CLEANUP_CANARY: String(context.cleanupCanary),
  REVIEW_ROUTER_RUNNER_NO_JOB_TIMEOUT_MS: String(context.timeoutMs ?? 900000),
};
if (typeof process.execve !== "function")
  throw new Error("private_runner_execve_unavailable");
process.execve(
  process.execPath,
  [process.execPath, "/runner/launch-and-cleanup.mjs"],
  environment,
);
