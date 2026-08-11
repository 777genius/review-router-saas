/* global fetch */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { reviewV2ContextEnvForRole } from "./review-v2-render-env.mjs";
import { isLoopbackHostname } from "../packages/shared/src/validation/loopback-hostname.mjs";
import { resolveCodexRotatingInstallerDescriptor } from "../packages/shared/src/validation/codex-rotating-installer-descriptor.mjs";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import {
  assertTrustedGitHubEvidence,
  fetchTrustedGitHubEvidence,
  gitBlobSha,
} from "./lib/github-actions-trusted-evidence.mjs";

const renderApi = "https://api.render.com/v1";

function parseDotenv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/\\n/g, "\n");
  }
  return values;
}

function readOptionalDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseDotenv(fs.readFileSync(filePath, "utf8"));
}

export function requiredEnv(name, source) {
  const value = source[name] ?? process.env[name];
  if (!value) throw new Error(`Missing required value: ${name}`);
  return value;
}

const placeholderPattern =
  /(?:replace[-_ ]?with|placeholder|changeme|change[-_ ]?me|example|todo|insert[-_ ]?here)/iu;

const stableSecretNames = Object.freeze([
  "AUTH_SECRET",
  "REVIEW_ROUTER_ACTION_SESSION_SECRET",
  "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
  "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
]);

const installerDescriptorSchema =
  "reviewrouter.codex-rotating-installer-descriptor.v1";
const installerDescriptorEnvironmentNames = Object.freeze([
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
  "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
]);

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    throw new Error(`${label} fields are not canonical`);
  }
}

/**
 * Read the release-produced descriptor only through a separately pinned digest.
 * Keeping the digest outside the file prevents a locally substituted descriptor
 * from selecting its own installer bytes.
 */
export function readVerifiedInstallerReleaseDescriptor(source) {
  const descriptorPath = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_FILE",
    source,
  );
  const expectedDigest = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256",
    source,
  );
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new Error(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256 must be an exact lowercase SHA-256",
    );
  }
  const bytes = fs.readFileSync(descriptorPath);
  if (sha256Bytes(bytes) !== expectedDigest) {
    throw new Error(
      "immutable rotating installer release descriptor digest mismatch",
    );
  }
  let descriptor;
  try {
    descriptor = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      "immutable rotating installer release descriptor is not valid JSON",
    );
  }
  assertExactObjectKeys(
    descriptor,
    ["schemaVersion", "url", "version", "sha256", "actionRef", "reseed"],
    "immutable rotating installer release descriptor",
  );
  assertExactObjectKeys(
    descriptor.reseed,
    ["url", "sha256"],
    "immutable rotating reseed descriptor",
  );
  if (descriptor.schemaVersion !== installerDescriptorSchema) {
    throw new Error(
      "immutable rotating installer release descriptor schema mismatch",
    );
  }
  const actionRef = resolveHostedCodexRotatingActionRef(source);
  if (String(descriptor.actionRef).toLowerCase() !== actionRef) {
    throw new Error(
      "immutable rotating installer release descriptor Action ref mismatch",
    );
  }
  const tupleEnv = {
    ...source,
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: actionRef,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: descriptor.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: descriptor.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: descriptor.sha256,
  };
  const tuple = resolveCodexRotatingInstallerDescriptor(tupleEnv);
  const actionRepository = actionRef.slice(0, actionRef.lastIndexOf("@"));
  const actionSha = actionRef.slice(actionRef.lastIndexOf("@") + 1);
  const expectedReseedUrl = `https://raw.githubusercontent.com/${actionRepository}/${actionSha}/scripts/reseed-codex-rotating-auth.sh`;
  if (
    descriptor.reseed.url !== expectedReseedUrl ||
    !/^[a-f0-9]{64}$/u.test(descriptor.reseed.sha256)
  ) {
    throw new Error("immutable rotating reseed descriptor mismatch");
  }
  return Object.freeze({
    descriptorPath,
    descriptorSha256: expectedDigest,
    actionRef,
    tuple: Object.freeze(tuple),
  });
}

function installerDescriptorIdentity(value) {
  return JSON.stringify({
    descriptorSha256: value.descriptorSha256,
    actionRef: value.actionRef,
    tuple: value.tuple,
  });
}

function applyInstallerTuple(source, verified) {
  return {
    ...source,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: verified.tuple.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: verified.tuple.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: verified.tuple.sha256,
  };
}

export function resolveStableSecuritySecrets(source) {
  return Object.fromEntries(
    stableSecretNames.map((name) => {
      const value =
        name === "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"
          ? requireDatabaseRecoveryWitness(source)
          : requiredEnv(name, source);
      if (
        value !== value.trim() ||
        value.length < 32 ||
        placeholderPattern.test(value)
      ) {
        throw new Error(
          `${name} must be a stable, non-placeholder secret of at least 32 characters`,
        );
      }
      return [name, value];
    }),
  );
}

function resolveHostedActionRef(source) {
  const actionRef =
    source.REVIEW_ROUTER_ACTION_REF ?? process.env.REVIEW_ROUTER_ACTION_REF;
  if (actionRef) {
    return actionRef;
  }
  const version =
    source.REVIEW_ROUTER_ACTION_VERSION ??
    process.env.REVIEW_ROUTER_ACTION_VERSION ??
    "main";
  return `777genius/review-router@${version}`;
}

export function resolveHostedCodexRotatingActionRef(source) {
  const value = requiredEnv(
    "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
    source,
  ).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(value)) {
    throw new Error(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF must be an exact full-SHA Action ref",
    );
  }
  return value.toLowerCase();
}

