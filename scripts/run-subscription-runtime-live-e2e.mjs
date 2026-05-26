#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "./lib/env-file.mjs";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check-only");
const env = loadRuntimeEnv();
const errors = [];
const warnings = [];

const visibilities = parseVisibilityMatrix(
  read("REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX") ||
    read("REVIEW_ROUTER_CODEX_ROTATING_E2E_VISIBILITY") ||
    "private",
);
const explicitRepoName = Boolean(
  read("REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME"),
);
const owner = read("REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER") || githubLogin();
const reviewMode =
  read("REVIEW_ROUTER_CODEX_ROTATING_E2E_REVIEW_MODE") || "finding";
const targets = visibilities.map((visibility) => ({
  visibility,
  owner,
  repoName: resolveRepoName(visibility),
}));

requireCommand("gh");
requireCommand("git");
requireCommand("bash");
requireCommand("node");
requireCommand("pnpm");
requireGitHubAuth();
requireFeatureFlag();
requireSafeReviewMode(reviewMode);
requireApiUrl();
requirePinnedActionRef();
requireAuthInput();
forbidRawSessionEnv();

if (visibilities.length > 1 && explicitRepoName) {
  errors.push(
    "REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX cannot be combined with REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME. Run one visibility at a time or let the wrapper create visibility-suffixed disposable names.",
  );
}

for (const target of targets) {
  requireSafeGitHubName(target.owner, "owner");
  requireSafeGitHubName(target.repoName, "repository");
  requireDisposableRepository(`${target.owner}/${target.repoName}`);
  requireRepositoryAllowlisted(`${target.owner}/${target.repoName}`);
}

requireActionArtifactsFetchable();

if (
  !checkOnly &&
  read("REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E") !== "1"
) {
  errors.push(
    "Live E2E mutates GitHub repositories. Set REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1 after reviewing the target repository names.",
  );
}

if (errors.length > 0) {
  console.error("Subscription Runtime live E2E readiness failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log("Subscription Runtime live E2E readiness passed.");
console.log(
  `Targets: ${targets
    .map((target) => `${target.owner}/${target.repoName}:${target.visibility}`)
    .join(", ")}`,
);
console.log(`Review mode: ${reviewMode}`);
if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (checkOnly) {
  process.exit(0);
}

for (const target of targets) {
  console.log(
    `Running Codex rotating live E2E for ${target.owner}/${target.repoName} (${target.visibility})...`,
  );
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", "spikes/github-oidc/src/codex-rotating-live-e2e.ts"],
    {
      encoding: "utf8",
      env: {
        ...env,
        REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "1",
        REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER: target.owner,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME: target.repoName,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_VISIBILITY: target.visibility,
        REVIEW_ROUTER_CODEX_ROTATING_E2E_REVIEW_MODE: reviewMode,
      },
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) {
    console.error(
      `Subscription Runtime live E2E failed for ${target.owner}/${target.repoName}.`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log("Subscription Runtime live E2E completed.");

function loadRuntimeEnv() {
  const files =
    process.env.REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_SKIP_ENV_FILES ===
    "1"
      ? [
          process.env.REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_ENV_FILE,
        ].filter(Boolean)
      : [
          ".env",
          ".env.local",
          process.env.REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_ENV_FILE,
        ].filter(Boolean);
  let fileEnv = {};
  for (const file of files) {
    if (existsSync(file)) {
      fileEnv = loadEnvFile(file, fileEnv);
    }
  }
  return { ...fileEnv, ...process.env };
}

function read(name) {
  return String(env[name] ?? "").trim();
}

function parseVisibilityMatrix(value) {
  const entries = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(entries)];
  if (unique.length === 0) return ["private"];
  for (const entry of unique) {
    if (entry !== "public" && entry !== "private") {
      errors.push(
        "REVIEW_ROUTER_SUBSCRIPTION_RUNTIME_LIVE_E2E_MATRIX must contain only public and private.",
      );
    }
  }
  return unique;
}

function resolveRepoName(visibility) {
  const explicit = read("REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME");
  if (explicit) return explicit;
  if (visibilities.length > 1) {
    return `rr-codex-rotating-e2e-${visibility}`;
  }
  return "rr-codex-rotating-e2e";
}

function requireCommand(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    errors.push(`Missing required command: ${command}`);
  }
}

function requireGitHubAuth() {
  const result = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    env,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    errors.push("GitHub CLI is not authenticated. Run gh auth login first.");
  }
}

function githubLogin() {
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    env,
  });
  if (result.error || result.status !== 0) {
    errors.push(
      "Could not resolve GitHub login. Set REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER explicitly.",
    );
    return "unknown-owner";
  }
  return result.stdout.trim();
}

