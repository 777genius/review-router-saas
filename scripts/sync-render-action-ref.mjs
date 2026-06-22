/* global fetch */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const renderApi = "https://api.render.com/v1";
const defaultActionRepository = "777genius/review-router";
const defaultBranch = "main";
const defaultServiceNames = [
  "reviewrouter-web",
  "reviewrouter-api",
  "reviewrouter-worker",
];

function usage() {
  return `Usage:
  pnpm ops:sync-action-ref [options]

Options:
  --action-ref owner/repo@ref          Use an explicit action ref. Hosted refs support main, v1, v1.x.y, or a full SHA.
  --action-repo owner/repo             Build the default branch action ref from this repo. Default: ${defaultActionRepository}
  --branch name                        Branch ref to use when --action-ref is omitted. Default: ${defaultBranch}
  --services a,b,c                     Render service names. Default: ${defaultServiceNames.join(",")}
  --allowlist-window n                 Keep n trusted refs including the new ref. Default: 2
  --extra-allowed-action-ref ref        Keep an additional full-SHA action ref in the allowlist. Can be repeated or comma-separated.
  --no-deploy                          Update env vars without triggering Render deploys.
  --wait                               Wait for requested Render deploys to become live.
  --wait-timeout-ms n                  Maximum time to wait for deploys. Default: 900000
  --poll-interval-ms n                 Render deploy polling interval. Default: 10000
  --dry-run                            Print the planned changes only.
  --help                               Show this help.

Requires RENDER_API_KEY or ~/.config/review-router/render-api-key.`;
}

