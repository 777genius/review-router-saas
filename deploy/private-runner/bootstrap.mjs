#!/usr/bin/env node
import { App } from "@octokit/app";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
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
  process.argv.length !== 6 ||
  process.argv[2] !== "--intent" ||
  !/^rri-[a-f0-9]{64}$/u.test(process.argv[3] ?? "") ||
  process.argv[4] !== "--context" ||
  !/^[A-Za-z0-9_-]+$/u.test(process.argv[5] ?? "")
)
  throw new Error("private_runner_arguments_invalid");
const context = JSON.parse(
  Buffer.from(process.argv[5], "base64url").toString("utf8"),
);
if (context.provisioningIntentId !== process.argv[3])
  throw new Error("private_runner_intent_binding_invalid");
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
const registration = await requestJitConfiguration(
  context,
  response.data.token,
);
const registrationMetadata = Object.freeze({
  runnerId: registration.runnerId,
  runnerGroupId: registration.runnerGroupId,
  labels: registration.labels,
  uniqueLabel: registration.uniqueLabel,
  workFolder: registration.workFolder,
});
const ledgerResponse = await globalThis.fetch(
  `${required("REVIEW_ROUTER_RUNNER_LEDGER_URL").replace(/\/$/u, "")}/v1/runner-jobs/registration`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      rolloutId: context.rolloutId,
      lifecycle: context.lifecycle,
      workflowJobId: context.workflowJobId,
      registration: registrationMetadata,
    }),
  },
);
if (!ledgerResponse.ok)
  throw new Error(
    `private_runner_registration_persist_failed:${ledgerResponse.status}`,
  );
const workRoot = `/runner/${registration.workFolder}`;
mkdirSync(workRoot, { recursive: false, mode: 0o700 });
const workStat = lstatSync(workRoot);
if (!workStat.isDirectory() || workStat.isSymbolicLink() || workStat.uid !== 0)
  throw new Error("private_runner_work_root_invalid");
chownSync(workRoot, 10001, 10001);
const jitPath = "/run/reviewrouter/jit-config";
writeFileSync(jitPath, registration.encodedJitConfig, {
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
  REVIEW_ROUTER_RUNNER_WORK_ROOT: workRoot,
};
if (typeof process.execve !== "function")
  throw new Error("private_runner_execve_unavailable");
process.execve(
  process.execPath,
  [process.execPath, "/runner/launch-and-cleanup.mjs"],
  environment,
);
