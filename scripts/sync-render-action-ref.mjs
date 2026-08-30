/* global fetch */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveCodexRotatingInstallerDescriptor } from "../packages/shared/src/validation/codex-rotating-installer-descriptor.mjs";
import {
  ForkReviewV5RolloutAuthority,
  assertExactRenderScope,
  observedRenderScope,
  verifyControlPlaneScope,
} from "./deploy-render-hosted-beta.mjs";

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
  --services a,b,c                     Render service names. Default: ${defaultServiceNames.join(",")}. Rotation phases require this exact set.
  --allowlist-window n                 Keep n trusted refs including the new ref. Default: 2
  --rotation-phase stage|promote|retire
                                       Run a fail-closed exact-SHA rotation. Stage trusts B everywhere without changing A;
                                       promote re-stages B everywhere before changing primaries; retire removes A explicitly.
  --retire-action-ref owner/repo@sha   Old exact ref to remove. Required only with --rotation-phase retire.
  --extra-allowed-action-ref ref        Keep an additional full-SHA action ref in the allowlist. Can be repeated or comma-separated.
  --release-tag vN.N.N                  Published immutable SaaS/Action release that cryptographically binds B's installer and dist.
  --operation-id id                     Durable, unique operator rotation id. May use REVIEW_ROUTER_ACTION_REF_ROTATION_ID.
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
    rotationPhase: "",
    retireActionRef: "",
    releaseTag: "",
    operationId: process.env.REVIEW_ROUTER_ACTION_REF_ROTATION_ID ?? "",
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
    } else if (arg === "--rotation-phase") {
      args.rotationPhase = next();
    } else if (arg === "--retire-action-ref") {
      args.retireActionRef = normalizeFullShaActionRef(
        next(),
        "--retire-action-ref",
      );
    } else if (arg === "--release-tag") {
      args.releaseTag = next();
    } else if (arg === "--operation-id") {
      args.operationId = next();
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
  if (
    args.rotationPhase &&
    !["stage", "promote", "retire"].includes(args.rotationPhase)
  ) {
    throw new Error("--rotation-phase must be stage, promote, or retire");
  }
  if (args.rotationPhase) {
    if (!args.actionRef) {
      throw new Error("--rotation-phase requires an explicit --action-ref");
    }
    if (!args.deploy) {
      throw new Error(
        "--rotation-phase requires deploys so cross-service trust can be proven live",
      );
    }
    assertExactRotationCohort(args.serviceNames);
    if (!/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(args.releaseTag)) {
      throw new Error("--rotation-phase requires --release-tag vN.N.N");
    }
    args.wait = true;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u.test(args.operationId)) {
      throw new Error("--rotation-phase requires a durable --operation-id");
    }
  }
  if (args.rotationPhase === "retire" && !args.retireActionRef) {
    throw new Error(
      "--rotation-phase retire requires --retire-action-ref owner/repo@40-character-sha",
    );
  }
  if (
    args.rotationPhase === "retire" &&
    args.extraAllowedActionRefs.includes(args.retireActionRef)
  ) {
    throw new Error("--retire-action-ref cannot also be an extra allowed ref");
  }
  if (args.rotationPhase !== "retire" && args.retireActionRef) {
    throw new Error(
      "--retire-action-ref is valid only with --rotation-phase retire",
    );
  }
  assertOwnerRepo(args.actionRepo, "--action-repo");
  return args;
}