export function resolveHostedCodexRotatingAllowedActionRefs(source) {
  const primary = resolveHostedCodexRotatingActionRef(source);
  const primaryRepository = primary.slice(0, primary.lastIndexOf("@"));
  const value = String(
    source.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS ??
      process.env.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS ??
      "",
  ).trim();
  if (!value) return "";
  const refs = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((ref) => {
      const normalized = ref.toLowerCase();
      if (
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/.test(normalized) ||
        normalized.slice(0, normalized.lastIndexOf("@")) !== primaryRepository
      ) {
        throw new Error(
          "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS must contain only same-repository full-SHA Action refs",
        );
      }
      return normalized;
    });
  return [...new Set(refs)].join(",");
}

export function requireDatabaseRecoveryWitness(source) {
  const value = requiredEnv(
    "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    source,
  ).trim();
  if (
    !/^[A-Za-z0-9_-]{43,256}$/.test(value) ||
    /replace-with|placeholder/i.test(value)
  ) {
    throw new Error(
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS must be 43-256 base64url characters",
    );
  }
  return value;
}

const databaseUrlEnvironmentByRole = Object.freeze({
  api: "REVIEW_ROUTER_API_DATABASE_URL",
  web: "REVIEW_ROUTER_WEB_DATABASE_URL",
  worker: "REVIEW_ROUTER_WORKER_DATABASE_URL",
  codexEffectAuthority: "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  roleBootstrap: "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
  releaseMigration: "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
});

export function resolveDistinctDatabaseRoleUrls(source) {
  const expectedUsers = {
    api: "reviewrouter_api",
    web: "reviewrouter_web",
    worker: "reviewrouter_worker",
    codexEffectAuthority: "reviewrouter_codex_effect_authority",
    roleBootstrap: "reviewrouter_role_bootstrap",
    releaseMigration: "reviewrouter_release_migration",
  };
  const urls = {};
  for (const [role, environmentName] of Object.entries(
    databaseUrlEnvironmentByRole,
  )) {
    let parsed;
    try {
      parsed = new URL(requiredEnv(environmentName, source));
    } catch {
      throw new Error(`${environmentName} must be a PostgreSQL URL`);
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== expectedUsers[role] ||
      !parsed.password
    ) {
      throw new Error(
        `${environmentName} must authenticate as ${expectedUsers[role]}`,
      );
    }
    urls[role] = parsed.toString();
  }
  const identities = Object.values(urls).map(normalizedDatabaseIdentity);
  if (new Set(identities).size !== 1) {
    throw new Error("all database roles must target one database generation");
  }
  if (
    new Set(Object.values(urls).map((value) => new URL(value).username))
      .size !== 6
  ) {
    throw new Error("database role credentials must be distinct");
  }
  return urls;
}

export function normalizedDatabaseIdentity(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("database connection must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("database connection must be a PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error("database connection must select exactly one database");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  return `${hostname}:${parsed.port || "5432"}/${databaseName}`;
}

export function assertSelectedDatabaseIdentity(
  selectedConnection,
  databaseUrls,
) {
  const selected = normalizedDatabaseIdentity(selectedConnection);
  for (const [role, value] of Object.entries(databaseUrls)) {
    if (normalizedDatabaseIdentity(value) !== selected) {
      throw new Error(
        `selected Render database identity does not match ${databaseUrlEnvironmentByRole[role]}`,
      );
    }
  }
  return selected;
}

function resourceValue(value) {
  return (
    value?.service ??
    value?.postgres ??
    value?.resource ??
    value?.environment ??
    value?.project ??
    value
  );
}

function identityId(value) {
  return typeof value === "string" ? value : value?.id;
}

export function observedRenderScope(value) {
  const resource = resourceValue(value) ?? {};
  return {
    ownerId: identityId(resource.ownerId ?? resource.owner),
    projectId: identityId(resource.projectId ?? resource.project),
    environmentId: identityId(resource.environmentId ?? resource.environment),
  };
}

export function assertExactRenderScope(value, expected, label) {
  const observed = observedRenderScope(value);
  for (const key of ["ownerId", "environmentId"]) {
    if (!observed[key] || observed[key] !== expected[key]) {
      throw new Error(`Render ${label} ${key} does not match requested scope`);
    }
  }
  if (observed.projectId && observed.projectId !== expected.projectId) {
    throw new Error(`Render ${label} projectId does not match requested scope`);
  }
  return resourceValue(value);
}

export async function verifyControlPlaneScope(client, expected) {
  const project = resourceValue(
    await client.request("GET", `/projects/${expected.projectId}`),
  );
  if (identityId(project?.ownerId ?? project?.owner) !== expected.ownerId) {
    throw new Error("Render project ownerId does not match requested scope");
  }
  const environment = resourceValue(
    await client.request("GET", `/environments/${expected.environmentId}`),
  );
  if (
    identityId(environment?.ownerId ?? environment?.owner) !==
      expected.ownerId ||
    identityId(environment?.projectId ?? environment?.project) !==
      expected.projectId
  ) {
    throw new Error(
      "Render environment does not match requested owner/project scope",
    );
  }
}

function readRenderApiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  const keyPath = path.join(
    process.env.HOME ?? "",
    ".config/review-router/render-api-key",
  );
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, "utf8").trim();
  throw new Error(
    "Missing RENDER_API_KEY or ~/.config/review-router/render-api-key",
  );
}

function readGithubPrivateKey(env) {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY;
  const keyFile =
    env.GITHUB_APP_PRIVATE_KEY_FILE ?? process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (keyFile) return fs.readFileSync(keyFile, "utf8");
  throw new Error(
    "Missing GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE",
  );
}

