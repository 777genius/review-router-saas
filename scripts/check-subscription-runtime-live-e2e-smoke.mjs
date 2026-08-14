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
    REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME: "rr-codex-rotating-e2e-private",
    REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX: "private",
    REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
      "777genius/rr-codex-rotating-e2e-private",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID: "424242",
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "existing",
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
  if (!prereq.stdout.includes("rr-codex-rotating-e2e-private:private")) {
    fail("check-only output should include private disposable target", prereq);
  }

  const missingRecoveryWitness = runCheckOnly(env, {
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "",
  });
  if (
    missingRecoveryWitness.status === 0 ||
    !missingRecoveryWitness.stderr.includes(
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be available",
    )
  ) {
    fail(
      "check-only must require the database recovery witness before mutation",
      missingRecoveryWitness,
    );
  }

  const malformedRecoveryWitness = runCheckOnly(env, {
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(42),
  });
  if (
    malformedRecoveryWitness.status === 0 ||
    !malformedRecoveryWitness.stderr.includes(
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be available",
    )
  ) {
    fail(
      "check-only must reject a malformed database recovery witness",
      malformedRecoveryWitness,
    );
  }

  const existingWithoutId = runCheckOnly(env, {
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "existing",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID: "",
  });
  if (
    existingWithoutId.status === 0 ||
    !existingWithoutId.stderr.includes(
      "requires REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID=424242",
    )
  ) {
    fail(
      "check-only must require immutable ID provenance for an existing repository",
      existingWithoutId,
    );
  }

  const existingWithId = runCheckOnly(env, {
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "existing",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID: "424242",
  });
  if (existingWithId.status !== 0) {
    fail(
      "check-only must accept the exact immutable ID of an existing repository",
      existingWithId,
    );
  }

  const existingWithWrongId = runCheckOnly(env, {
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "existing",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID: "999999",
  });
  if (
    existingWithWrongId.status === 0 ||
    !existingWithWrongId.stderr.includes("immutable ID mismatch")
  ) {
    fail(
      "check-only must reject the wrong immutable ID for an existing repository",
      existingWithWrongId,
    );
  }

  const recreatedWithOldId = runCheckOnly(env, {
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "recreated",
    REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID: "424242",
  });
  if (
    recreatedWithOldId.status === 0 ||
    !recreatedWithOldId.stderr.includes(
      "immutable ID mismatch: expected 424242, observed 434343",
    )
  ) {
    fail(
      "check-only must reject a repository deleted and recreated under the same name",
      recreatedWithOldId,
    );
  }

  const deletedRepository = runCheckOnly(env, {
    REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE: "absent",
  });
  if (
    deletedRepository.status === 0 ||
    !deletedRepository.stderr.includes("may have been deleted")
  ) {
    fail(
      "check-only must fail closed when the pinned repository was deleted",
      deletedRepository,
    );
  }

  const rotatingActionFallback = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF: "",
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@cccccccccccccccccccccccccccccccccccccccc",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (rotatingActionFallback.status !== 0) {
    fail(
      "check-only must accept the rotating exact-SHA fallback independently of the general action ref",
      rotatingActionFallback,
    );
  }

  const generalActionOnly = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF: "",
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: "",
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@cccccccccccccccccccccccccccccccccccccccc",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    generalActionOnly.status === 0 ||
    !generalActionOnly.stderr.includes(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
    )
  ) {
    fail(
      "check-only must not fall back to the general action exact-SHA contract",
      generalActionOnly,
    );
  }

  const overbroadAllowlist = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
          "777genius/rr-codex-rotating-e2e-private,777genius/another-disposable-e2e",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    overbroadAllowlist.status === 0 ||
    !overbroadAllowlist.stderr.includes(
      "must contain exactly one disposable live-E2E target",
    )
  ) {
    fail(
      "check-only must reject an empty or multi-repository mutation allowlist",
      overbroadAllowlist,
    );
  }

  const loopbackAlias = spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL: "https://127.0.0.42",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    loopbackAlias.status === 0 ||
    !loopbackAlias.stderr.includes("must not be localhost")
  ) {
    fail(
      "check-only must reject all IPv4 loopback aliases through the shared policy",
      loopbackAlias,
    );
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
if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "repos/777genius/rr-codex-rotating-e2e-private" ]; then
  if [ "\${REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE:-absent}" = "existing" ]; then
    echo "424242"
    exit 0
  fi
  if [ "\${REVIEW_ROUTER_LIVE_E2E_SMOKE_REPOSITORY_MODE:-absent}" = "recreated" ]; then
    echo "434343"
    exit 0
  fi
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == repos/777genius/review-router/contents/* ]]; then
  echo "1"
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
}

function runCheckOnly(env, overrides) {
  return spawnSync(
    process.execPath,
    ["scripts/run-subscription-runtime-live-e2e.mjs", "--check-only"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function fail(message, result) {
  console.error(`ERROR: ${message}`);
  console.error("stdout:");
  console.error(result.stdout);
  console.error("stderr:");
  console.error(result.stderr);
  process.exit(1);
}
