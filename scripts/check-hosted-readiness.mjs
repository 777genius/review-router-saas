#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "./lib/env-file.mjs";

const envFile = process.env.REVIEW_ROUTER_HOSTED_ENV_FILE || ".env.production";
const envFileExists = existsSync(envFile);
const env = envFileExists ? loadEnvFile(envFile, process.env) : process.env;
const errors = [];
const warnings = [];

if (!envFileExists) {
  warnings.push(
    `Hosted env file ${envFile} was not found; checking process.env only. Set REVIEW_ROUTER_HOSTED_ENV_FILE or create ${envFile} from deploy/env.production.example.`,
  );
}

requireEqual("NODE_ENV", "production");
requirePostgresUrl("DATABASE_URL", { allowLocalhost: false });
requireHttpsUrl("REVIEW_ROUTER_WEB_URL");
requireHttpsUrl("REVIEW_ROUTER_API_URL");
requireHttpsUrl("REVIEW_ROUTER_PUBLIC_API_URL");
requireSecret("AUTH_SECRET", 32);
requireSecret("GITHUB_CLIENT_ID", 1);
requireSecret("GITHUB_CLIENT_SECRET", 16);
requireNumeric("GITHUB_APP_ID");
requireSecret("GITHUB_APP_CLIENT_ID", 1);
requireSecret("GITHUB_APP_CLIENT_SECRET", 16);
requireSecret("GITHUB_APP_SLUG", 1);
requireSecret("REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY", 32);
requireSecret("GITHUB_WEBHOOK_SECRET", 16);
requireSecret("REVIEW_ROUTER_ACTION_SESSION_SECRET", 32);
requireEqual("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
requireEqual("REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING", "1");
requireEqual("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE", "1");
forbidSet("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH_BETA");
forbidSet("REVIEW_ROUTER_CODEX_ROTATING_OAUTH_BETA_REPOSITORIES");
requireGitHubAppPrivateKey();
forbidProviderSecretsInSaaS();
requireFullShaActionRef();

if (errors.length > 0) {
  console.error("ReviewRouter hosted readiness failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log("ReviewRouter hosted readiness checks passed.");
if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

function requireEqual(name, expected) {
  const actual = read(name);
  if (actual !== expected) {
    errors.push(`${name} must be ${expected}.`);
  }
}

function forbidEqual(name, forbidden) {
  const actual = read(name);
  if (actual === forbidden) {
    errors.push(`${name} must not be ${forbidden}.`);
  }
}

function forbidSet(name) {
  if (read(name)) {
    errors.push(
      `${name} is obsolete. Use REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH and optional REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES.`,
    );
  }
}

function requireSecret(name, minLength) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  if (value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters.`);
  }
  if (/replace-with|example\.com|^ci-|placeholder/i.test(value)) {
    errors.push(`${name} still looks like a placeholder.`);
  }
}

function requireNumeric(name) {
  const value = read(name);
  if (!/^\d+$/.test(value)) {
    errors.push(`${name} must be numeric.`);
  }
}

function requirePostgresUrl(name, policy) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name} must be a valid PostgreSQL URL.`);
    return;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    errors.push(`${name} must use postgresql:// or postgres://.`);
  }
  if (!policy.allowLocalhost && isLocalhost(parsed.hostname)) {
    errors.push(`${name} must not point to localhost in hosted production.`);
  }
}

function requireHttpsUrl(name) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name} must be a valid URL.`);
    return;
  }
  if (parsed.protocol !== "https:") {
    errors.push(`${name} must use https:// in hosted production.`);
  }
  if (isLocalhost(parsed.hostname)) {
    errors.push(`${name} must not point to localhost in hosted production.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    errors.push(`${name} must not include credentials, query, or hash.`);
  }
}

function requireGitHubAppPrivateKey() {
  const inlineKey = read("GITHUB_APP_PRIVATE_KEY");
  const keyFile = read("GITHUB_APP_PRIVATE_KEY_FILE");
  if (inlineKey) {
    const normalized = inlineKey.includes("\\n")
      ? inlineKey.replaceAll("\\n", "\n")
      : inlineKey;
    if (!/BEGIN .*PRIVATE KEY/.test(normalized)) {
      errors.push(
        "GITHUB_APP_PRIVATE_KEY does not look like a PEM private key.",
      );
    }
    if (/placeholder|ci-placeholder/i.test(normalized)) {
      errors.push("GITHUB_APP_PRIVATE_KEY still looks like a placeholder.");
    }
    return;
  }
  if (keyFile) {
    if (!existsSync(keyFile)) {
      errors.push(`GITHUB_APP_PRIVATE_KEY_FILE does not exist: ${keyFile}`);
      return;
    }
    const content = readFileSync(keyFile, "utf8");
    if (!/BEGIN .*PRIVATE KEY/.test(content)) {
      errors.push(
        "GITHUB_APP_PRIVATE_KEY_FILE does not look like a PEM private key.",
      );
    }
    return;
  }
  errors.push(
    "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required.",
  );
}

function forbidProviderSecretsInSaaS() {
  const forbidden = [
    "CODEX_AUTH_JSON",
    "CODEX_CONFIG_TOML",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GEMINI_API_KEY",
  ];
  for (const name of forbidden) {
    if (read(name)) {
      errors.push(
        `${name} must not be stored in ReviewRouter SaaS env; put provider credentials in customer GitHub Actions secrets.`,
      );
    }
  }
}

function requireFullShaActionRef() {
  const explicitRef = read("REVIEW_ROUTER_ACTION_REF");
  if (!explicitRef) {
    errors.push("REVIEW_ROUTER_ACTION_REF is required in hosted production.");
    return;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(explicitRef)) {
    errors.push(
      "REVIEW_ROUTER_ACTION_REF must be pinned to a full 40-character commit SHA in hosted production.",
    );
  }
}

function read(name) {
  return String(env[name] ?? "").trim();
}

function isLocalhost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}
