#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "review-router-public-beta-check-"));
try {
  const logFile = join(tempDir, "calls.log");
  const hostedEnvFile = join(tempDir, "hosted.env");
  const binDir = join(tempDir, "bin");
  writeFileSync(hostedEnvFile, "NODE_ENV=production\n");
  writeStub(binDir, "node", nodeStub(logFile));
  writeStub(binDir, "pnpm", pnpmStub(logFile));

  const result = spawnSync("bash", ["scripts/check-public-beta-readiness.sh"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      REVIEW_ROUTER_HOSTED_ENV_FILE: hostedEnvFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error("ERROR: public beta readiness smoke should pass with stubs");
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }

  const calls = readFileSync(logFile, "utf8");
  assertIncludes(
    calls,
    `node scripts/check-hosted-readiness.mjs hosted=${hostedEnvFile}`,
    "hosted readiness must use REVIEW_ROUTER_HOSTED_ENV_FILE",
  );
  assertIncludes(
    calls,
    `node scripts/check-github-app-readiness.mjs hosted=${hostedEnvFile} appEnv=${hostedEnvFile} mode=hosted requireInstallation=1`,
    "GitHub App readiness must use the same hosted env file in hosted mode and require at least one installation",
  );
  assertIncludes(
    calls,
    `node scripts/check-hosted-web.mjs hosted=${hostedEnvFile}`,
    "hosted web smoke must use REVIEW_ROUTER_HOSTED_ENV_FILE",
  );

  console.log("Public beta readiness smoke passed.");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function writeStub(binDir, name, content) {
  spawnSync("mkdir", ["-p", binDir], { stdio: "ignore" });
  const path = join(binDir, name);
  writeFileSync(path, content, { mode: 0o755 });
}

function nodeStub(logFile) {
  return `#!/usr/bin/env bash
set -euo pipefail
printf 'node %s hosted=%s appEnv=%s mode=%s requireInstallation=%s\\n' "$1" "\${REVIEW_ROUTER_HOSTED_ENV_FILE:-}" "\${REVIEW_ROUTER_GITHUB_APP_ENV_FILE:-}" "\${REVIEW_ROUTER_GITHUB_APP_CHECK_MODE:-}" "\${REVIEW_ROUTER_GITHUB_APP_REQUIRE_INSTALLATION:-}" >> ${JSON.stringify(logFile)}
exit 0
`;
}

function pnpmStub(logFile) {
  return `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(logFile)}
exit 0
`;
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    console.error(`ERROR: ${message}`);
    console.error("Expected to find:");
    console.error(needle);
    console.error("Observed calls:");
    console.error(haystack);
    process.exit(1);
  }
}
