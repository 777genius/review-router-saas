#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["scripts/create-github-app-manifest.mjs", "--dry-run", "--no-open"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.status !== 0) {
  console.error("GitHub App manifest helper dry run failed.");
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

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

if ("default_events" in manifest) {
  throw new Error(
    "manifest must not include default_events; installation lifecycle events are delivered by GitHub Apps by default",
  );
}

assertPermission("actions", "read");
assertPermission("contents", "write");
assertPermission("issues", "write");
assertPermission("pull_requests", "write");
assertPermission("workflows", "write");

console.log("GitHub App manifest smoke passed.");

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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
    );
  }
}