function requireFeatureFlag() {
  if (read("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH") !== "1") {
    errors.push(
      "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=1 is required for the local E2E process and the deployed API used by GitHub-hosted runners.",
    );
  }
}

function requireSafeReviewMode(value) {
  if (value !== "clean" && value !== "finding") {
    errors.push(
      "REVIEW_ROUTER_CODEX_ROTATING_E2E_REVIEW_MODE must be clean or finding.",
    );
  }
}

function requireApiUrl() {
  const value =
    read("REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL") ||
    read("REVIEW_ROUTER_PUBLIC_API_URL") ||
    read("REVIEW_ROUTER_API_URL");
  if (!value) {
    errors.push(
      "Set REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL or REVIEW_ROUTER_PUBLIC_API_URL to the public HTTPS API URL reachable from GitHub-hosted runners.",
    );
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`Invalid live E2E API URL: ${value}`);
    return;
  }
  if (parsed.protocol !== "https:") {
    errors.push("Live E2E API URL must use https://.");
  }
  if (isLocalhost(parsed.hostname)) {
    errors.push(
      "Live E2E API URL must not be localhost because GitHub-hosted runners must reach it.",
    );
  }
}

function requirePinnedActionRef() {
  const ref =
    read("REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF") ||
    read("REVIEW_ROUTER_ACTION_REF");
  if (!ref) {
    errors.push(
      "Set REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF or REVIEW_ROUTER_ACTION_REF to owner/repo@40-char-sha.",
    );
    return;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(ref)) {
    errors.push(
      `Live E2E action ref must be pinned to a full 40-character SHA: ${ref}`,
    );
  }
}

function requireActionArtifactsFetchable() {
  const ref =
    read("REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF") ||
    read("REVIEW_ROUTER_ACTION_REF");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(ref)) {
    return;
  }
  const [repository, sha] = ref.split("@");
  const requiredPaths = [
    "action.yml",
    "action-dist/index.cjs",
    "action-dist/codex/linux-x64/codex-linux-x64.tgz",
    "action-dist/codex/linux-x64/manifest.json",
  ];
  for (const path of requiredPaths) {
    const result = spawnSync(
      "gh",
      [
        "api",
        `repos/${repository}/contents/${path}?ref=${sha}`,
        "--jq",
        ".size",
      ],
      { encoding: "utf8", env, stdio: "ignore" },
    );
    if (result.error || result.status !== 0) {
      errors.push(
        `Action artifact is not fetchable at ${repository}@${sha}:${path}. Push the action bundle and use that full SHA before live E2E.`,
      );
    }
  }
}

function requireAuthInput() {
  const authFile =
    read("REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE") ||
    read("REVIEW_ROUTER_CODEX_AUTH_FILE");
  if (authFile) return;
  if (read("REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN") === "1") {
    warnings.push(
      "Interactive Codex login is enabled. Prefer REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE for repeatable live E2E.",
    );
    return;
  }
  errors.push(
    "Set REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE to a dedicated Codex auth file, or set REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN=1 for an interactive local login.",
  );
}

function forbidRawSessionEnv() {
  const forbidden = [
    "REVIEWROUTER_CODEX_AUTH_JSON",
    "CODEX_AUTH_JSON",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  for (const name of forbidden) {
    if (read(name)) {
      errors.push(
        `${name} must not be present in the live E2E process environment. Use a file path or GitHub Actions secret flow instead.`,
      );
    }
  }
}

function requireSafeGitHubName(value, label) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    errors.push(`Invalid GitHub ${label}: ${value}`);
  }
}

function requireDisposableRepository(repository) {
  if (read("REVIEW_ROUTER_LIVE_E2E_ALLOW_NON_DISPOSABLE") === "1") {
    warnings.push(
      `Non-disposable repository guard bypassed for ${repository}. This should only be used for a planned canary.`,
    );
    return;
  }
  const name = repository.split("/").at(-1)?.toLowerCase() ?? "";
  if (!/(^rr-|reviewrouter|e2e|smoke|test|disposable)/.test(name)) {
    errors.push(
      `Refusing to run live E2E against ${repository}. Use a disposable repo name containing rr-, reviewrouter, e2e, smoke, test, or set REVIEW_ROUTER_LIVE_E2E_ALLOW_NON_DISPOSABLE=1 for an intentional canary.`,
    );
  }
}

function requireRepositoryAllowlisted(repository) {
  const allowlist = read("REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES")
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(repository.toLowerCase())) {
    errors.push(
      `Repository ${repository} is not in REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES.`,
    );
  }
}

function isLocalhost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}