function parseArgs(argv) {
  const args = {
    actionRef: "",
    actionRepo: defaultActionRepository,
    branch: defaultBranch,
    serviceNames: defaultServiceNames,
    allowlistWindow: 2,
    extraAllowedActionRefs: [],
    deploy: true,
    wait: false,
    waitTimeoutMs: 900_000,
    pollIntervalMs: 10_000,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--action-ref") {
      args.actionRef = next();
    } else if (arg === "--action-repo") {
      args.actionRepo = next();
    } else if (arg === "--branch") {
      args.branch = next();
    } else if (arg === "--services") {
      args.serviceNames = next()
        .split(",")
        .map((serviceName) => serviceName.trim())
        .filter(Boolean);
    } else if (arg === "--allowlist-window") {
      args.allowlistWindow = Number.parseInt(next(), 10);
    } else if (arg === "--extra-allowed-action-ref") {
      args.extraAllowedActionRefs.push(
        ...next()
          .split(",")
          .map((actionRef) => actionRef.trim())
          .filter(Boolean)
          .map((actionRef) =>
            normalizeFullShaActionRef(actionRef, "--extra-allowed-action-ref"),
          ),
      );
    } else if (arg === "--no-deploy") {
      args.deploy = false;
    } else if (arg === "--wait") {
      args.wait = true;
    } else if (arg === "--wait-timeout-ms") {
      args.waitTimeoutMs = Number.parseInt(next(), 10);
    } else if (arg === "--poll-interval-ms") {
      args.pollIntervalMs = Number.parseInt(next(), 10);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(args.allowlistWindow) || args.allowlistWindow < 1) {
    throw new Error("--allowlist-window must be a positive integer");
  }
  if (args.serviceNames.length === 0) {
    throw new Error("--services must include at least one service name");
  }
  if (!Number.isInteger(args.waitTimeoutMs) || args.waitTimeoutMs < 1) {
    throw new Error("--wait-timeout-ms must be a positive integer");
  }
  if (!Number.isInteger(args.pollIntervalMs) || args.pollIntervalMs < 1) {
    throw new Error("--poll-interval-ms must be a positive integer");
  }
  if (args.wait && !args.deploy) {
    throw new Error("--wait requires deploys; remove --no-deploy");
  }
  assertOwnerRepo(args.actionRepo, "--action-repo");
  return args;
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
    const data = parseJsonResponse(text);
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

  async listServicesByName(names) {
    const requested = new Set(names);
    const services = new Map();
    for (const item of await this.list("/services")) {
      const service = item.service ?? item;
      if (service?.name && requested.has(service.name)) {
        services.set(service.name, service);
      }
    }
    const missing = names.filter((name) => !services.has(name));
    if (missing.length > 0) {
      throw new Error(`Render service(s) not found: ${missing.join(", ")}`);
    }
    return names.map((name) => services.get(name));
  }

  async getEnvVar(serviceId, key) {
    try {
      const data = await this.request(
        "GET",
        `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
      );
      return envVarValue(data);
    } catch (error) {
      if (String(error.message).includes(" failed 404:")) {
        return "";
      }
      throw error;
    }
  }

  async setEnvVar(serviceId, key, value) {
    await this.request(
      "PUT",
      `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
      { value },
    );
  }

  async triggerDeploy(serviceId) {
    return await this.request("POST", `/services/${serviceId}/deploys`, {
      clearCache: "do_not_clear",
    });
  }

  async getDeploy(serviceId, deployId) {
    return await this.request(
      "GET",
      `/services/${serviceId}/deploys/${deployId}`,
    );
  }
}

function parseJsonResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function envVarValue(data) {
  if (!data) return "";
  const value =
    data.value ??
    data.envVar?.value ??
    data.envVarValue?.value ??
    data.envVar?.envVarValue?.value;
  return typeof value === "string" ? value.trim() : "";
}

async function resolveActionRef(input) {
  if (input.actionRef) {
    return normalizeHostedActionRef(input.actionRef, "--action-ref");
  }
  return normalizeHostedActionRef(`${input.actionRepo}@${input.branch}`, "git");
}

function normalizeActionOwnerRepo(actionRef) {
  const ownerRepo = actionRef.split("@", 1)[0];
  if (!ownerRepo) {
    throw new Error("action ref must be owner/repo@ref");
  }
  return ownerRepo;
}

function assertSameActionRepository(actionRef, expectedOwnerRepo) {
  const ownerRepo = normalizeActionOwnerRepo(actionRef);
  if (ownerRepo !== expectedOwnerRepo) {
    throw new Error(
      `Ref ${actionRef} does not use the same action repository as ${expectedOwnerRepo}`,
    );
  }
}

function buildTrustedRefs(input) {
  const candidates = [
    input.nextActionRef,
    ...(input.extraAllowedActionRefs ?? []),
    ...input.currentActionRefs,
    ...input.currentAllowedActionRefs.flatMap((value) =>
      value.split(/[\s,]+/).filter(Boolean),
    ),
  ]
    .filter((actionRef) => isFullShaActionRef(actionRef))
    .map((actionRef) =>
      normalizeFullShaActionRef(actionRef, "REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    );
  const ownerRepo = normalizeActionOwnerRepo(input.nextActionRef);
  const unique = [];
  for (const actionRef of candidates) {
    assertSameActionRepository(actionRef, ownerRepo);
    if (!unique.includes(actionRef)) {
      unique.push(actionRef);
    }
  }
  return unique.slice(0, input.allowlistWindow);
}

function normalizeFullShaActionRef(actionRef, source) {
  const normalized = String(actionRef ?? "")
    .trim()
    .toLowerCase();
  if (!isFullShaActionRef(normalized)) {
    throw new Error(`${source} must be owner/repo@40-character-sha`);
  }
  return normalized;
}

function normalizeHostedActionRef(actionRef, source) {
  const normalized = String(actionRef ?? "")
    .trim()
    .toLowerCase();
  if (!isHostedActionRef(normalized)) {
    throw new Error(
      `${source} must be owner/repo@main, owner/repo@v1, owner/repo@v1.x.y, or owner/repo@40-character-sha`,
    );
  }
  return normalized;
}

function isHostedActionRef(actionRef) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+@(main|v1|v1\.[0-9]+\.[0-9]+|[a-f0-9]{40})$/.test(
    String(actionRef ?? "")
      .trim()
      .toLowerCase(),
  );
}

function isFullShaActionRef(actionRef) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/.test(
    String(actionRef ?? "")
      .trim()
      .toLowerCase(),
  );
}

function assertOwnerRepo(ownerRepo, source) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    throw new Error(`${source} must be owner/repo`);
  }
}

function describePlan(plan) {
  return {
    actionRef: plan.nextActionRef,
    allowedActionRefs: plan.allowedActionRefs.join(","),
    services: plan.services.map((service) => service.name),
    deploy: plan.deploy,
    wait: plan.wait,
    dryRun: plan.dryRun,
  };
}

