#!/usr/bin/env node
import { existsSync, readFileSync, writeSync } from "node:fs";
import { loadEnvFile } from "./lib/env-file.mjs";
import { isLoopbackHostname } from "../packages/shared/src/validation/loopback-hostname.mjs";
import { resolveCodexRotatingInstallerDescriptor } from "../packages/shared/src/validation/codex-rotating-installer-descriptor.mjs";

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
requireCodexEffectAuthorityDatabaseUrl();
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
requireDatabaseRecoveryWitness();
requireEqual("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
requireEqual("REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING", "1");
requireEqual("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "0");
requireEqual("REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED", "0");
requireEqual("REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED", "0");
forbidEqual("REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE", "1");
forbidSet("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH_BETA");
forbidSet("REVIEW_ROUTER_CODEX_ROTATING_OAUTH_BETA_REPOSITORIES");
requireGitHubAppPrivateKey();
forbidProviderSecretsInSaaS();
requireHostedActionRef();
requireHostedCodexRotatingActionRef();
requireCodexRotatingInstallerDescriptor();

if (errors.length > 0) {
  const output = [
    "ReviewRouter hosted readiness failed:",
    ...errors.map((error) => `- ${error}`),
  ];
  if (warnings.length > 0) {
    output.push("Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }
  writeSync(2, `${output.join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("ReviewRouter hosted readiness checks passed.");
  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
}

function requireEqual(name, expected) {
  const actual = read(name);
  if (actual !== expected) {
    errors.push(`${name} must be ${expected}.`);
  }
}

function requireCodexEffectAuthorityDatabaseUrl() {
  const runtimeValue = read("DATABASE_URL");
  const authorityValue = read(
    "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  );
  if (!authorityValue) {
    errors.push(
      "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL is required.",
    );
    return;
  }
  try {
    const runtime = new URL(runtimeValue);
    const authority = new URL(authorityValue);
    const identity = (url) =>
      `${url.hostname.toLowerCase().replace(/\.$/u, "")}:${url.port || "5432"}${url.pathname}`;
    if (
      !["postgres:", "postgresql:"].includes(authority.protocol) ||
      decodeURIComponent(authority.username) !==
        "reviewrouter_codex_effect_authority" ||
      !authority.password ||
      isLoopbackHostname(authority.hostname) ||
      identity(authority) !== identity(runtime)
    ) {
      throw new Error("invalid");
    }
  } catch {
    errors.push(
      "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL must authenticate as reviewrouter_codex_effect_authority on the DATABASE_URL database generation.",
    );
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
  if (!policy.allowLocalhost && isLoopbackHostname(parsed.hostname)) {
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
  if (isLoopbackHostname(parsed.hostname)) {
    errors.push(`${name} must not point to localhost in hosted production.`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
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

function requireHostedActionRef() {
  const explicitRef = resolveHostedActionRef();
  if (!explicitRef) {
    errors.push(
      "REVIEW_ROUTER_ACTION_REF or REVIEW_ROUTER_ACTION_VERSION is required in hosted production.",
    );
    return;
  }
  if (!isHostedActionRef(explicitRef)) {
    errors.push(
      "REVIEW_ROUTER_ACTION_REF must be 777genius/review-router@main, 777genius/review-router@v1, a v1.x.y release tag, or a full 40-character commit SHA in hosted production.",
    );
  }
  const expectedOwnerRepo = explicitRef.split("@", 1)[0]?.toLowerCase();
  const allowedRefs = read("REVIEW_ROUTER_ALLOWED_ACTION_REFS");
  if (!allowedRefs) {
    return;
  }
  for (const actionRef of allowedRefs.split(/[\s,]+/).filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(actionRef)) {
      errors.push(
        "REVIEW_ROUTER_ALLOWED_ACTION_REFS must contain only full 40-character commit SHA action refs.",
      );
      continue;
    }
    if (actionRef.split("@", 1)[0]?.toLowerCase() !== expectedOwnerRepo) {
      errors.push(
        "REVIEW_ROUTER_ALLOWED_ACTION_REFS must use the same action repository as REVIEW_ROUTER_ACTION_REF.",
      );
    }
  }
}

function requireHostedCodexRotatingActionRef() {
  const primary = read("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(primary)) {
    errors.push(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF must be an exact full-SHA Action ref.",
    );
    return;
  }
  const primaryRepository = primary.split("@", 1)[0]?.toLowerCase();
  for (const ref of read("REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS")
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(ref) ||
      ref.split("@", 1)[0]?.toLowerCase() !== primaryRepository
    ) {
      errors.push(
        "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS must contain only same-repository full-SHA Action refs.",
      );
    }
  }
}

function requireCodexRotatingInstallerDescriptor() {
  try {
    resolveCodexRotatingInstallerDescriptor(env);
  } catch (error) {
    errors.push(
      `Codex rotating installer descriptor is invalid: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function requireDatabaseRecoveryWitness() {
  const value = read("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
  if (
    !/^[A-Za-z0-9_-]{43,256}$/.test(value) ||
    /replace-with|placeholder/i.test(value)
  ) {
    errors.push(
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be 43-256 base64url characters.",
    );
  }
}

function resolveHostedActionRef() {
  const actionRef = read("REVIEW_ROUTER_ACTION_REF");
  if (actionRef) {
    return actionRef;
  }
  const version = read("REVIEW_ROUTER_ACTION_VERSION");
  return version ? `777genius/review-router@${version}` : "";
}

function isHostedActionRef(actionRef) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@(main|v1|v1\.[0-9]+\.[0-9]+|[a-f0-9]{40})$/i.test(
    actionRef,
  );
}

function read(name) {
  return String(env[name] ?? "").trim();
}