function assertHostedUrl(name, value) {
  if (!value) throw new Error(`${name} is required for hosted deployment`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a canonical public HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${name} must be a canonical public HTTPS origin`);
  }
}

export function assertHostedDeployEnv({ apiUrl, env, envFile, webUrl }) {
  // URL identity is security-sensitive workflow input and is never bypassed,
  // including staging deploys using REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV.
  assertHostedUrl("REVIEW_ROUTER_WEB_URL", webUrl);
  assertHostedUrl("REVIEW_ROUTER_API_URL", apiUrl);
  if (env.NEXTAUTH_URL) assertHostedUrl("NEXTAUTH_URL", env.NEXTAUTH_URL);

  if (env.REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV === "1") return;

  const appSlug = String(env.GITHUB_APP_SLUG ?? "");
  const issues = [];
  if (path.basename(envFile) === ".env.local") {
    issues.push("deployment env file is .env.local");
  }
  if (appSlug.toLowerCase().includes("local")) {
    issues.push("GITHUB_APP_SLUG looks local");
  }

  if (issues.length > 0) {
    throw new Error(
      [
        "Refusing hosted Render deploy with local-looking configuration.",
        ...issues.map((issue) => `- ${issue}`),
        "Use REVIEW_ROUTER_RENDER_ENV_FILE=.env.production or set REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV=1 only for an intentional staging deploy.",
      ].join("\n"),
    );
  }
}

function asEnvVars(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: String(value),
  }));
}

const apiOnlyGitLabEnvKeys = [
  "REVIEW_ROUTER_GITLAB_API_TOKEN",
  "REVIEW_ROUTER_GITLAB_API_BASE_URL",
  "REVIEW_ROUTER_GITLAB_INSTALLER_TOKEN",
  "REVIEW_ROUTER_GITLAB_INSTALLER_ADMIN_TOKEN",
  "REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON",
  "REVIEW_ROUTER_GITLAB_OIDC_ISSUER",
  "REVIEW_ROUTER_GITLAB_OIDC_JWKS_URL",
  "REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE",
  "REVIEW_ROUTER_GITLAB_RUNTIME_IMAGE",
];

function readOptionalEnvVars(env, keys) {
  const values = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") {
      values[key] = value;
    }
  }
  return values;
}

export class RenderClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${renderApi}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed ${response.status}`);
    }
    return data;
  }

  async list(endpoint) {
    const data = await this.request(
      "GET",
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}limit=100`,
    );
    return Array.isArray(data) ? data : [];
  }
}

export function serviceDetails({ type, startCommand, healthCheckPath }) {
  const details = {
    envSpecificDetails: {
      buildCommand:
        "pnpm --version && pnpm install --frozen-lockfile && pnpm db:generate && pnpm build",
      startCommand,
    },
    maxShutdownDelaySeconds: type === "background_worker" ? 120 : 60,
    plan: "starter",
    // Database rollout is a separately observed, immutable release-migration
    // caller. Per-service callers must be represented canonically as null.
    preDeployCommand: null,
    region: "frankfurt",
    runtime: "node",
  };
  if (type === "web_service") details.healthCheckPath = healthCheckPath;
  return details;
}

export function buildServiceEnv({
  databaseUrl,
  databaseUrls,
  env,
  privateKey,
  role,
  webUrl,
  apiUrl,
}) {
  const stableSecrets = resolveStableSecuritySecrets(env);
  const installer = resolveCodexRotatingInstallerDescriptor(env);
  const values = {
    AUTH_SECRET: stableSecrets.AUTH_SECRET,
    AUTH_TRUST_HOST: "true",
    DATABASE_URL: databaseUrl,
    GITHUB_APP_CLIENT_ID: requiredEnv("GITHUB_APP_CLIENT_ID", env),
    GITHUB_APP_CLIENT_SECRET: requiredEnv("GITHUB_APP_CLIENT_SECRET", env),
    GITHUB_APP_ID: requiredEnv("GITHUB_APP_ID", env),
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: requiredEnv("GITHUB_APP_SLUG", env),
    GITHUB_CLIENT_ID:
      env.GITHUB_CLIENT_ID ?? requiredEnv("GITHUB_APP_CLIENT_ID", env),
    GITHUB_CLIENT_SECRET:
      env.GITHUB_CLIENT_SECRET ?? requiredEnv("GITHUB_APP_CLIENT_SECRET", env),
    GITHUB_WEBHOOK_SECRET: requiredEnv("GITHUB_WEBHOOK_SECRET", env),
    NODE_ENV: "production",
    NODE_VERSION: "24",
    REVIEW_ROUTER_ACTION_REF: resolveHostedActionRef(env),
    REVIEW_ROUTER_ALLOWED_ACTION_REFS:
      env.REVIEW_ROUTER_ALLOWED_ACTION_REFS ?? "",
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
      resolveHostedCodexRotatingActionRef(env),
    REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS:
      resolveHostedCodexRotatingAllowedActionRefs(env),
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: installer.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: installer.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: installer.sha256,
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS:
      stableSecrets.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS,
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
    REVIEW_ROUTER_ACTION_SESSION_SECRET:
      stableSecrets.REVIEW_ROUTER_ACTION_SESSION_SECRET,
    REVIEW_ROUTER_API_URL: apiUrl,
    REVIEW_ROUTER_DEFAULT_EFFORT: env.REVIEW_ROUTER_DEFAULT_EFFORT ?? "xhigh",
    REVIEW_ROUTER_DEFAULT_MODEL: env.REVIEW_ROUTER_DEFAULT_MODEL ?? "gpt-5.5",
    REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
    REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
    REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK:
      env.REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK ?? "1",
    // Deploy convergence is always dormant. Cutover is a separate observed
    // operation and stale local/example values are intentionally ignored.
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "0",
    REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED: "0",
    REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
    REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
      env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES ?? "",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "0",
    REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES:
      env.REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES ?? "",
    REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC: "250",
    REVIEW_ROUTER_OUTBOX_BATCH_SIZE: "25",
    REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS: "900000",
    REVIEW_ROUTER_PUBLIC_API_URL: apiUrl,
    REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
      stableSecrets.REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY,
    REVIEW_ROUTER_WEB_URL: webUrl,
    REVIEW_ROUTER_WORKER_BUSY_MS: "250",
    REVIEW_ROUTER_WORKER_ERROR_MS: "5000",
    REVIEW_ROUTER_WORKER_IDLE_MS: "5000",
  };
  if (role === "api" || role === "web") {
    const authorityDatabaseUrl =
      databaseUrls?.codexEffectAuthority ??
      env.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL;
    if (authorityDatabaseUrl) {
      values.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL =
        authorityDatabaseUrl;
    }
  }
  if (role === "api") {
    Object.assign(values, readOptionalEnvVars(env, apiOnlyGitLabEnvKeys));
  }
  Object.assign(values, reviewV2ContextEnvForRole(env, role));
  Object.assign(values, {
    REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "0",
  });
  if (role !== "worker") values.PORT = "10000";
  return asEnvVars(values);
}

export async function addToEnvironment(client, environmentId, resourceIds) {
  if (!environmentId || resourceIds.length === 0) return;
  const readLinkedIds = async () => {
    const linked = await client.request(
      "GET",
      `/environments/${environmentId}/resources`,
    );
    return new Set(
      (Array.isArray(linked) ? linked : (linked?.resources ?? [])).map((item) =>
        identityId(resourceValue(item)?.id ?? item?.resourceId),
      ),
    );
  };
  let linkedIds = await readLinkedIds();
  const missingIds = resourceIds.filter(
    (resourceId) => !linkedIds.has(resourceId),
  );
  if (missingIds.length > 0) {
    await client.request("POST", `/environments/${environmentId}/resources`, {
      resourceIds: missingIds,
    });
    linkedIds = await readLinkedIds();
  }
  for (const resourceId of resourceIds) {
    if (!linkedIds.has(resourceId)) {
      throw new Error(
        `Render environment link verification failed for ${resourceId}`,
      );
    }
  }
}

export async function ensureDatabase(client, { allowCreate = true, ...scope }) {
  const candidates = (await client.list(`/postgres?ownerId=${scope.ownerId}`))
    .map((item) => item.postgres)
    .filter((postgres) => postgres?.name === "reviewrouter-db");
  const matching = candidates.filter((postgres) => {
    const observed = observedRenderScope(postgres);
    return (
      observed.ownerId === scope.ownerId &&
      observed.environmentId === scope.environmentId &&
      (!observed.projectId || observed.projectId === scope.projectId)
    );
  });
  if (matching.length > 1) {
    throw new Error(
      "multiple Render databases match the exact requested scope",
    );
  }
  const existing = matching[0];
  if (existing) {
    if (!/^17(?:\.|$)/u.test(String(existing.version ?? ""))) {
      throw new Error(
        "existing Render database reviewrouter-db must use PostgreSQL 17",
      );
    }
    return existing;
  }
  if (!allowCreate) {
    throw new Error(
      "runtime-deploy requires an existing database from the prepare phase",
    );
  }

  console.log("creating database reviewrouter-db");
  return await client.request("POST", "/postgres", {
    databaseName: "review_router",
    databaseUser: "reviewrouter_role_bootstrap",
    environmentId: scope.environmentId,
    ipAllowList: [],
    name: "reviewrouter-db",
    ownerId: scope.ownerId,
    projectId: scope.projectId,
    plan: "basic_256mb",
    region: "frankfurt",
    version: "17",
  });
}

async function waitForDatabase(client, databaseId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const postgres = await client.request("GET", `/postgres/${databaseId}`);
    let connectionInfo;
    try {
      connectionInfo = await client.request(
        "GET",
        `/postgres/${databaseId}/connection-info`,
      );
    } catch {
      connectionInfo = null;
    }
    const status = postgres.status ?? postgres.postgres?.status;
    console.log(
      `database status: ${status}${connectionInfo?.internalConnectionString ? " connection-ready" : ""}`,
    );
    if (connectionInfo?.internalConnectionString) {
      return {
        ...(postgres.postgres ?? postgres),
        internalConnectionString: connectionInfo.internalConnectionString,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error("Timed out waiting for database connection string");
}

export async function ensureService(client, spec, common) {
  const candidates = (await client.list(`/services?ownerId=${common.ownerId}`))
    .map((item) => item.service)
    .filter((service) => service?.name === spec.name);
  const matching = candidates.filter((service) => {
    const observed = observedRenderScope(service);
    return (
      observed.ownerId === common.ownerId &&
      observed.environmentId === common.environmentId &&
      (!observed.projectId || observed.projectId === common.projectId)
    );
  });
  if (matching.length > 1) {
    throw new Error(`multiple Render services named ${spec.name} match scope`);
  }
  const existing = matching[0];
  if (existing) return existing;
  if (common.allowCreate === false) {
    throw new Error(
      `runtime-deploy requires existing service ${spec.name} from the prepare phase`,
    );
  }

  console.log(`creating service ${spec.name}`);
  const created = await client.request("POST", "/services", {
    autoDeployTrigger: "off",
    branch: common.branch,
    name: spec.name,
    environmentId: common.environmentId,
    ownerId: common.ownerId,
    projectId: common.projectId,
    repo: common.repo,
    serviceDetails: serviceDetails(spec),
    type: spec.type,
  });
  return created.service ?? created;
}

export async function verifyResourceScope(
  client,
  kind,
  resourceId,
  scope,
  label,
) {
  return assertExactRenderScope(
    await client.request("GET", `/${kind}/${resourceId}`),
    scope,
    label,
  );
}

export async function syncService(client, service, spec, common) {
  console.log(`syncing env for ${spec.name}`);
  await verifyControlPlaneScope(client, common);
  await addToEnvironment(client, common.environmentId, [service.id]);
  await verifyResourceScope(client, "services", service.id, common, spec.name);
  // Re-read the digest-pinned release descriptor after all scope reads and
  // immediately before constructing the secret-bearing PUT. A path swap or
  // local edit fails closed unless the bytes still match the release digest.
  const rereadDescriptor = readVerifiedInstallerReleaseDescriptor(common.env);
  if (
    installerDescriptorIdentity(rereadDescriptor) !==
    installerDescriptorIdentity(common.installerDescriptor)
  ) {
    throw new Error(
      "immutable rotating installer release descriptor changed before mutation",
    );
  }
  const expectedEnv = buildServiceEnv({
    ...common,
    env: applyInstallerTuple(common.env, rereadDescriptor),
    databaseUrl: common.databaseUrls[spec.role],
    role: spec.role,
  });
  await client.request("PUT", `/services/${service.id}/env-vars`, expectedEnv);
  await verifyServiceEnvConvergence(client, service, expectedEnv);
}

function renderEnvVars(value) {
  const candidate = Array.isArray(value)
    ? value
    : (value?.envVars ??
      value?.environmentVariables ??
      value?.service?.envVars);
  if (!Array.isArray(candidate)) {
    throw new Error(
      "Render service environment convergence response is invalid",
    );
  }
  return Object.fromEntries(
    candidate.map((item) => {
      const envVar = item?.envVar ?? item;
      return [
        envVar?.key,
        String(envVar?.value ?? envVar?.envVarValue?.value ?? ""),
      ];
    }),
  );
}

export async function verifyServiceEnvConvergence(
  client,
  service,
  expectedEnv,
) {
  const observed = renderEnvVars(
    await client.request("GET", `/services/${service.id}/env-vars?limit=100`),
  );
  for (const { key, value } of expectedEnv) {
    if (observed[key] !== String(value)) {
      throw new Error(
        `Render service ${service.name} environment did not converge for ${key}`,
      );
    }
  }
  // Exercise the same hosted readiness contracts against the provider read,
  // including exact tuple shape and the stable encryption/recovery secrets.
  resolveCodexRotatingInstallerDescriptor(observed);
  resolveStableSecuritySecrets(observed);
  for (const key of installerDescriptorEnvironmentNames) {
    if (!observed[key]) {
      throw new Error(
        `Render service ${service.name} readiness is missing ${key}`,
      );
    }
  }
}

export async function disableAndVerifyPreDeployCommand(client, service) {
  await client.request("PATCH", `/services/${service.id}`, {
    autoDeployTrigger: "off",
    serviceDetails: { preDeployCommand: null },
  });
  const observed = await client.request("GET", `/services/${service.id}`);
  const value = observed.service ?? observed;
  const details = value.serviceDetails;
  if (details?.preDeployCommand !== null) {
    throw new Error(
      `Render service ${service.name} preDeployCommand is not canonical null`,
    );
  }
  if (value.autoDeployTrigger !== "off") {
    throw new Error(
      `Render service ${service.name} autoDeployTrigger is not canonical off`,
    );
  }
}

export function assertMigrationEvidence(trustedEvidence, context) {
  const evidence = assertTrustedGitHubEvidence(trustedEvidence).evidence;
  return assertMigrationEvidencePayload(evidence, context);
}

export function assertMigrationEvidencePayload(
  evidence,
  { scope, databaseId, databaseIdentity, commit, imageDigest, databaseUrls },
) {
  if (evidence?.version !== 3) {
    throw new Error("migration evidence version must be 3");
  }
  const provider = evidence.providerObservation;
  const providerResponses = Array.isArray(provider?.rawResponses)
    ? provider.rawResponses
    : [];
  const digest = (value) =>
    createHash("sha256")
      .update(Buffer.from(canonicalProviderJson(value)))
      .digest("hex");
  if (
    provider?.observationVersion !== 3 ||
    provider?.source !== "render-api" ||
    providerResponses.length < 5 ||
    providerResponses.some(
      (response) =>
        typeof response?.url !== "string" ||
        !response.url.startsWith("https://api.render.com/v1/") ||
        response.status !== 200 ||
        response.bodySha256 !== digest(response.body),
    ) ||
    provider.captureIdentity?.rawResponsesSha256 !== digest(providerResponses)
  ) {
    throw new Error(
      "migration evidence is missing a bound Render provider observation",
    );
  }
  for (const key of ["ownerId", "projectId", "environmentId"]) {
    if (evidence.scope?.[key] !== scope[key]) {
      throw new Error(
        `migration evidence ${key} does not match requested scope`,
      );
    }
  }
  if (
    evidence.release?.commit !== commit ||
    evidence.release?.imageDigest !== imageDigest
  ) {
    throw new Error("migration evidence immutable release does not match");
  }
  if (
    evidence.database?.id !== databaseId ||
    evidence.database?.postgresMajorVersion !== "17" ||
    evidence.database?.identity !== databaseIdentity
  ) {
    throw new Error("migration evidence database identity does not match");
  }
  const migration = evidence.exclusiveMigration;
  if (
    typeof migration?.jobId !== "string" ||
    !migration.jobId ||
    migration.callerCount !== 1 ||
    migration.status !== "succeeded" ||
    migration.preflightStatus !== "passed" ||
    migration.migrationStatus !== "succeeded" ||
    migration.evidenceStatus !== "verified"
  ) {
    throw new Error(
      "migration evidence must prove one successful exclusive preflight/migration/evidence job",
    );
  }
  const observedCaller = provider.migrationCaller;
  const rawProviderBodies = canonicalProviderJson(
    providerResponses.map((response) => response.body),
  );
  const capturedMigrationOutputs = providerResponses.flatMap((response) => {
    const entries = Array.isArray(response.body)
      ? response.body
      : (response.body?.logs ?? []);
    return entries.flatMap((entry) => {
      try {
        return [JSON.parse(entry.message ?? entry.text ?? "")];
      } catch {
        return [];
      }
    });
  });
  if (
    provider.database?.id !== databaseId ||
    !/^17(?:\.|$)/u.test(String(provider.database?.version ?? "")) ||
    provider.database?.ownerId !== scope.ownerId ||
    observedCaller?.jobId !== migration.jobId ||
    observedCaller?.callerCount !== 1 ||
    observedCaller?.commit !== commit ||
    observedCaller?.imageDigest !== imageDigest ||
    observedCaller?.status !== "succeeded" ||
    observedCaller?.command !== "pnpm codex-rotating:release-migration" ||
    [
      databaseId,
      migration.jobId,
      commit,
      imageDigest,
      "pnpm codex-rotating:release-migration",
    ].some((value) => !rawProviderBodies.includes(JSON.stringify(value)))
  ) {
    throw new Error("migration evidence Render caller observation mismatch");
  }
  if (
    canonicalProviderJson(provider.migrationOutput) !==
      canonicalProviderJson(evidence.migrationOutput) ||
    !capturedMigrationOutputs.some(
      (output) =>
        canonicalProviderJson(output) ===
        canonicalProviderJson(evidence.migrationOutput),
    ) ||
    evidence.migrationOutput?.caller !==
      "scripts/run-codex-rotating-release-migration.mjs" ||
    evidence.migrationOutput?.callerCount !== 1 ||
    evidence.migrationOutput?.commit !== commit ||
    evidence.migrationOutput?.imageDigest !== imageDigest ||
    evidence.migrationOutput?.databaseIdentity !== databaseIdentity ||
    evidence.migrationOutput?.status !== "succeeded"
  ) {
    throw new Error("migration evidence canonical caller output mismatch");
  }
  const expectedRoles = new Map(
    Object.entries(databaseUrls)
      .filter(([role]) => role !== "roleBootstrap")
      .map(([role, url]) => [
        role,
        {
          username: decodeURIComponent(new URL(url).username),
          databaseIdentity: normalizedDatabaseIdentity(url),
        },
      ]),
  );
  const roles = Array.isArray(evidence.runtimeRoles)
    ? evidence.runtimeRoles
    : [];
  if (roles.length !== expectedRoles.size) {
    throw new Error("migration evidence must verify all five database roles");
  }
  for (const role of roles) {
    const expected = expectedRoles.get(role.role);
    if (
      !expected ||
      role.username !== expected.username ||
      role.databaseIdentity !== expected.databaseIdentity ||
      role.login !== true ||
      role.canSetReleaseRole !== (role.role === "releaseMigration")
    ) {
      throw new Error("migration evidence database role verification failed");
    }
    expectedRoles.delete(role.role);
  }
  if (expectedRoles.size !== 0) {
    throw new Error("migration evidence must verify every canonical role once");
  }
  return evidence;
}

export async function fetchTrustedMigrationEvidence(
  env,
  fetchImpl = globalThis.fetch,
) {
  const workflowPath = ".github/workflows/codex-rotating-release-migration.yml";
  const workflowBytes = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", workflowPath),
  );
  const commit = requiredEnv("REVIEW_ROUTER_RENDER_COMMIT_SHA", env);
  return fetchTrustedGitHubEvidence(
    {
      token: requiredEnv("REVIEW_ROUTER_ROLLOUT_GITHUB_TOKEN", env),
      repository: "777genius/review-router-saas",
      repositoryId: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_REPOSITORY_ID",
        env,
      ),
      workflowPath,
      workflowSha: gitBlobSha(workflowBytes),
      workflowRef: commit,
      headSha: commit,
      rolloutId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID", env),
      runId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ID", env),
      runAttempt: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ATTEMPT",
        env,
      ),
      jobId: requiredEnv("REVIEW_ROUTER_ROLLOUT_EVIDENCE_JOB_ID", env),
      jobName: "trusted-release-migration",
      artifactId: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_ID",
        env,
      ),
      artifactName: requiredEnv(
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME",
        env,
      ),
    },
    fetchImpl,
  );
}

export function claimTrustedMigrationEvidence(
  databaseUrl,
  trustedEvidence,
  execute = spawnSync,
) {
  const trusted = assertTrustedGitHubEvidence(trustedEvidence);
  const parsed = new URL(databaseUrl);
  if (decodeURIComponent(parsed.username) !== "reviewrouter_release_migration")
    throw new Error(
      "trusted migration evidence claim requires the release role",
    );
  const receipt = trusted.receipt;
  const result = execute(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      `artifact_digest=${receipt.artifactDigest}`,
      "--set",
      `artifact_id=${receipt.artifactId}`,
      "--set",
      `rollout_id=${receipt.rolloutId}`,
      "--set",
      `run_id=${receipt.runId}`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PGHOST: parsed.hostname,
        PGPORT: parsed.port || "5432",
        PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
        PGUSER: decodeURIComponent(parsed.username),
        PGPASSWORD: decodeURIComponent(parsed.password),
        PGSSLMODE: parsed.searchParams.get("sslmode") ?? "require",
      },
      input: String.raw`\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(1381126735, 1129271120);
SELECT set_config('reviewrouter.artifact_digest', :'artifact_digest', true);
SELECT set_config('reviewrouter.artifact_id', :'artifact_id', true);
SELECT set_config('reviewrouter.rollout_id', :'rollout_id', true);
SELECT set_config('reviewrouter.run_id', :'run_id', true);
DO $claim$
DECLARE
  binding jsonb;
  receipts jsonb;
BEGIN
  SELECT obj_description(oid, 'pg_database')::jsonb INTO binding
  FROM pg_database WHERE datname = current_database();
  IF binding IS NULL
     OR binding->>'systemIdentifier' <> (SELECT system_identifier::text FROM pg_control_system())
     OR binding->>'recoveryWitnessSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'trusted migration evidence database generation binding invalid';
  END IF;
  receipts := coalesce(binding->'consumedMigrationEvidence', '[]'::jsonb);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(receipts) receipt
    WHERE receipt->>'artifactDigest' = current_setting('reviewrouter.artifact_digest')
       OR receipt->>'rolloutId' = current_setting('reviewrouter.rollout_id')
       OR (receipt->>'runId' = current_setting('reviewrouter.run_id') AND receipt->>'artifactId' = current_setting('reviewrouter.artifact_id'))
  ) THEN
    RAISE EXCEPTION 'trusted migration evidence replay rejected';
  END IF;
  binding := jsonb_set(binding, '{version}', '2'::jsonb, true);
  binding := jsonb_set(
    binding,
    '{consumedMigrationEvidence}',
    receipts || jsonb_build_array(jsonb_build_object(
      'artifactDigest', current_setting('reviewrouter.artifact_digest'),
      'artifactId', current_setting('reviewrouter.artifact_id'),
      'rolloutId', current_setting('reviewrouter.rollout_id'),
      'runId', current_setting('reviewrouter.run_id'),
      'claimedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )),
    true
  );
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), binding::text);
END
$claim$;
COMMIT;
SELECT 'claimed';
`,
      maxBuffer: 1024 * 1024,
    },
  );
  if (
    result.status !== 0 ||
    result.stdout.trim().split(/\s+/u).at(-1) !== "claimed"
  )
    throw new Error("trusted migration evidence claim failed or was replayed");
}

function resolvedDeployFacts(deploy) {
  const value = deploy.deploy ?? deploy;
  return {
    id: value.id ?? null,
    status: value.status ?? null,
    commit:
      value.commit?.id ??
      value.commitId ??
      value.commit?.sha ??
      value.sha ??
      null,
    imageDigest:
      value.image?.digest ??
      value.imageDigest ??
      value.build?.imageDigest ??
      null,
  };
}

export async function triggerAndVerifyDeploy(
  client,
  service,
  {
    commit,
    imageDigest,
    poll = async () => new Promise((resolve) => setTimeout(resolve, 10_000)),
    maxAttempts = 180,
  },
) {
  console.log(`triggering deploy for ${service.name}`);
  const created = await client.request(
    "POST",
    `/services/${service.id}/deploys`,
    {
      clearCache: "do_not_clear",
      commitId: commit,
    },
  );
  const createdId = resolvedDeployFacts(created).id;
  if (!createdId)
    throw new Error(
      `Render service ${service.name} did not return a deploy id`,
    );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const observed = await client.request(
      "GET",
      `/services/${service.id}/deploys/${createdId}`,
    );
    const facts = resolvedDeployFacts(observed);
    if (
      ["build_failed", "update_failed", "canceled", "deactivated"].includes(
        facts.status,
      )
    ) {
      throw new Error(
        `Render service ${service.name} deploy terminated as ${facts.status}`,
      );
    }
    if (facts.status === "live") {
      if (facts.commit !== commit) {
        throw new Error(
          `Render service ${service.name} resolved commit mismatch`,
        );
      }
      if (facts.imageDigest !== imageDigest) {
        throw new Error(
          `Render service ${service.name} resolved image digest mismatch`,
        );
      }
      return facts;
    }
    await poll();
  }
  throw new Error(`Render service ${service.name} deploy did not resolve`);
}

export async function main() {
  const envFile =
    process.env.REVIEW_ROUTER_RENDER_ENV_FILE ?? ".env.production";
  const env = { ...readOptionalDotenv(envFile), ...process.env };
  const ownerId = requiredEnv("RENDER_OWNER_ID", env);
  const projectId = requiredEnv("RENDER_PROJECT_ID", env);
  const environmentId = requiredEnv("RENDER_ENVIRONMENT_ID", env);
  const phase = requiredEnv("REVIEW_ROUTER_RENDER_PHASE", env);
  if (!["prepare", "runtime-deploy"].includes(phase)) {
    throw new Error(
      "REVIEW_ROUTER_RENDER_PHASE must be prepare or runtime-deploy",
    );
  }
  const scope = { ownerId, projectId, environmentId };
  const repo = requiredEnv("RENDER_REPO", env);
  const branch = env.RENDER_BRANCH ?? "main";
  const commit = requiredEnv("REVIEW_ROUTER_RENDER_COMMIT_SHA", env);
  const imageDigest = requiredEnv("REVIEW_ROUTER_RENDER_IMAGE_DIGEST", env);
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error(
      "REVIEW_ROUTER_RENDER_COMMIT_SHA must be an exact 40-character lowercase SHA",
    );
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest))
    throw new Error(
      "REVIEW_ROUTER_RENDER_IMAGE_DIGEST must be an exact sha256 digest",
    );
  const webUrl = env.REVIEW_ROUTER_WEB_URL ?? "https://reviewrouter.site";
  const apiUrl = env.REVIEW_ROUTER_API_URL ?? "https://api.reviewrouter.site";
  assertHostedDeployEnv({ apiUrl, env, envFile, webUrl });
  // Resolve every cross-process security value before constructing a Render
  // client or mutating hosted state. buildServiceEnv revalidates defensively.
  env.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF =
    resolveHostedCodexRotatingActionRef(env);
  env.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS =
    resolveHostedCodexRotatingAllowedActionRefs(env);
  const stableSecrets = resolveStableSecuritySecrets(env);
  Object.assign(env, stableSecrets);
  const installerDescriptor = readVerifiedInstallerReleaseDescriptor(env);
  Object.assign(env, applyInstallerTuple(env, installerDescriptor));
  const databaseUrls =
    phase === "runtime-deploy" ? resolveDistinctDatabaseRoleUrls(env) : null;
  const privateKey =
    phase === "runtime-deploy" ? readGithubPrivateKey(env) : null;
  const client = new RenderClient(readRenderApiKey());
  let trustedMigrationEvidence = null;

  await verifyControlPlaneScope(client, scope);
  const database = await ensureDatabase(client, {
    ...scope,
    allowCreate: phase === "prepare",
  });
  const readyDatabase = await waitForDatabase(client, database.id);
  if (!/^17(?:\.|$)/u.test(String(readyDatabase.version ?? ""))) {
    throw new Error(
      "ready Render database reviewrouter-db must use PostgreSQL 17",
    );
  }
  await verifyResourceScope(
    client,
    "postgres",
    readyDatabase.id,
    scope,
    "reviewrouter-db",
  );
  if (phase === "runtime-deploy") {
    const selectedDatabaseIdentity = assertSelectedDatabaseIdentity(
      readyDatabase.internalConnectionString,
      databaseUrls,
    );
    trustedMigrationEvidence = await fetchTrustedMigrationEvidence(env);
    assertMigrationEvidence(trustedMigrationEvidence, {
      scope,
      databaseId: readyDatabase.id,
      databaseIdentity: selectedDatabaseIdentity,
      commit,
      imageDigest,
      databaseUrls,
    });
  }
  const common = {
    allowCreate: phase === "prepare",
    apiUrl,
    branch,
    databaseUrls,
    env,
    installerDescriptor,
    environmentId,
    ownerId,
    projectId,
    privateKey,
    repo,
    webUrl,
  };
  const serviceSpecs = [
    {
      healthCheckPath: "/",
      name: "reviewrouter-web",
      role: "web",
      startCommand: "pnpm web:start",
      type: "web_service",
    },
    {
      healthCheckPath: "/health",
      name: "reviewrouter-api",
      role: "api",
      startCommand: "HOST=0.0.0.0 pnpm api:start",
      type: "web_service",
    },
    {
      name: "reviewrouter-worker",
      role: "worker",
      startCommand: "pnpm worker:start",
      type: "background_worker",
    },
  ];

  const services = [];
  for (const spec of serviceSpecs) {
    const service = await ensureService(client, spec, common);
    services.push({ service, spec });
  }
  await addToEnvironment(client, environmentId, [
    readyDatabase.id,
    ...services.map(({ service }) => service.id),
  ]);
  for (const { service } of services) {
    await verifyResourceScope(
      client,
      "services",
      service.id,
      scope,
      service.name,
    );
  }
  // Unsafe commit deployment and per-service migrations remain disabled in
  // both phases. No runtime environment is written during prepare.
  for (const { service } of services)
    await disableAndVerifyPreDeployCommand(client, service);

  if (phase === "prepare") {
    console.log(
      JSON.stringify(
        {
          phase,
          scope,
          database: { id: readyDatabase.id, status: readyDatabase.status },
          services: services.map(({ service, spec }) => ({
            serviceId: service.id,
            name: service.name,
            role: spec.role,
          })),
          next: "dispatch the immutable codex-rotating-release-migration workflow once, then invoke runtime-deploy with its authenticated GitHub artifact identity",
        },
        null,
        2,
      ),
    );
    return;
  }

  claimTrustedMigrationEvidence(
    databaseUrls.releaseMigration,
    trustedMigrationEvidence,
  );

  // Scope is fetched again immediately before each complete secret-bearing PUT.
  for (const { service, spec } of services)
    await syncService(client, service, spec, common);
  const resolvedDeploys = [];
  for (const { service } of services)
    resolvedDeploys.push(
      await triggerAndVerifyDeploy(client, service, { commit, imageDigest }),
    );

  console.log(
    JSON.stringify(
      {
        phase,
        scope,
        database: { id: readyDatabase.id, status: readyDatabase.status },
        services: services.map(({ service }, index) => ({
          serviceId: service.id,
          name: service.name,
          role: services[index].spec.role,
          url: service.serviceDetails?.url ?? null,
          deployId: resolvedDeploys[index]?.id ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