function allowedActionRefsEnvValue(allowedActionRefs) {
  const value = allowedActionRefs.join(",");
  return value ? value : null;
}

function deployId(data) {
  const id = data?.id ?? data?.deploy?.id;
  return typeof id === "string" && id ? id : "";
}

function deployStatus(data) {
  const status = data?.status ?? data?.deploy?.status;
  return typeof status === "string" && status ? status : "unknown";
}

function isTerminalFailedDeployStatus(status) {
  return (
    status === "build_failed" ||
    status === "update_failed" ||
    status === "pre_deploy_failed" ||
    status === "canceled" ||
    status === "deactivated" ||
    status === "failed" ||
    status.endsWith("_failed")
  );
}

async function waitForDeploys(client, deploys, input) {
  const deadline = Date.now() + input.waitTimeoutMs;
  const lastStatuses = new Map();
  while (Date.now() < deadline) {
    let liveCount = 0;
    for (const deploy of deploys) {
      const data = await client.getDeploy(deploy.service.id, deploy.id);
      const status = deployStatus(data);
      const statusKey = `${deploy.service.name}:${deploy.id}`;
      if (lastStatuses.get(statusKey) !== status) {
        lastStatuses.set(statusKey, status);
        console.log(`deploy ${deploy.service.name} ${deploy.id}: ${status}`);
      }
      if (status === "live") {
        liveCount += 1;
      } else if (isTerminalFailedDeployStatus(status)) {
        throw new Error(
          `Deploy ${deploy.id} for ${deploy.service.name} finished with ${status}`,
        );
      }
    }
    if (liveCount === deploys.length) return;
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
  throw new Error(
    `Timed out waiting for ${deploys.length} Render deploy(s) to become live`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nextActionRef = await resolveActionRef(args);
  const client = new RenderClient(readRenderApiKey());
  const services = await client.listServicesByName(args.serviceNames);
  const currentActionRefs = [];
  const currentAllowedActionRefs = [];
  for (const service of services) {
    currentActionRefs.push(
      await client.getEnvVar(service.id, "REVIEW_ROUTER_ACTION_REF"),
    );
    currentAllowedActionRefs.push(
      await client.getEnvVar(service.id, "REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    );
  }
  const allowedActionRefs = buildTrustedRefs({
    nextActionRef,
    currentActionRefs: currentActionRefs.filter(Boolean),
    currentAllowedActionRefs: currentAllowedActionRefs.filter(Boolean),
    extraAllowedActionRefs: args.extraAllowedActionRefs,
    allowlistWindow: args.allowlistWindow,
  });
  const plan = {
    nextActionRef,
    allowedActionRefs,
    services,
    deploy: args.deploy,
    wait: args.wait,
    dryRun: args.dryRun,
  };
  console.log(JSON.stringify(describePlan(plan), null, 2));
  if (args.dryRun) {
    return;
  }
  const deploys = [];
  for (const service of services) {
    console.log(`updating ${service.name}`);
    const allowedActionRefsValue = allowedActionRefsEnvValue(allowedActionRefs);
    await client.setEnvVar(
      service.id,
      "REVIEW_ROUTER_ACTION_REF",
      nextActionRef,
    );
    if (allowedActionRefsValue) {
      await client.setEnvVar(
        service.id,
        "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
        allowedActionRefsValue,
      );
    } else {
      console.log(
        `skipping REVIEW_ROUTER_ALLOWED_ACTION_REFS for ${service.name}: no full-SHA refs to allowlist`,
      );
    }
    if (args.deploy) {
      const deploy = await client.triggerDeploy(service.id);
      const id = deployId(deploy);
      if (args.wait && !id) {
        throw new Error(
          `Render did not return a deploy id for ${service.name}`,
        );
      }
      if (id) deploys.push({ service, id });
      console.log(`deploy requested for ${service.name}: ${id || "unknown"}`);
    }
  }
  if (args.wait && deploys.length > 0) {
    await waitForDeploys(client, deploys, args);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export {
  allowedActionRefsEnvValue,
  buildTrustedRefs,
  describePlan,
  isFullShaActionRef,
  isHostedActionRef,
  parseArgs,
  resolveActionRef,
  waitForDeploys,
};
