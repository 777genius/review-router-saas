#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env-file.mjs";
import { normalizeGitHubAppPermissionProfile } from "./lib/github-app-permission-profiles.mjs";
import { reviewV2ProjectionPolicyVersion } from "./review-v2-render-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultEnvFile = "deploy/self-hosted/.env";
const envFile =
  process.env.REVIEW_ROUTER_SELF_HOSTED_ENV_FILE || defaultEnvFile;
const envFilePath = isAbsolute(envFile) ? envFile : resolve(repoRoot, envFile);
const envFileExists = existsSync(envFilePath);
const env = envFileExists ? loadEnvFile(envFilePath, process.env) : process.env;
const errors = [];
const warnings = [];
const githubAppPermissionProfile = readGitHubAppPermissionProfile();

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
requireWorkflowProvisioningMode();
requireEqual("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
forbidEqual("REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE", "1");
forbidProviderSecretsInControlPlane();
requireGitHubAppPrivateKey();
requireActionRef();
requireT0RuntimeContract();
requireInvestigationRetentionMaintenance();
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

function readGitHubAppPermissionProfile() {
  try {
    return normalizeGitHubAppPermissionProfile(
      read("REVIEW_ROUTER_GITHUB_APP_PERMISSION_PROFILE") || "standard",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return "standard";
  }
}

function requireWorkflowProvisioningMode() {
  const workflowProvisioningEnabled =
    read("REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING") === "1";
  const workflowProvisioningDisabled =
    read("REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING") === "1";
  const provisioningProfile =
    githubAppPermissionProfile === "provisioning" ||
    githubAppPermissionProfile === "org-ruleset";

  if (provisioningProfile) {
    if (!workflowProvisioningEnabled) {
      errors.push(
        "REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING must be 1 for provisioning GitHub App permission profiles.",
      );
    }
    if (workflowProvisioningDisabled) {
      errors.push(
        "REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING must not be 1 for provisioning GitHub App permission profiles.",
      );
    }
    return;
  }

  if (workflowProvisioningEnabled && !workflowProvisioningDisabled) {
    errors.push(
      `REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING must not be active with the ${githubAppPermissionProfile} GitHub App permission profile. Disable workflow provisioning or use the provisioning profile.`,
    );
  }
}

function requireT0RuntimeContract() {
  for (const name of [
    "REVIEW_ROUTER_REVIEW_V2_DIRECT_INITIALIZATION_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_RUN_CONTROL_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED",
    "REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED",
  ]) {
    requireEqual(name, "1");
  }
  requireEqual(
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_PROVISIONING_MODE",
    "client_triggered_t0",
  );
  for (const name of [
    "REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED",
    "REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED",
    "REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY",
  ]) {
    requireEqual(name, "0");
  }

  const actionCommitSha = requireT0ActionCommitRef();
  requireRotatingKeyRing(
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
  );
  requireRotatingKeyRing(
    "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON",
  );
  const attestations = requireProducerReleaseAttestations(
    "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
  );
  requireProviderVoteLanes("REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON");
  requireEqual(
    "REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION",
    reviewV2ProjectionPolicyVersion,
  );
  requireBase64Key("REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64", 32);
  requireContextReplayKeyRing();
  requireSha256("REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256");

  if (
    actionCommitSha &&
    attestations &&
    !attestations.some(
      (attestation) =>
        isRecord(attestation) &&
        typeof attestation.actionCommitSha === "string" &&
        attestation.actionCommitSha.toLowerCase() === actionCommitSha,
    )
  ) {
    errors.push(
      "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON must contain REVIEW_ROUTER_ACTION_REF's commit SHA.",
    );
  }
}

function requireInvestigationRetentionMaintenance() {
  if (
    read("REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED") === "1" &&
    read("REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED") !== "1"
  ) {
    errors.push(
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED must be 1 when investigation recording is enabled.",
    );
  }
}

function requireT0ActionCommitRef() {
  const actionRef = read("REVIEW_ROUTER_ACTION_REF");
  const actionVersion = read("REVIEW_ROUTER_ACTION_VERSION");
  const resolved =
    actionRef ||
    (actionVersion ? `777genius/review-router@${actionVersion}` : "");
  const match = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@([a-f0-9]{40})$/i.exec(
    resolved,
  );
  if (!match) {
    errors.push(
      "Self-hosted T0 requires REVIEW_ROUTER_ACTION_REF pinned to a full 40-character commit SHA.",
    );
    return null;
  }
  return match[1].toLowerCase();
}

function requireRotatingKeyRing(activeKeyName, keysName) {
  const activeKeyId = read(activeKeyName);
  if (!activeKeyId) errors.push(`${activeKeyName} is required.`);
  const keys = requireNonEmptyJsonArray(keysName);
  if (!keys) return;

  const valid =
    keys.length <= 10 &&
    keys.every(
      (key) =>
        isExactRecord(key, ["keyId", "secretBase64", "verifyUntil"]) &&
        typeof key.keyId === "string" &&
        key.keyId.length > 0 &&
        isCanonicalBase64Key(key.secretBase64, 32, false) &&
        (key.verifyUntil === null || isIsoTimestamp(key.verifyUntil)),
    );
  if (!valid) {
    errors.push(
      `${keysName} must contain 1-10 valid keyId/secretBase64/verifyUntil records.`,
    );
    return;
  }
  if (activeKeyId && !keys.some((key) => key.keyId === activeKeyId)) {
    errors.push(`${activeKeyName} must identify a key in ${keysName}.`);
  }
}

function requireContextReplayKeyRing() {
  const activeKeyName = "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID";
  const keysName = "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON";
  const activeKeyId = read(activeKeyName);
  if (!activeKeyId) errors.push(`${activeKeyName} is required.`);
  const keys = requireNonEmptyJsonArray(keysName);
  if (!keys) return;

  const valid =
    keys.length <= 16 &&
    keys.every(
      (key) =>
        isExactRecord(key, ["keyId", "secretBase64"]) &&
        typeof key.keyId === "string" &&
        key.keyId.length > 0 &&
        isCanonicalBase64Key(key.secretBase64, 32, true),
    );
  if (!valid) {
    errors.push(
      `${keysName} must contain 1-16 valid keyId/secretBase64 records.`,
    );
    return;
  }
  if (activeKeyId && !keys.some((key) => key.keyId === activeKeyId)) {
    errors.push(`${activeKeyName} must identify a key in ${keysName}.`);
  }
}

function requireNonEmptyJsonArray(name) {
  const value = read(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Normalized below without exposing the configured value.
  }
  errors.push(`${name} must be a non-empty JSON array.`);
  return null;
}

function requireProducerReleaseAttestations(name) {
  const attestations = requireNonEmptyJsonArray(name);
  if (!attestations) return null;
  const actionCommitShas = new Set();
  const valid =
    attestations.length <= 100 &&
    attestations.every((attestation) => {
      if (!isProducerReleaseAttestation(attestation)) return false;
      const actionCommitSha = attestation.actionCommitSha.toLowerCase();
      if (actionCommitShas.has(actionCommitSha)) return false;
      actionCommitShas.add(actionCommitSha);
      return true;
    });
  if (!valid) {
    errors.push(
      `${name} must contain 1-100 valid, uniquely keyed producer release attestations.`,
    );
    return null;
  }
  return attestations;
}

function requireProviderVoteLanes(name) {
  const lanes = requireNonEmptyJsonArray(name);
  if (!lanes) return;
  const providers = new Set();
  const valid =
    lanes.length <= 16 &&
    lanes.every((lane) => {
      if (
        !isExactRecord(lane, ["providerKind", "providerVoteIdentityHash"]) ||
        !["codex", "claude_code", "openrouter"].includes(lane.providerKind) ||
        !isSha256(lane.providerVoteIdentityHash) ||
        providers.has(lane.providerKind)
      ) {
        return false;
      }
      providers.add(lane.providerKind);
      return true;
    });
  if (!valid) {
    errors.push(
      `${name} must contain 1-16 valid, uniquely keyed provider vote lanes.`,
    );
  }
}

function isProducerReleaseAttestation(value) {
  const legacyKeys = [
    "producerReleaseId",
    "distributionKind",
    "actionCommitSha",
    "runtimeCommitSha",
    "wrapperEntrypointDigest",
    "runtimeEntrypointDigest",
    "schemaDigest",
    "canonicalizerDigest",
    "capabilityProfile",
    "protocolLimitsProfileId",
    "operationalSloProfileId",
  ];
  const currentKeys = [
    ...legacyKeys,
    "contextGatewayPolicyVersion",
    "contextGatewayEntrypointDigest",
  ];
  const investigationKeys = [
    ...currentKeys,
    "reviewInvestigationCapability",
    "reviewInvestigationCoverageProfileHash",
    "reviewInvestigationPolicyHash",
  ];
  const legacy = isExactRecord(value, legacyKeys);
  const current = isExactRecord(value, currentKeys);
  const investigation = isExactRecord(value, investigationKeys);
  if (!legacy && !current && !investigation) {
    return false;
  }
  const contextGatewayPolicyVersion = value.contextGatewayPolicyVersion ?? null;
  const contextGatewayEntrypointDigest =
    value.contextGatewayEntrypointDigest ?? null;
  const investigationProfileValid =
    !investigation ||
    (value.reviewInvestigationCapability === "review_investigation_v1" &&
      isSha256(value.reviewInvestigationCoverageProfileHash) &&
      isSha256(value.reviewInvestigationPolicyHash) &&
      isIdentifier(contextGatewayPolicyVersion) &&
      isSha256(contextGatewayEntrypointDigest));
  return (
    isIdentifier(value.producerReleaseId) &&
    ["hosted_composite", "public_reusable"].includes(value.distributionKind) &&
    isCommitSha(value.actionCommitSha) &&
    isCommitSha(value.runtimeCommitSha) &&
    (value.wrapperEntrypointDigest === null ||
      isSha256(value.wrapperEntrypointDigest)) &&
    isSha256(value.runtimeEntrypointDigest) &&
    ((contextGatewayPolicyVersion === null &&
      contextGatewayEntrypointDigest === null) ||
      (isIdentifier(contextGatewayPolicyVersion) &&
        isSha256(contextGatewayEntrypointDigest))) &&
    investigationProfileValid &&
    isSha256(value.schemaDigest) &&
    isSha256(value.canonicalizerDigest) &&
    value.capabilityProfile === "exact_revision_v2" &&
    isIdentifier(value.protocolLimitsProfileId) &&
    isIdentifier(value.operationalSloProfileId)
  );
}

function requireBase64Key(name, byteLength) {
  if (!isCanonicalBase64Key(read(name), byteLength, true)) {
    errors.push(`${name} must be a canonical ${byteLength}-byte base64 key.`);
  }
}

function requireSha256(name) {
  if (!/^[a-f0-9]{64}$/i.test(read(name))) {
    errors.push(`${name} must be a 64-character SHA-256 hex digest.`);
  }
}

function isCanonicalBase64Key(value, minimumByteLength, exactLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  const lengthValid = exactLength
    ? decoded.byteLength === minimumByteLength
    : decoded.byteLength >= minimumByteLength;
  return (
    lengthValid &&
    decoded.toString("base64").replace(/=+$/u, "") === value.replace(/=+$/u, "")
  );
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    value.trim() === value
  );
}

function isCommitSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isExactRecord(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