function assertExactRotationCohort(serviceNames) {
  const actual = [...serviceNames].sort();
  const expected = [...defaultServiceNames].sort();
  if (
    actual.length !== expected.length ||
    actual.some((serviceName, index) => serviceName !== expected[index])
  ) {
    throw new Error(
      `--rotation-phase requires the exact production cohort: ${defaultServiceNames.join(",")}`,
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

function requiredRotationScope(source = process.env) {
  const read = (name) => {
    const value = String(source[name] ?? "").trim();
    if (!value) throw new Error(`${name} is required for Action ref rotation`);
    return value;
  };
  return Object.freeze({
    ownerId: read("RENDER_OWNER_ID"),
    projectId: read("RENDER_PROJECT_ID"),
    environmentId: read("RENDER_ENVIRONMENT_ID"),
  });
}

function resolveExactRotationServices(items, names, scope) {
  const requested = new Set(names);
  const services = new Map(names.map((name) => [name, []]));
  for (const item of items) {
    const service = item.service ?? item;
    if (!service?.name || !requested.has(service.name)) continue;
    try {
      const observed = observedRenderScope(service);
      if (
        ["ownerId", "projectId", "environmentId"].some(
          (key) => observed[key] !== scope[key],
        )
      ) {
        throw new Error("scope mismatch");
      }
      services
        .get(service.name)
        .push(
          assertExactRenderScope(service, scope, `service ${service.name}`),
        );
    } catch {
      // Same-name resources outside the exact environment are ineligible.
    }
  }
  const invalid = names.filter((name) => services.get(name).length !== 1);
  if (invalid.length > 0) {
    throw new Error(
      `Render service scope missing or ambiguous: ${invalid.join(", ")}`,
    );
  }
  return names.map((name) => services.get(name)[0]);
}

function rotationAuthority(source = process.env) {
  return new ForkReviewV5RolloutAuthority(
    String(source.REVIEW_ROUTER_PROVIDER_AUTHORITY_URL ?? ""),
    String(source.REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN ?? ""),
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
      signal: globalThis.AbortSignal.timeout(30_000),
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

  async listServicesByName(names, scope) {
    const resolved = resolveExactRotationServices(
      await this.list(`/services?ownerId=${encodeURIComponent(scope.ownerId)}`),
      names,
      scope,
    );
    for (const service of resolved) {
      const detail = await this.request("GET", `/services/${service.id}`);
      const observed = observedRenderScope(detail);
      if (
        ["ownerId", "projectId", "environmentId"].some(
          (key) => observed[key] !== scope[key],
        )
      ) {
        throw new Error(`Render service ${service.name} exact scope mismatch`);
      }
      assertExactRenderScope(detail, scope, `service ${service.name}`);
    }
    return resolved;
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
  if (unique.length > input.allowlistWindow) {
    throw new Error(
      `Action ref trust needs ${unique.length} refs but --allowlist-window is ${input.allowlistWindow}; refusing to evict an existing ref`,
    );
  }
  return unique;
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

function assertSafeActionRefSelection(actionRef, rotationPhase) {
  if (isFullShaActionRef(actionRef) && !rotationPhase) {
    throw new Error(
      "Immutable Action refs must use --rotation-phase stage, promote, or retire; one-pass A -> B sync is unsafe",
    );
  }
}

function assertOwnerRepo(ownerRepo, source) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    throw new Error(`${source} must be owner/repo`);
  }
}

function describePlan(plan) {
  return {
    actionRef: plan.nextActionRef,
    allowedActionRefs: (plan.allowedActionRefs ?? []).join(","),
    rotatingActionRef: plan.rotatingActionRef ?? null,
    rotatingAllowedActionRefs: (plan.rotatingAllowedActionRefs ?? []).join(","),
    rotatingInstallerVersion: plan.installerDescriptor?.version ?? null,
    rotatingInstallerUrl: plan.installerDescriptor?.url ?? null,
    hostedActionTag: plan.hostedRelease?.tag ?? null,
    hostedActionSha: plan.hostedRelease?.sha ?? null,
    hostedActionDistSha256: plan.hostedRelease?.distSha256 ?? null,
    services: plan.services.map((service) => service.name),
    deploy: plan.deploy,
    wait: plan.wait,
    dryRun: plan.dryRun,
    rotationPhase: plan.rotationPhase || null,
    retireActionRef: plan.retireActionRef || null,
  };
}

const actionRefKeys = {
  primary: "REVIEW_ROUTER_ACTION_REF",
  allowed: "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
  rotatingPrimary: "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
  rotatingAllowed: "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
  installerUrl: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
  installerVersion: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
  installerSha256: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
  hostedTag: "REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG",
  hostedSha: "REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA",
  hostedDistSha256: "REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256",
};

function splitAllowedRefs(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((ref) => ref.trim().toLowerCase())
    .filter(Boolean);
}

function boundedRefWindow(refs, ownerRepo, limit) {
  const unique = [];
  for (const ref of refs) {
    if (!isFullShaActionRef(ref)) continue;
    const normalized = normalizeFullShaActionRef(ref, "Action ref overlap");
    assertSameActionRepository(normalized, ownerRepo);
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  if (unique.length > limit) {
    throw new Error(
      `The requested rotation needs ${unique.length} trusted refs but --allowlist-window is ${limit}; increase the window instead of pruning a live ref`,
    );
  }
  return unique;
}

function rotationOverlapUpdates(state, input) {
  const ownerRepo = normalizeActionOwnerRepo(input.nextActionRef);
  const cohortStates = input.cohortStates ?? [state];
  const common = [
    input.nextActionRef,
    ...(input.requiredOldRefs ?? []),
    ...(input.extraAllowedActionRefs ?? []),
  ];
  const general = boundedRefWindow(
    [
      ...common,
      ...cohortStates.flatMap((candidate) => [
        candidate.actionRef,
        ...splitAllowedRefs(candidate.allowedActionRefs),
      ]),
    ],
    ownerRepo,
    input.allowlistWindow,
  );
  const rotating = boundedRefWindow(
    [
      ...common,
      ...cohortStates.flatMap((candidate) => [
        candidate.rotatingActionRef,
        ...splitAllowedRefs(candidate.rotatingAllowedActionRefs),
      ]),
    ],
    ownerRepo,
    input.allowlistWindow,
  );
  return [
    { key: actionRefKeys.allowed, value: general.join(",") },
    { key: actionRefKeys.rotatingAllowed, value: rotating.join(",") },
  ];
}

function rotationPromoteUpdates(state, input) {
  return [
    ...rotationOverlapUpdates(state, input),
    { key: actionRefKeys.primary, value: input.nextActionRef },
    { key: actionRefKeys.rotatingPrimary, value: input.nextActionRef },
    {
      key: actionRefKeys.installerUrl,
      value: input.installerDescriptor.url,
    },
    {
      key: actionRefKeys.installerVersion,
      value: input.installerDescriptor.version,
    },
    {
      key: actionRefKeys.installerSha256,
      value: input.installerDescriptor.sha256,
    },
    { key: actionRefKeys.hostedTag, value: input.hostedRelease.tag },
    { key: actionRefKeys.hostedSha, value: input.hostedRelease.sha },
    {
      key: actionRefKeys.hostedDistSha256,
      value: input.hostedRelease.distSha256,
    },
  ];
}

function stateMatchesRelease(state, input) {
  return (
    state.actionRef === input.nextActionRef &&
    state.rotatingActionRef === input.nextActionRef &&
    state.installerUrl === input.installerDescriptor.url &&
    state.installerVersion === input.installerDescriptor.version &&
    state.installerSha256 === input.installerDescriptor.sha256 &&
    state.hostedTag === input.hostedRelease.tag &&
    state.hostedSha === input.hostedRelease.sha &&
    state.hostedDistSha256 === input.hostedRelease.distSha256
  );
}

function rotationRetireUpdates(state, input) {
  const ownerRepo = normalizeActionOwnerRepo(input.nextActionRef);
  const withoutRetired = (value) =>
    boundedRefWindow(
      [
        input.nextActionRef,
        ...(input.extraAllowedActionRefs ?? []),
        ...splitAllowedRefs(value).filter(
          (ref) => ref !== input.retireActionRef,
        ),
      ],
      ownerRepo,
      input.allowlistWindow,
    ).join(",");
  return [
    {
      key: actionRefKeys.allowed,
      value: withoutRetired(state.allowedActionRefs),
    },
    {
      key: actionRefKeys.rotatingAllowed,
      value: withoutRetired(state.rotatingAllowedActionRefs),
    },
  ];
}

function buildTrustedRefWindows(input) {
  const allowedActionRefs = buildTrustedRefs({
    nextActionRef: input.nextActionRef,
    currentActionRefs: input.currentActionRefs,
    currentAllowedActionRefs: input.currentAllowedActionRefs,
    extraAllowedActionRefs: input.extraAllowedActionRefs,
    allowlistWindow: input.allowlistWindow,
  });
  const syncRotatingRef = isFullShaActionRef(input.nextActionRef);
  const rotatingAllowedActionRefs = syncRotatingRef
    ? buildTrustedRefs({
        nextActionRef: input.nextActionRef,
        currentActionRefs: input.currentRotatingActionRefs,
        currentAllowedActionRefs: input.currentRotatingAllowedActionRefs,
        extraAllowedActionRefs: input.extraAllowedActionRefs,
        allowlistWindow: input.allowlistWindow,
      })
    : [];
  return {
    allowedActionRefs,
    rotatingActionRef: syncRotatingRef ? input.nextActionRef : null,
    rotatingAllowedActionRefs,
  };
}

function actionRefEnvUpdates(plan) {
  const updates = [
    { key: "REVIEW_ROUTER_ACTION_REF", value: plan.nextActionRef },
  ];
  const allowedActionRefsValue = allowedActionRefsEnvValue(
    plan.allowedActionRefs,
  );
  if (allowedActionRefsValue) {
    updates.push({
      key: "REVIEW_ROUTER_ALLOWED_ACTION_REFS",
      value: allowedActionRefsValue,
    });
  }
  if (plan.rotatingActionRef) {
    updates.push({
      key: "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
      value: plan.rotatingActionRef,
    });
    const rotatingAllowedActionRefsValue = allowedActionRefsEnvValue(
      plan.rotatingAllowedActionRefs,
    );
    if (rotatingAllowedActionRefsValue) {
      updates.push({
        key: "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
        value: rotatingAllowedActionRefsValue,
      });
    }
    if (plan.installerDescriptor) {
      updates.push(
        {
          key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
          value: plan.installerDescriptor.url,
        },
        {
          key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
          value: plan.installerDescriptor.version,
        },
        {
          key: "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
          value: plan.installerDescriptor.sha256,
        },
      );
    }
  }
  return updates;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} fields are not canonical`);
  }
}

function parseVerifiedActionReleaseDescriptor(input) {
  let descriptor;
  try {
    descriptor = JSON.parse(Buffer.from(input.bytes).toString("utf8"));
  } catch {
    throw new Error("verified Action release descriptor is not valid JSON");
  }
  assertExactKeys(
    descriptor,
    [
      "schemaVersion",
      "url",
      "version",
      "sha256",
      "actionRef",
      "actionRelease",
      "reseed",
    ],
    "verified Action release descriptor",
  );
  assertExactKeys(
    descriptor.actionRelease,
    ["tag", "sha", "distSha256"],
    "verified hosted Action release tuple",
  );
  assertExactKeys(
    descriptor.reseed,
    ["url", "sha256"],
    "verified rotating reseed descriptor",
  );
  const expectedRef = normalizeFullShaActionRef(
    input.nextActionRef,
    "Action release ref",
  );
  const repository = normalizeActionOwnerRepo(expectedRef);
  const expectedSha = expectedRef.slice(expectedRef.lastIndexOf("@") + 1);
  if (
    descriptor.schemaVersion !==
      "reviewrouter.codex-rotating-action-release-descriptor.v2" ||
    descriptor.version !== input.releaseTag ||
    descriptor.actionRef !== expectedRef ||
    descriptor.actionRelease.tag !== input.releaseTag ||
    descriptor.actionRelease.sha !== expectedSha ||
    descriptor.actionRelease.sha !== input.observedActionTagSha ||
    descriptor.actionRelease.distSha256 !== input.observedDistSha256 ||
    !/^[a-f0-9]{64}$/u.test(descriptor.actionRelease.distSha256)
  ) {
    throw new Error("verified hosted Action release tuple mismatch");
  }
  const expectedSeedUrl = `https://raw.githubusercontent.com/${repository}/${expectedSha}/scripts/seed-codex-rotating-auth.sh`;
  const expectedReseedUrl = `https://raw.githubusercontent.com/${repository}/${expectedSha}/scripts/reseed-codex-rotating-auth.sh`;
  if (
    descriptor.url !== expectedSeedUrl ||
    descriptor.reseed.url !== expectedReseedUrl ||
    descriptor.sha256 !== input.observedSeedSha256 ||
    descriptor.reseed.sha256 !== input.observedReseedSha256
  ) {
    throw new Error("verified rotating installer release tuple mismatch");
  }
  const installerDescriptor = resolveCodexRotatingInstallerDescriptor({
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: expectedRef,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: descriptor.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: descriptor.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: descriptor.sha256,
  });
  return Object.freeze({
    installerDescriptor: Object.freeze(installerDescriptor),
    hostedRelease: Object.freeze({
      tag: descriptor.actionRelease.tag,
      sha: descriptor.actionRelease.sha,
      distSha256: descriptor.actionRelease.distSha256,
    }),
  });
}

function ghJson(endpoint) {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

const maxDescriptorBytes = 1024 * 1024;
const maxActionArtifactBytes = 32 * 1024 * 1024;

function ghBytes(endpoint, accept, maxBytes = maxActionArtifactBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("invalid GitHub artifact byte limit");
  }
  const bytes = execFileSync(
    "gh",
    ["api", endpoint, "-H", `Accept: ${accept}`],
    {
      encoding: "buffer",
      maxBuffer: maxBytes + 1,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (bytes.byteLength > maxBytes) {
    throw new Error(`GitHub artifact exceeds bounded ${maxBytes}-byte limit`);
  }
  return bytes;
}

function loadVerifiedActionRelease(
  input,
  github = { json: ghJson, bytes: ghBytes },
) {
  const encodedTag = encodeURIComponent(input.releaseTag);
  const release = github.json(
    `repos/777genius/review-router-saas/releases/tags/${encodedTag}`,
  );
  if (
    release.draft ||
    release.prerelease ||
    release.tag_name !== input.releaseTag
  ) {
    throw new Error(
      "Action release descriptor must come from a published exact release",
    );
  }
  const matchingAssets = (release.assets ?? []).filter(
    (asset) =>
      asset.name === "reviewrouter-codex-rotating-installer-descriptor.json",
  );
  if (matchingAssets.length !== 1 || !matchingAssets[0]?.id) {
    throw new Error(
      "published Action release descriptor asset is missing or ambiguous",
    );
  }
  const descriptorBytes = github.bytes(
    `repos/777genius/review-router-saas/releases/assets/${matchingAssets[0].id}`,
    "application/octet-stream",
    maxDescriptorBytes,
  );
  const tagCommit = github.json(
    `repos/777genius/review-router/commits/${encodedTag}`,
  );
  const actionSha = input.nextActionRef.slice(
    input.nextActionRef.lastIndexOf("@") + 1,
  );
  if (tagCommit.sha !== actionSha) {
    throw new Error("published Action tag does not resolve to requested B SHA");
  }
  const raw = (pathName) =>
    github.bytes(
      `repos/777genius/review-router/contents/${pathName}?ref=${actionSha}`,
      "application/vnd.github.raw+json",
      maxActionArtifactBytes,
    );
  return parseVerifiedActionReleaseDescriptor({
    bytes: descriptorBytes,
    nextActionRef: input.nextActionRef,
    releaseTag: input.releaseTag,
    observedActionTagSha: tagCommit.sha,
    // Hosted workers execute the public Action bundle. The SaaS runtime's
    // action-dist/index.cjs is a distinct artifact and cannot attest this tuple.
    observedDistSha256: sha256(raw("dist/index.js")),
    observedSeedSha256: sha256(raw("scripts/seed-codex-rotating-auth.sh")),
    observedReseedSha256: sha256(raw("scripts/reseed-codex-rotating-auth.sh")),
  });
}

function readInstallerDescriptor(input) {
  if (!input.path) {
    if (isFullShaActionRef(input.nextActionRef)) {
      throw new Error(
        "--installer-descriptor is required when syncing an immutable Action ref",
      );
    }
    return null;
  }
  const descriptor = JSON.parse(fs.readFileSync(input.path, "utf8"));
  if (
    descriptor?.schemaVersion !==
      "reviewrouter.codex-rotating-installer-descriptor.v1" ||
    String(descriptor.actionRef ?? "").toLowerCase() !== input.nextActionRef
  ) {
    throw new Error("installer descriptor does not match the Action ref");
  }
  return resolveCodexRotatingInstallerDescriptor({
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: input.nextActionRef,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: descriptor.url,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: descriptor.version,
    REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: descriptor.sha256,
  });
}

function allowedActionRefsEnvValue(allowedActionRefs) {
  const value = allowedActionRefs.join(",");
  return value ? value : null;
}

function parseAllowedActionRefs(value) {
  return String(value ?? "")
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
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

async function readRotationState(client, service) {
  const [
    actionRef,
    allowedActionRefs,
    rotatingActionRef,
    rotatingAllowedActionRefs,
    installerUrl,
    installerVersion,
    installerSha256,
    hostedTag,
    hostedSha,
    hostedDistSha256,
  ] = await Promise.all([
    client.getEnvVar(service.id, actionRefKeys.primary),
    client.getEnvVar(service.id, actionRefKeys.allowed),
    client.getEnvVar(service.id, actionRefKeys.rotatingPrimary),
    client.getEnvVar(service.id, actionRefKeys.rotatingAllowed),
    client.getEnvVar(service.id, actionRefKeys.installerUrl),
    client.getEnvVar(service.id, actionRefKeys.installerVersion),
    client.getEnvVar(service.id, actionRefKeys.installerSha256),
    client.getEnvVar(service.id, actionRefKeys.hostedTag),
    client.getEnvVar(service.id, actionRefKeys.hostedSha),
    client.getEnvVar(service.id, actionRefKeys.hostedDistSha256),
  ]);
  return {
    service,
    actionRef,
    allowedActionRefs,
    rotatingActionRef,
    rotatingAllowedActionRefs,
    installerUrl,
    installerVersion,
    installerSha256,
    hostedTag,
    hostedSha,
    hostedDistSha256,
  };
}

const rotationStateFields = Object.freeze([
  ["actionRef", actionRefKeys.primary],
  ["allowedActionRefs", actionRefKeys.allowed],
  ["rotatingActionRef", actionRefKeys.rotatingPrimary],
  ["rotatingAllowedActionRefs", actionRefKeys.rotatingAllowed],
  ["installerUrl", actionRefKeys.installerUrl],
  ["installerVersion", actionRefKeys.installerVersion],
  ["installerSha256", actionRefKeys.installerSha256],
  ["hostedTag", actionRefKeys.hostedTag],
  ["hostedSha", actionRefKeys.hostedSha],
  ["hostedDistSha256", actionRefKeys.hostedDistSha256],
]);

function rotationStateUpdates(state) {
  return rotationStateFields.map(([field, key]) => ({
    key,
    value: state[field],
  }));
}

function sameRotationState(left, right) {
  return rotationStateFields.every(([field]) => left[field] === right[field]);
}

function applyStateUpdates(state, updates) {
  const next = { ...state };
  for (const update of updates) {
    const tuple = rotationStateFields.find(([, key]) => key === update.key);
    if (!tuple) throw new Error(`unsupported rotation env key: ${update.key}`);
    next[tuple[0]] = update.value;
  }
  return next;
}

function cohortFingerprint(entries) {
  return sha256(
    Buffer.from(
      JSON.stringify(
        entries
          .map(({ service, state }) => ({
            id: service.id,
            state: rotationStateUpdates(state),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ),
    ),
  );
}

async function verifyEnvUpdates(client, service, updates) {
  for (const update of updates) {
    const actual = await client.getEnvVar(service.id, update.key);
    if (actual !== update.value) {
      throw new Error(
        `Render env verification failed for ${service.name}:${update.key}`,
      );
    }
  }
}

async function deployCohortAndVerify(
  client,
  services,
  updatesByService,
  input,
) {
  const deploys = [];
  for (const service of services) {
    const deploy = await client.triggerDeploy(service.id);
    const id = deployId(deploy);
    if (!id) {
      throw new Error(`Render did not return a deploy id for ${service.name}`);
    }
    deploys.push({ service, id });
    console.log(`deploy requested for ${service.name}: ${id}`);
  }
  await waitForDeploys(client, deploys, input);
  for (const service of services) {
    await verifyEnvUpdates(client, service, updatesByService.get(service.id));
  }
}

async function markAmbiguousAndThrow(authority, claim, entries, error) {
  let fingerprint = "unreadable";
  try {
    const observed = [];
    for (const entry of entries) {
      observed.push({
        service: entry.service,
        state: await readRotationState(entry.client, entry.service),
      });
    }
    fingerprint = cohortFingerprint(observed);
  } catch {
    // A failed observation is itself ambiguous and must not trigger rollback.
  }
  await authority.markRecoveryRequired(claim, fingerprint);
  throw new Error(
    `Action ref rotation requires operator recovery: ${error.message}`,
  );
}

async function applyAuthorizedRotation(
  client,
  entries,
  input,
  authority,
  claim,
) {
  const recoveryEntries = entries.map((entry) => ({ ...entry, client }));
  try {
    for (const entry of entries) {
      const before = await readRotationState(client, entry.service);
      if (!sameRotationState(before, entry.original)) {
        throw new Error(
          `Render env changed after authority claim for ${entry.service.name}`,
        );
      }
      for (const [field, key] of rotationStateFields) {
        if (entry.original[field] === entry.desired[field]) continue;
        await client.setEnvVar(entry.service.id, key, entry.desired[field]);
        const observed = await client.getEnvVar(entry.service.id, key);
        if (observed !== entry.desired[field]) {
          throw new Error(
            `Render env write was not observable for ${entry.service.name}:${key}`,
          );
        }
      }
      const after = await readRotationState(client, entry.service);
      if (!sameRotationState(after, entry.desired)) {
        throw new Error(
          `Render env tuple did not converge for ${entry.service.name}`,
        );
      }
    }
    await deployCohortAndVerify(
      client,
      entries.map((entry) => entry.service),
      new Map(
        entries.map((entry) => [
          entry.service.id,
          rotationStateUpdates(entry.desired),
        ]),
      ),
      input,
    );
    const finalEntries = [];
    for (const entry of entries) {
      const state = await readRotationState(client, entry.service);
      if (!sameRotationState(state, entry.desired)) {
        throw new Error(
          `Render env drifted after deploy for ${entry.service.name}`,
        );
      }
      finalEntries.push({ service: entry.service, state });
    }
    await authority.complete(claim, cohortFingerprint(finalEntries));
  } catch (error) {
    await markAmbiguousAndThrow(authority, claim, recoveryEntries, error);
  }
}

async function executeRotationPhase(client, services, input) {
  if (!isFullShaActionRef(input.nextActionRef)) {
    throw new Error(
      "Action ref rotation requires an exact full-SHA Action ref",
    );
  }
  if (input.allowlistWindow < 2) {
    throw new Error(
      "Action ref rotation requires --allowlist-window of at least 2",
    );
  }
  const nextSha = input.nextActionRef.slice(
    input.nextActionRef.lastIndexOf("@") + 1,
  );
  if (
    input.hostedRelease?.sha !== nextSha ||
    input.hostedRelease?.tag !== input.installerDescriptor?.version ||
    !/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(input.hostedRelease?.tag ?? "") ||
    !/^[a-f0-9]{64}$/u.test(input.hostedRelease?.distSha256 ?? "")
  ) {
    throw new Error("verified hosted Action release metadata is required");
  }
  const overlapInput = {
    ...input,
    requiredOldRefs:
      input.rotationPhase === "retire" ? [input.retireActionRef] : [],
  };

  if (input.rotationPhase === "retire") {
    if (input.retireActionRef === input.nextActionRef) {
      throw new Error("Cannot retire the promoted Action ref");
    }
    if ((input.extraAllowedActionRefs ?? []).includes(input.retireActionRef)) {
      throw new Error(
        "retiring Action ref cannot remain in extra allowed refs",
      );
    }
    const states = await Promise.all(
      services.map((service) => readRotationState(client, service)),
    );
    const stale = states.filter((state) => !stateMatchesRelease(state, input));
    if (stale.length > 0) {
      throw new Error(
        `Cannot retire the old Action ref before every primary is promoted: ${stale
          .map((state) => state.service.name)
          .join(", ")}`,
      );
    }
  }

  const initial = [];
  for (const service of services)
    initial.push({ service, state: await readRotationState(client, service) });
  const cohortStates = initial.map((entry) => entry.state);
  if (input.rotationPhase !== "stage") {
    const missing = initial.filter(({ state }) => {
      const allowed = new Set(parseAllowedActionRefs(state.allowedActionRefs));
      const rotatingAllowed = new Set(
        parseAllowedActionRefs(state.rotatingAllowedActionRefs),
      );
      return (
        !allowed.has(input.nextActionRef) ||
        !rotatingAllowed.has(input.nextActionRef)
      );
    });
    if (missing.length > 0)
      throw new Error(
        "Stage must be completed across the exact cohort before promote or retire",
      );
  }
  const entries = initial.map(({ service, state }) => {
    const updates =
      input.rotationPhase === "stage"
        ? rotationOverlapUpdates(state, { ...overlapInput, cohortStates })
        : input.rotationPhase === "promote"
          ? rotationPromoteUpdates(state, { ...input, cohortStates })
          : rotationRetireUpdates(state, input);
    return {
      service,
      original: state,
      desired: applyStateUpdates(state, updates),
    };
  });
  // Final pre-claim reread is the optimistic fingerprint. Once the durable
  // claim exists, every uncertain provider result is recovery-only: never
  // rollback, retry, or report success from a transient observation.
  for (const entry of entries) {
    const current = await readRotationState(client, entry.service);
    if (!sameRotationState(current, entry.original))
      throw new Error(
        `Render env changed during preflight for ${entry.service.name}`,
      );
  }
  const authority = input.authority;
  if (!authority)
    throw new Error("durable provider mutation authority is required");
  const claim = await authority.acquireOperation({
    rolloutId: input.operationId,
    operation: `action-ref-rotation:${input.rotationPhase}:${input.releaseTag}`,
    resourceId: [
      "action-ref-rotation",
      input.scope.ownerId,
      input.scope.projectId,
      input.scope.environmentId,
      ...entries.map((entry) => entry.service.id).sort(),
    ].join(":"),
    ownerId: input.scope.ownerId,
    fingerprint: cohortFingerprint(initial),
    version: `${input.rotationPhase}:${input.releaseTag}`,
  });
  await applyAuthorizedRotation(client, entries, input, authority, claim);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nextActionRef = await resolveActionRef(args);
  assertSafeActionRefSelection(nextActionRef, args.rotationPhase);
  const verifiedRelease = args.rotationPhase
    ? loadVerifiedActionRelease({
        releaseTag: args.releaseTag,
        nextActionRef,
      })
    : null;
  const installerDescriptor = verifiedRelease?.installerDescriptor ?? null;
  const client = new RenderClient(readRenderApiKey());
  const scope = requiredRotationScope();
  await verifyControlPlaneScope(client, scope);
  const services = await client.listServicesByName(args.serviceNames, scope);
  if (args.rotationPhase) {
    const plan = {
      nextActionRef,
      releaseTag: args.releaseTag,
      operationId: args.operationId,
      scope,
      authority: args.dryRun ? null : rotationAuthority(),
      installerDescriptor,
      hostedRelease: verifiedRelease.hostedRelease,
      services,
      deploy: true,
      wait: true,
      dryRun: args.dryRun,
      rotationPhase: args.rotationPhase,
      retireActionRef: args.retireActionRef,
      allowlistWindow: args.allowlistWindow,
      extraAllowedActionRefs: args.extraAllowedActionRefs,
      waitTimeoutMs: args.waitTimeoutMs,
      pollIntervalMs: args.pollIntervalMs,
    };
    console.log(JSON.stringify(describePlan(plan), null, 2));
    if (!args.dryRun) {
      await executeRotationPhase(client, services, plan);
    }
    return;
  }
  const currentActionRefs = [];
  const currentAllowedActionRefs = [];
  const currentRotatingActionRefs = [];
  const currentRotatingAllowedActionRefs = [];
  for (const service of services) {
    currentActionRefs.push(
      await client.getEnvVar(service.id, "REVIEW_ROUTER_ACTION_REF"),
    );
    currentAllowedActionRefs.push(
      await client.getEnvVar(service.id, "REVIEW_ROUTER_ALLOWED_ACTION_REFS"),
    );
    currentRotatingActionRefs.push(
      await client.getEnvVar(
        service.id,
        "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
      ),
    );
    currentRotatingAllowedActionRefs.push(
      await client.getEnvVar(
        service.id,
        "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
      ),
    );
  }
  const trustedRefs = buildTrustedRefWindows({
    nextActionRef,
    currentActionRefs: currentActionRefs.filter(Boolean),
    currentAllowedActionRefs: currentAllowedActionRefs.filter(Boolean),
    currentRotatingActionRefs: currentRotatingActionRefs.filter(Boolean),
    currentRotatingAllowedActionRefs:
      currentRotatingAllowedActionRefs.filter(Boolean),
    extraAllowedActionRefs: args.extraAllowedActionRefs,
    allowlistWindow: args.allowlistWindow,
  });
  const plan = {
    nextActionRef,
    ...trustedRefs,
    installerDescriptor,
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
    const updates = actionRefEnvUpdates(plan);
    for (const update of updates) {
      await client.setEnvVar(service.id, update.key, update.value);
    }
    if (!allowedActionRefsEnvValue(plan.allowedActionRefs)) {
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
  actionRefEnvUpdates,
  allowedActionRefsEnvValue,
  assertSafeActionRefSelection,
  assertExactRotationCohort,
  buildTrustedRefs,
  buildTrustedRefWindows,
  describePlan,
  executeRotationPhase,
  isFullShaActionRef,
  isHostedActionRef,
  loadVerifiedActionRelease,
  parseArgs,
  parseVerifiedActionReleaseDescriptor,
  requiredRotationScope,
  resolveExactRotationServices,
  readInstallerDescriptor,
  rotationOverlapUpdates,
  rotationPromoteUpdates,
  rotationRetireUpdates,
  resolveActionRef,
  waitForDeploys,
};
