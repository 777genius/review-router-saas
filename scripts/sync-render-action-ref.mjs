/* global fetch */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
  --action-ref owner/repo@40-char-sha  Use an explicit trusted action ref.
  --action-repo owner/repo             Resolve refs/heads/main from this action repo. Default: ${defaultActionRepository}
  --branch name                        Branch to resolve when --action-ref is omitted. Default: ${defaultBranch}
  --services a,b,c                     Render service names. Default: ${defaultServiceNames.join(",")}
  --allowlist-window n                 Keep n trusted refs including the new ref. Default: 2
  --no-deploy                          Update env vars without triggering Render deploys.
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
    deploy: true,
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
    } else if (arg === "--no-deploy") {
      args.deploy = false;
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
    return normalizeFullShaActionRef(input.actionRef, "--action-ref");
  }
  const { stdout } = await execFileAsync("git", [
    "ls-remote",
    `https://github.com/${input.actionRepo}.git`,
    `refs/heads/${input.branch}`,
  ]);
  const sha = stdout.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(
      `Could not resolve ${input.actionRepo} refs/heads/${input.branch}`,
    );
  }
  return normalizeFullShaActionRef(`${input.actionRepo}@${sha}`, "git");
}

function buildTrustedRefs(input) {
  const candidates = [
    input.nextActionRef,
    ...input.currentActionRefs,
    ...input.currentAllowedActionRefs.flatMap((value) =>
      value.split(/[\s,]+/).filter(Boolean),
    ),
  ].map((actionRef) =>
    normalizeFullShaActionRef(actionRef, "REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
  );
  const ownerRepo = input.nextActionRef.split("@", 1)[0];
  const unique = [];
  for (const actionRef of candidates) {
    if (actionRef.split("@", 1)[0] !== ownerRepo) {
      throw new Error(
        `Ref ${actionRef} does not use the same action repository as ${input.nextActionRef}`,
      );
    }
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
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${source} must be owner/repo@40-character-sha`);
  }
  return normalized;
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
    dryRun: plan.dryRun,
  };
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
    allowlistWindow: args.allowlistWindow,
  });
  const plan = {
    nextActionRef,
    allowedActionRefs,
    services,
    deploy: args.deploy,
    dryRun: args.dryRun,
  };
  console.log(JSON.stringify(describePlan(plan), null, 2));
  if (args.dryRun) {
    return;
  }
  for (const service of services) {
    console.log(`updating ${service.name}`);
    await client.setEnvVar(
      service.id,
      "REVIEW_ROUTER_ACTION_REF",
      nextActionRef,
    );
    await client.setEnvVar(
      service.id,
      "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
      allowedActionRefs.join(","),
    );
    if (args.deploy) {
      const deploy = await client.triggerDeploy(service.id);
      console.log(
        `deploy requested for ${service.name}: ${deploy.id ?? deploy.deploy?.id ?? "unknown"}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
