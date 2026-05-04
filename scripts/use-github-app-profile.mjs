#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "./lib/env-file.mjs";

const args = parseArgs(process.argv.slice(2));
const envFile = String(args["env-file"] ?? ".env.local");
const profilePath = resolveProfilePath(args.profile);
const profile = loadEnvFile(profilePath, {});
const target = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";

const required = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY_FILE",
  "GITHUB_WEBHOOK_SECRET",
];

const missing = required.filter((key) => !String(profile[key] ?? "").trim());
if (missing.length > 0) {
  fail(
    `GitHub App profile is missing required keys: ${missing.join(", ")}. Profile: ${profilePath}`,
  );
}

const privateKeyFile = String(profile.GITHUB_APP_PRIVATE_KEY_FILE);
if (!existsSync(privateKeyFile)) {
  fail(`GITHUB_APP_PRIVATE_KEY_FILE does not exist: ${privateKeyFile}`);
}

const privateKey = readFileSync(privateKeyFile, "utf8");
if (!/BEGIN .*PRIVATE KEY/.test(privateKey)) {
  fail(
    `GITHUB_APP_PRIVATE_KEY_FILE does not look like a PEM key: ${privateKeyFile}`,
  );
}

const updates = {
  GITHUB_CLIENT_ID: profile.GITHUB_CLIENT_ID ?? profile.GITHUB_APP_CLIENT_ID,
  GITHUB_CLIENT_SECRET:
    profile.GITHUB_CLIENT_SECRET ?? profile.GITHUB_APP_CLIENT_SECRET,
  GITHUB_APP_ID: profile.GITHUB_APP_ID,
  GITHUB_APP_CLIENT_ID: profile.GITHUB_APP_CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: profile.GITHUB_APP_CLIENT_SECRET,
  GITHUB_APP_SLUG: profile.GITHUB_APP_SLUG,
  GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
  GITHUB_WEBHOOK_SECRET: profile.GITHUB_WEBHOOK_SECRET,
  REVIEW_ROUTER_APP_PROFILE: profilePath,
};

const includeUrls = Boolean(args["include-urls"]);
if (includeUrls) {
  for (const key of ["REVIEW_ROUTER_WEB_URL", "REVIEW_ROUTER_API_URL"]) {
    if (profile[key]) updates[key] = profile[key];
  }
}

writeFileSync(envFile, mergeEnv(target, updates));

console.log(`Applied GitHub App profile to ${envFile}.`);
console.log(`Profile: ${profilePath}`);
console.log(`App slug: ${profile.GITHUB_APP_SLUG}`);
console.log(
  `Updated keys: ${Object.keys(updates)
    .filter((key) => !key.includes("SECRET"))
    .join(", ")} plus secret values.`,
);
console.log("Secret values were not printed.");

function resolveProfilePath(value) {
  const explicit = value ?? process.env.REVIEW_ROUTER_APP_PROFILE;
  if (!explicit) {
    fail(
      "Missing --profile or REVIEW_ROUTER_APP_PROFILE. Example: pnpm github-app:use-profile -- --profile .local-secrets/github-apps/review-router-ai.env",
    );
  }
  const resolved = resolve(String(explicit));
  if (!existsSync(resolved)) {
    fail(`GitHub App profile does not exist: ${resolved}`);
  }
  return resolved;
}

function mergeEnv(existing, updatesToApply) {
  const lines = existing.split(/\r?\n/);
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in updatesToApply)) return line;
    seen.add(key);
    return `${key}=${quoteEnvValue(updatesToApply[key])}`;
  });

  const additions = Object.entries(updatesToApply)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);

  const body = [...updated, ...additions]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/g, "");
  return `${body}\n`;
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "include-urls") {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
