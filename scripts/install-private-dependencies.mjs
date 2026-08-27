#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubKnownHost =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";

const requireDeployKeyFlag = "--require-deploy-key";
const installArguments = process.argv.slice(2);
const requireDeployKey = installArguments.includes(requireDeployKeyFlag);
const forwardedInstallArguments = installArguments.filter(
  (argument) => argument !== requireDeployKeyFlag,
);

const runPnpmInstall = (env = process.env, disableScripts = false) => {
  const installEnv = { ...env, NODE_ENV: "development" };
  const args = ["install", ...forwardedInstallArguments];
  if (disableScripts && !args.includes("--ignore-scripts"))
    args.push("--ignore-scripts");
  const result = spawnSync("pnpm", args, { env: installEnv, stdio: "inherit" });
  if (result.signal) {
    console.error(`pnpm install terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
};

const encodedKey = process.env.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64?.trim();
if (!encodedKey) {
  if (requireDeployKey) {
    console.error("SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 is required");
    process.exit(1);
  }
  process.exit(runPnpmInstall());
}

// Do not retain the encoded credential in this process environment after it
// has been copied into process-private memory for validation.
delete process.env.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64;

const normalizedEncodedKey = encodedKey.replace(/\s+/gu, "");
if (
  normalizedEncodedKey.length % 4 !== 0 ||
  !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalizedEncodedKey)
) {
  console.error("SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 is not valid base64");
  process.exit(1);
}

const privateKey = Buffer.from(normalizedEncodedKey, "base64")
  .toString("utf8")
  .trim();
if (
  !privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----") ||
  !privateKey.endsWith("-----END OPENSSH PRIVATE KEY-----")
) {
  console.error("SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 is not an OpenSSH key");
  process.exit(1);
}

const sshDir = mkdtempSync(join(tmpdir(), "reviewrouter-private-dependency-"));
const keyPath = join(sshDir, "id_ed25519");
const knownHostsPath = join(sshDir, "known_hosts");
let teardownFailure;

try {
  writeFileSync(keyPath, `${privateKey}\n`, { mode: 0o600 });
  writeFileSync(knownHostsPath, githubKnownHost, { mode: 0o600 });

  const keyValidation = spawnSync("ssh-keygen", ["-y", "-f", keyPath], {
    stdio: "ignore",
  });
  if (keyValidation.signal || keyValidation.status !== 0) {
    console.error(
      "SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 is not a valid OpenSSH private key",
    );
    process.exitCode = 1;
  } else {
    const childEnv = { ...process.env };
    delete childEnv.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64;
    childEnv.GIT_SSH_COMMAND = [
      "ssh",
      `-i ${keyPath}`,
      "-o IdentitiesOnly=yes",
      `-o UserKnownHostsFile=${knownHostsPath}`,
      "-o StrictHostKeyChecking=yes",
    ].join(" ");

    // Fetch/link only. Arbitrary package lifecycle code must never execute in
    // the environment that carries the deploy-key-backed SSH command.
    process.exitCode = runPnpmInstall(childEnv, true);
  }
} finally {
  rmSync(sshDir, { force: true, recursive: true });
  delete process.env.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64;
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH_VARIANT;
  if (existsSync(sshDir) || existsSync(keyPath) || existsSync(knownHostsPath))
    teardownFailure = new Error(
      "private dependency credential teardown failed",
    );
  else if (
    process.env.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 !== undefined ||
    process.env.GIT_SSH_COMMAND !== undefined ||
    process.env.GIT_SSH_VARIANT !== undefined
  )
    teardownFailure = new Error(
      "private dependency credential environment survived",
    );
  else console.error("private dependency credential teardown verified");
}

if (teardownFailure) throw teardownFailure;
