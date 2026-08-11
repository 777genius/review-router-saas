/* global fetch */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reviewV2ContextEnvForRole } from "./review-v2-render-env.mjs";
import { isLoopbackHostname } from "../packages/shared/src/validation/loopback-hostname.mjs";

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
  releaseMigration: "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
});

export function resolveDistinctDatabaseRoleUrls(source) {
  const expectedUsers = {
    api: "reviewrouter_api",
    web: "reviewrouter_web",
    worker: "reviewrouter_worker",
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
      .size !== 4
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
  env,
  privateKey,
  role,
  webUrl,
  apiUrl,
}) {
  const stableSecrets = resolveStableSecuritySecrets(env);
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
    databaseUser: "reviewrouter_release_migration",
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
  await client.request(
    "PUT",
    `/services/${service.id}/env-vars`,
    buildServiceEnv({
      ...common,
      databaseUrl: common.databaseUrls[spec.role],
      role: spec.role,
    }),
  );
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

function readJsonEvidence(filePath) {
  if (!filePath) {
    throw new Error(
      "REVIEW_ROUTER_RENDER_MIGRATION_EVIDENCE_FILE is required for runtime-deploy",
    );
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("migration evidence must be readable strict JSON");
  }
  return value;
}

export function assertMigrationEvidence(
  evidence,
  { scope, databaseId, databaseIdentity, commit, imageDigest, databaseUrls },
) {
  if (evidence?.version !== 1) {
    throw new Error("migration evidence version must be 1");
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
  const expectedRoles = new Map(
    Object.entries(databaseUrls).map(([role, url]) => [
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
    throw new Error("migration evidence must verify all four database roles");
  }
  for (const role of roles) {
    const expected = expectedRoles.get(role.role);
    if (
      !expected ||
      role.username !== expected.username ||
      role.databaseIdentity !== expected.databaseIdentity ||
      role.login !== true ||
      role.canSetReleaseRole !== false
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
  const databaseUrls =
    phase === "runtime-deploy" ? resolveDistinctDatabaseRoleUrls(env) : null;
  const privateKey =
    phase === "runtime-deploy" ? readGithubPrivateKey(env) : null;
  const client = new RenderClient(readRenderApiKey());

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
    assertMigrationEvidence(
      readJsonEvidence(env.REVIEW_ROUTER_RENDER_MIGRATION_EVIDENCE_FILE),
      {
        scope,
        databaseId: readyDatabase.id,
        databaseIdentity: selectedDatabaseIdentity,
        commit,
        imageDigest,
        databaseUrls,
      },
    );
  }
  const common = {
    allowCreate: phase === "prepare",
    apiUrl,
    branch,
    databaseUrls,
    env,
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
          next: "run one exclusive PG17 role-provisioning, preflight, migration, and evidence job; then invoke runtime-deploy with its verified evidence file",
        },
        null,
        2,
      ),
    );
    return;
  }

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
