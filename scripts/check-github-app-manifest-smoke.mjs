#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = runManifestHelper(["--dry-run", "--no-open"]);

const manifest = parseManifest(result.stdout);

assertEqual(manifest.setup_url, "https://reviewrouter.site/setup", "setup_url");
assertEqual(
  manifest.hook_attributes?.url,
  "https://api.reviewrouter.site/webhooks/github",
  "hook_attributes.url",
);
assertEqual(
  manifest.callback_urls?.[0],
  "https://reviewrouter.site/api/auth/callback/github",
  "callback_urls[0]",
);
assertEqual(
  manifest.request_oauth_on_install,
  false,
  "request_oauth_on_install",
);
assertEqual(manifest.setup_on_update, true, "setup_on_update");
assertEqual(manifest.public, true, "public");

assertEqual(
  JSON.stringify(manifest.default_events ?? []),
  JSON.stringify([
    "check_run",
    "issue_comment",
    "pull_request",
    "push",
    "repository",
    "status",
    "workflow_job",
    "workflow_run",
  ]),
  "default_events",
);

assertPermission("actions", "write");
assertPermission("checks", "write");
assertPermission("contents", "write");
assertPermission("issues", "write");
assertPermission("pull_requests", "write");
assertPermission("secrets", "write");
assertPermission("organization_secrets", "read");
assertPermission("organization_plan", "read");
assertPermission("statuses", "write");
assertPermission("workflows", "write");
assertPermissionMissing("organization_administration");

const orgRulesetResult = runManifestHelper([
  "--dry-run",
  "--no-open",
  "--permission-profile",
  "org-ruleset",
]);
const orgRulesetManifest = parseManifest(orgRulesetResult.stdout);
assertEqual(
  orgRulesetManifest.default_permissions?.organization_administration,
  "write",
  "org-ruleset default_permissions.organization_administration",
);

console.log("GitHub App manifest smoke passed.");

function runManifestHelper(args) {
  const run = spawnSync(
    process.execPath,
    ["scripts/create-github-app-manifest.mjs", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (run.status !== 0) {
    console.error("GitHub App manifest helper dry run failed.");
    console.error(run.stdout);
    console.error(run.stderr);
    process.exit(run.status ?? 1);
  }

  return run;
}

function parseManifest(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`manifest JSON not found in output: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start));
}

function assertPermission(permission, expected) {
  assertEqual(
    manifest.default_permissions?.[permission],
    expected,
    `default_permissions.${permission}`,
  );
}

function assertPermissionMissing(permission) {
  if (permission in (manifest.default_permissions ?? {})) {
    throw new Error(`default_permissions.${permission} must not be present`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
    );
  }
}
