#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env-file.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEnvFile = "deploy/self-hosted/.env";
const envFile =
  process.env.REVIEW_ROUTER_SELF_HOSTED_ENV_FILE || defaultEnvFile;
const envFilePath = isAbsolute(envFile) ? envFile : resolve(repoRoot, envFile);
const envFileExists = existsSync(envFilePath);
const env = envFileExists ? loadEnvFile(envFilePath, process.env) : process.env;
const errors = [];
const warnings = [];

if (!envFileExists) {
  warnings.push(
    `Self-hosted env file ${envFile} was not found; checking process.env only. Copy deploy/self-hosted/.env.example to deploy/self-hosted/.env first.`,
  );
}

requireFile("deploy/self-hosted/Dockerfile");
requireFile("deploy/self-hosted/compose.yml");
requireEqual("NODE_ENV", "production");
requirePostgresUrl("DATABASE_URL");
requireHttpsUrl("REVIEW_ROUTER_WEB_URL");
requireHttpsUrl("REVIEW_ROUTER_API_URL");
requireHttpsUrl("REVIEW_ROUTER_PUBLIC_API_URL");
requireOptionalHttpsUrl("REVIEW_ROUTER_PUBLIC_WEB_URL");
requireOptionalHttpsUrl("NEXTAUTH_URL");
requireSecret("AUTH_SECRET", 32);
requireNumeric("GITHUB_APP_ID");
requireSecret("GITHUB_APP_CLIENT_ID", 1);
requireSecret("GITHUB_APP_CLIENT_SECRET", 16);
requireSecret("GITHUB_APP_SLUG", 1);
requireSecret("GITHUB_WEBHOOK_SECRET", 16);
requireSecret("REVIEW_ROUTER_ACTION_SESSION_SECRET", 32);
requireSecret("REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY", 32);
requireEqual("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
requireEqual("REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING", "1");
requireEqual("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE", "1");
forbidProviderSecretsInControlPlane();
requireGitHubAppPrivateKey();
requireActionRef();
warnMissingGitHubClientAliases();

if (errors.length > 0) {
  console.error("ReviewRouter self-hosted readiness failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log("ReviewRouter self-hosted readiness checks passed.");
if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

function requireFile(path) {
  if (!existsSync(resolve(repoRoot, path))) {
    errors.push(`${path} is missing.`);
  }
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

function requireSecret(name, minLength) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  if (value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters.`);
  }
  if (/replace-with|example\.com|placeholder|paste_/i.test(value)) {
    errors.push(`${name} still looks like a placeholder.`);
  }
}

function requireNumeric(name) {
  const value = read(name);
  if (!/^\d+$/.test(value)) {
    errors.push(`${name} must be numeric.`);
  }
}

function requirePostgresUrl(name) {
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
  if (!parsed.hostname) {
    errors.push(`${name} must include a database host.`);
  }
  if (/replace-with|placeholder|example/i.test(value)) {
    errors.push(`${name} still looks like a placeholder.`);
  }
}

function requireHttpsUrl(name) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  validateHttpsUrl(name, value);
}

function requireOptionalHttpsUrl(name) {
  const value = read(name);
  if (value) validateHttpsUrl(name, value);
}

function validateHttpsUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name} must be a valid URL.`);
    return;
  }
  if (parsed.protocol !== "https:") {
    errors.push(
      `${name} must use https:// for github.com callbacks and workflows.`,
    );
  }
  if (isLocalhost(parsed.hostname)) {
    errors.push(
      `${name} must not point to localhost in self-hosted production.`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    errors.push(`${name} must not include credentials, query, or hash.`);
  }
  if (/example\.com|placeholder/i.test(value)) {
    errors.push(`${name} still looks like a placeholder.`);
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
      return;
    }
    if (/replace-with|placeholder/i.test(normalized)) {
      errors.push("GITHUB_APP_PRIVATE_KEY still looks like a placeholder.");
      return;
    }
    validatePrivateKeyPem("GITHUB_APP_PRIVATE_KEY", normalized);
    return;
  }

  if (!keyFile) {
    errors.push(
      "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required.",
    );
    return;
  }

  if (keyFile.startsWith("/run/secrets/")) {
    warnings.push(
      `GITHUB_APP_PRIVATE_KEY_FILE points to ${keyFile}; make sure every app container mounts that secret path read-only.`,
    );
    return;
  }

  const resolvedKeyFile = isAbsolute(keyFile)
    ? keyFile
    : resolve(dirname(envFilePath), keyFile);
  if (!existsSync(resolvedKeyFile)) {
    errors.push(
      `GITHUB_APP_PRIVATE_KEY_FILE does not exist: ${resolvedKeyFile}`,
    );
    return;
  }
  const content = readFileSync(resolvedKeyFile, "utf8");
  if (!/BEGIN .*PRIVATE KEY/.test(content)) {
    errors.push(
      "GITHUB_APP_PRIVATE_KEY_FILE does not look like a PEM private key.",
    );
    return;
  }
  validatePrivateKeyPem("GITHUB_APP_PRIVATE_KEY_FILE", content);
}

function validatePrivateKeyPem(name, pem) {
  try {
    createPrivateKey(pem);
  } catch {
    errors.push(`${name} is not a parseable private key PEM.`);
  }
}

function requireActionRef() {
  const actionRef = read("REVIEW_ROUTER_ACTION_REF");
  const actionVersion = read("REVIEW_ROUTER_ACTION_VERSION");
  const resolved =
    actionRef ||
    (actionVersion ? `777genius/review-router@${actionVersion}` : "");
  if (!resolved) {
    errors.push(
      "REVIEW_ROUTER_ACTION_REF or REVIEW_ROUTER_ACTION_VERSION is required.",
    );
    return;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[^@\s]+$/.test(resolved)) {
    errors.push("REVIEW_ROUTER_ACTION_REF must look like owner/repo@ref.");
    return;
  }
  if (!/@(v[0-9]+(?:\.[0-9]+){0,2}|[a-f0-9]{40})$/i.test(resolved)) {
    warnings.push(
      "REVIEW_ROUTER_ACTION_REF is not pinned to a release tag or full commit SHA. This is acceptable for beta, but less deterministic for self-hosted production.",
    );
  }

  const expectedOwnerRepo = resolved.split("@", 1)[0]?.toLowerCase();
  const allowedRefs = read("REVIEW_ROUTER_ALLOWED_ACTION_REFS");
  if (!allowedRefs) return;
  for (const allowedRef of allowedRefs.split(/[\s,]+/).filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(allowedRef)) {
      errors.push(
        "REVIEW_ROUTER_ALLOWED_ACTION_REFS must contain only full 40-character commit SHA action refs.",
      );
      continue;
    }
    if (allowedRef.split("@", 1)[0]?.toLowerCase() !== expectedOwnerRepo) {
      errors.push(
        "REVIEW_ROUTER_ALLOWED_ACTION_REFS must use the same action repository as REVIEW_ROUTER_ACTION_REF.",
      );
    }
  }
}

function warnMissingGitHubClientAliases() {
  const appClientId = read("GITHUB_APP_CLIENT_ID");
  const appClientSecret = read("GITHUB_APP_CLIENT_SECRET");
  const clientId = read("GITHUB_CLIENT_ID");
  const clientSecret = read("GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    warnings.push(
      "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to the same values as the GitHub App client ID and secret for operator script compatibility.",
    );
    return;
  }
  if (clientId !== appClientId || clientSecret !== appClientSecret) {
    warnings.push(
      "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET differ from GITHUB_APP_CLIENT_ID/GITHUB_APP_CLIENT_SECRET.",
    );
  }
}

function forbidProviderSecretsInControlPlane() {
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
        `${name} must not be stored in ReviewRouter control-plane env; put provider credentials in customer GitHub Actions secrets.`,
      );
    }
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
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}
