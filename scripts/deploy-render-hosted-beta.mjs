/* global fetch */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

function requiredEnv(name, source) {
  const value = source[name] ?? process.env[name];
  if (!value) throw new Error(`Missing required value: ${name}`);
  return value;
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

function isLocalUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertHostedDeployEnv({ apiUrl, env, envFile, webUrl }) {
  if (env.REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV === "1") return;

  const appSlug = String(env.GITHUB_APP_SLUG ?? "");
  const localValues = [
    ["REVIEW_ROUTER_WEB_URL", webUrl],
    ["REVIEW_ROUTER_API_URL", apiUrl],
    ["NEXTAUTH_URL", env.NEXTAUTH_URL],
  ].filter(([, value]) => isLocalUrl(value));

  const issues = [];
  if (path.basename(envFile) === ".env.local") {
    issues.push("deployment env file is .env.local");
  }
  for (const [key, value] of localValues) {
    issues.push(`${key} points to ${value}`);
  }
  if (appSlug.toLowerCase().includes("local")) {
    issues.push(`GITHUB_APP_SLUG looks local: ${appSlug}`);
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

class RenderClient {
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
      const message = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(
        `${method} ${endpoint} failed ${response.status}: ${message}`,
      );
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

function serviceDetails({ type, startCommand, healthCheckPath }) {
  const details = {
    envSpecificDetails: {
      buildCommand:
        "pnpm --version && pnpm install --frozen-lockfile && pnpm db:generate && pnpm build",
      startCommand,
    },
    maxShutdownDelaySeconds: type === "background_worker" ? 120 : 60,
    plan: "starter",
    preDeployCommand: "pnpm db:migrate:deploy",
    region: "frankfurt",
    runtime: "node",
  };
  if (type === "web_service") details.healthCheckPath = healthCheckPath;
  return details;
}

function buildServiceEnv({
  databaseUrl,
  env,
  privateKey,
  role,
  webUrl,
  apiUrl,
}) {
  const values = {
    AUTH_SECRET:
      env.AUTH_SECRET ?? crypto.randomBytes(32).toString("base64url"),
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
    REVIEW_ROUTER_ACTION_REF: requiredEnv("REVIEW_ROUTER_ACTION_REF", env),
    REVIEW_ROUTER_ALLOWED_ACTION_REFS:
      env.REVIEW_ROUTER_ALLOWED_ACTION_REFS ?? "",
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
    REVIEW_ROUTER_ACTION_SESSION_SECRET:
      env.REVIEW_ROUTER_ACTION_SESSION_SECRET ??
      crypto.randomBytes(32).toString("base64url"),
    REVIEW_ROUTER_API_URL: apiUrl,
    REVIEW_ROUTER_DEFAULT_EFFORT: env.REVIEW_ROUTER_DEFAULT_EFFORT ?? "medium",
    REVIEW_ROUTER_DEFAULT_MODEL: env.REVIEW_ROUTER_DEFAULT_MODEL ?? "gpt-5.5",
    REVIEW_ROUTER_DISABLE_ACTION_CONTROL_PLANE: "0",
    REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "0",
    REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS: "1",
    REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK:
      env.REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK ?? "1",
    REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH:
      env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH ?? "1",
    REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
    REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
      env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES ?? "",
    REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES:
      env.REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES ?? "",
    REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC: "250",
    REVIEW_ROUTER_OUTBOX_BATCH_SIZE: "25",
    REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS: "900000",
    REVIEW_ROUTER_PUBLIC_API_URL: apiUrl,
    REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
      env.REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY ??
      crypto.randomBytes(32).toString("base64url"),
    REVIEW_ROUTER_WEB_URL: webUrl,
    REVIEW_ROUTER_WORKER_BUSY_MS: "250",
    REVIEW_ROUTER_WORKER_ERROR_MS: "5000",
    REVIEW_ROUTER_WORKER_IDLE_MS: "5000",
  };
  if (role !== "worker") values.PORT = "10000";
  return asEnvVars(values);
}

async function addToEnvironment(client, environmentId, resourceIds) {
  if (!environmentId || resourceIds.length === 0) return;
  try {
    await client.request("POST", `/environments/${environmentId}/resources`, {
      resourceIds,
    });
  } catch (error) {
    console.log(`environment link warning: ${error.message}`);
  }
}

async function ensureDatabase(client, { ownerId, environmentId }) {
  const existing = (await client.list("/postgres"))
    .map((item) => item.postgres)
    .find((postgres) => postgres?.name === "reviewrouter-db");
  if (existing) return existing;

  console.log("creating database reviewrouter-db");
  return await client.request("POST", "/postgres", {
    databaseName: "review_router",
    databaseUser: "reviewrouter",
    environmentId,
    ipAllowList: [],
    name: "reviewrouter-db",
    ownerId,
    plan: "basic_256mb",
    region: "frankfurt",
    version: "16",
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

async function ensureService(client, spec, common) {
  const existing = (await client.list("/services"))
    .map((item) => item.service)
    .find((service) => service?.name === spec.name);
  if (existing) return existing;

  console.log(`creating service ${spec.name}`);
  const created = await client.request("POST", "/services", {
    autoDeployTrigger: "commit",
    branch: common.branch,
    envVars: buildServiceEnv({ ...common, role: spec.role }),
    name: spec.name,
    ownerId: common.ownerId,
    repo: common.repo,
    serviceDetails: serviceDetails(spec),
    type: spec.type,
  });
  return created.service ?? created;
}

async function syncService(client, service, spec, common) {
  console.log(`syncing env for ${spec.name}`);
  await client.request(
    "PUT",
    `/services/${service.id}/env-vars`,
    buildServiceEnv({ ...common, role: spec.role }),
  );
}

async function triggerDeploy(client, service) {
  console.log(`triggering deploy for ${service.name}`);
  await client.request("POST", `/services/${service.id}/deploys`, {
    clearCache: "do_not_clear",
  });
}

const envFile = process.env.REVIEW_ROUTER_RENDER_ENV_FILE ?? ".env.production";
const env = { ...readOptionalDotenv(envFile), ...process.env };
const ownerId = requiredEnv("RENDER_OWNER_ID", env);
const environmentId = requiredEnv("RENDER_ENVIRONMENT_ID", env);
const repo = requiredEnv("RENDER_REPO", env);
const branch = env.RENDER_BRANCH ?? "main";
const webUrl = env.REVIEW_ROUTER_WEB_URL ?? "https://reviewrouter.site";
const apiUrl = env.REVIEW_ROUTER_API_URL ?? "https://api.reviewrouter.site";
assertHostedDeployEnv({ apiUrl, env, envFile, webUrl });
const privateKey = readGithubPrivateKey(env);
const client = new RenderClient(readRenderApiKey());

const database = await ensureDatabase(client, { environmentId, ownerId });
const readyDatabase = await waitForDatabase(client, database.id);
const common = {
  apiUrl,
  branch,
  databaseUrl: readyDatabase.internalConnectionString,
  env,
  ownerId,
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
for (const { service, spec } of services)
  await syncService(client, service, spec, common);
for (const { service } of services) await triggerDeploy(client, service);

console.log(
  JSON.stringify(
    {
      database: { id: readyDatabase.id, status: readyDatabase.status },
      services: services.map(({ service }) => ({
        id: service.id,
        name: service.name,
        url: service.serviceDetails?.url ?? null,
      })),
    },
    null,
    2,
  ),
);
