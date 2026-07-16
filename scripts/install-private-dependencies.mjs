#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubKnownHost =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";

const runPnpmInstall = (env = process.env) => {
  const result = spawnSync("pnpm", ["install", ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  if (result.signal) {
    console.error(`pnpm install terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
};

const encodedKey = process.env.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64?.trim();
if (!encodedKey) {
  process.exit(runPnpmInstall());
}

const privateKey = Buffer.from(encodedKey, "base64").toString("utf8").trim();
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

try {
  writeFileSync(keyPath, `${privateKey}\n`, { mode: 0o600 });
  writeFileSync(knownHostsPath, githubKnownHost, { mode: 0o600 });

  const childEnv = { ...process.env };
  delete childEnv.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64;
  childEnv.GIT_SSH_COMMAND = [
    "ssh",
    `-i ${keyPath}`,
    "-o IdentitiesOnly=yes",
    `-o UserKnownHostsFile=${knownHostsPath}`,
    "-o StrictHostKeyChecking=yes",
  ].join(" ");

  process.exitCode = runPnpmInstall(childEnv);
} finally {
  rmSync(sshDir, { force: true, recursive: true });
}
