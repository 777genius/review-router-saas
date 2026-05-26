#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "reviewrouter-live-e2e-smoke-"));

try {
  const binDir = join(tempDir, "bin");
  const callsFile = join(tempDir, "calls.log");
  writeStub(binDir, "gh", ghStub(callsFile));
  for (const command of ["git", "bash", "node", "pnpm"]) {
    writeStub(binDir, command, versionStub(command, callsFile));
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL:
      "https://api.reviewrouter.example",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF:
      "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE: join(tempDir, "auth.json"),
    REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX: "public,private",
    REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_SKIP_ENV_FILES: "1",
  };

  const prereq = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (prereq.status !== 0) {
    fail("check-only live E2E readiness should pass with stubs", prereq);
  }
  if (!prereq.stdout.includes("rr-codex-rotating-e2e-public:public")) {
    fail("check-only output should include public disposable target", prereq);
  }
  if (!prereq.stdout.includes("rr-codex-rotating-e2e-private:private")) {
    fail("check-only output should include private disposable target", prereq);
  }

  const guardedRun = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (guardedRun.status === 0) {
    fail("live E2E run must require explicit mutation opt-in", guardedRun);
  }
  if (
    !guardedRun.stderr.includes(
      "REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1",
    )
  ) {
    fail("guarded run should explain the explicit mutation opt-in", guardedRun);
  }

  const calls = readFileSync(callsFile, "utf8");
  for (const path of [
    "action.yml",
    "action-dist/index.cjs",
    "action-dist/codex/linux-x64/codex-linux-x64.tgz",
    "action-dist/codex/linux-x64/manifest.json",
  ]) {
    if (!calls.includes(path)) {
      console.error(
        `ERROR: action artifact fetch check did not request ${path}`,
      );
      console.error(calls);
      process.exit(1);
    }
  }

  console.log("Subscription Runtime live E2E smoke passed.");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function writeStub(binDir, name, content) {
  spawnSync("mkdir", ["-p", binDir], { stdio: "ignore" });
  writeFileSync(join(binDir, name), content, { mode: 0o755 });
}

function versionStub(command, callsFile) {
  return `#!/bin/bash
set -euo pipefail
printf '%s %s\\n' ${JSON.stringify(command)} "$*" >> ${JSON.stringify(callsFile)}
if [ "\${1:-}" = "--version" ]; then
  echo "${command} 1.0.0"
fi
exit 0
`;
}

function ghStub(callsFile) {
  return `#!/bin/bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> ${JSON.stringify(callsFile)}
if [ "\${1:-}" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi
if [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then
  exit 0
fi
if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "user" ]; then
  echo "777genius"
  exit 0
fi
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == repos/777genius/review-router/contents/* ]]; then
  echo "1"
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
}

function fail(message, result) {
  console.error(`ERROR: ${message}`);
  console.error("stdout:");
  console.error(result.stdout);
  console.error("stderr:");
  console.error(result.stderr);
  process.exit(1);
}
