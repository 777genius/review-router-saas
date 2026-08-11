import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const canonicalProviderJson = (value) => JSON.stringify(sortJson(value));

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function required(value, message) {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function exactHttpsBase(value, expectedHost, message) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(message);
  }
  return url;
}

async function getJson(fetchImpl, url, headers, message) {
  const response = await fetchImpl(url, { headers, method: "GET" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${message}: HTTP ${response.status}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${message}: response is not JSON`);
  }
  return {
    value,
    raw: Object.freeze({
      url: String(url),
      status: response.status,
      bodySha256: sha256(Buffer.from(canonicalProviderJson(value))),
      body: value,
    }),
  };
}

export async function captureRenderProvenance(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const base = exactHttpsBase(
    configuration.apiBase ?? "https://api.render.com/",
    "api.render.com",
    "Render API base must be https://api.render.com",
  );
  const token = required(configuration.token, "Render API token is required");
  const ownerId = required(
    configuration.ownerId,
    "Render owner ID is required",
  );
  const databaseId = required(
    configuration.databaseId,
    "Render database ID is required",
  );
  const migration = configuration.migration ?? {};
  const services = configuration.services ?? [];
  if (!Array.isArray(services) || services.length !== 3) {
    throw new Error(
      "exactly three Render runtime service identities are required",
    );
  }
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  const request = (path, message) =>
    getJson(fetchImpl, new URL(path, base), headers, message);
  const identity = await request(
    `v1/owners/${encodeURIComponent(ownerId)}`,
    "Render owner capture failed",
  );
  const database = await request(
    `v1/postgres/${encodeURIComponent(databaseId)}`,
    "Render database capture failed",
  );
  const migrationService = await request(
    `v1/services/${encodeURIComponent(required(migration.serviceId, "Render migration service ID is required"))}`,
    "Render migration service capture failed",
  );
  const migrationDeploy = await request(
    `v1/services/${encodeURIComponent(migration.serviceId)}/deploys/${encodeURIComponent(required(migration.deployId, "Render migration deploy ID is required"))}`,
    "Render migration deploy capture failed",
  );
  const migrationJob = await request(
    `v1/services/${encodeURIComponent(migration.serviceId)}/jobs/${encodeURIComponent(required(migration.jobId, "Render migration job ID is required"))}`,
    "Render migration job capture failed",
  );
  const migrationJobs = await request(
    `v1/services/${encodeURIComponent(migration.serviceId)}/jobs?limit=100`,
    "Render migration job inventory capture failed",
  );
  const witnessEnv = await request(
    `v1/services/${encodeURIComponent(required(configuration.witnessServiceId, "Render witness service ID is required"))}/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS`,
    "Render runtime witness capture failed",
  );
  const serviceFacts = [];
  const serviceRaw = [];
  for (const expected of services) {
    const service = await request(
      `v1/services/${encodeURIComponent(required(expected.serviceId, "Render runtime service ID is required"))}`,
      "Render runtime service capture failed",
    );
    const deploy = await request(
      `v1/services/${encodeURIComponent(expected.serviceId)}/deploys/${encodeURIComponent(required(expected.deployId, "Render runtime deploy ID is required"))}`,
      "Render runtime deploy capture failed",
    );
    const admission = await request(
      `v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_MUTATION_ADMISSION`,
      "Render mutation-admission capture failed",
    );
    serviceRaw.push(service.raw, deploy.raw, admission.raw);
    const preDeployCommand =
      service.value.serviceDetails?.preDeployCommand ??
      service.value.preDeployCommand ??
      null;
    serviceFacts.push({
      role: expected.role,
      name: service.value.name,
      serviceId: service.value.id,
      deployId: deploy.value.id,
      commit: deploy.value.commit?.id ?? deploy.value.commitId,
      imageDigest: deploy.value.image?.digest ?? deploy.value.imageDigest,
      status: deploy.value.status,
      rotatingMutationAdmission: admission.value?.value,
      preDeployCommand,
      serviceMigrationCallerEnabled: preDeployCommand !== null,
      observedAt: deploy.value.updatedAt ?? deploy.value.createdAt,
    });
  }
  const witnessValue = witnessEnv.value?.value;
  required(witnessValue, "Render runtime witness is empty");
  const witnessSha256 = sha256(Buffer.from(witnessValue));
  const witnessRaw = {
    ...witnessEnv.raw,
    body: {
      key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      valueSha256: witnessSha256,
    },
  };
  witnessRaw.bodySha256 = sha256(
    Buffer.from(canonicalProviderJson(witnessRaw.body)),
  );
  const rawResponses = [
    identity.raw,
    database.raw,
    migrationService.raw,
    migrationDeploy.raw,
    migrationJob.raw,
    migrationJobs.raw,
    witnessRaw,
    ...serviceRaw,
  ];
  const observedAt = new Date().toISOString();
  return {
    observationVersion: 2,
    source: "render-api",
    captureIdentity: {
      ownerId: identity.value.id,
      ownerName: identity.value.name,
      apiHost: base.hostname,
      authenticated: identity.value.id === ownerId,
      observedAt,
      rawResponsesSha256: sha256(
        Buffer.from(canonicalProviderJson(rawResponses)),
      ),
    },
    rawResponses,
    database: {
      id: database.value.id,
      name: database.value.name,
      version: String(database.value.version),
      ownerId: database.value.ownerId ?? database.value.owner?.id,
    },
    migrationCallers: (Array.isArray(migrationJobs.value)
      ? migrationJobs.value.map((entry) => entry.job ?? entry)
      : (migrationJobs.value?.jobs ?? [])
    )
      .filter((entry) => {
        const command = entry.startCommand ?? entry.command;
        const entryDeployId = entry.deployId ?? entry.deploy?.id;
        return (
          entry.status === "succeeded" &&
          command === "pnpm codex-rotating:release-migration" &&
          entryDeployId === migration.deployId
        );
      })
      .map((entry) => ({
        name: migrationService.value.name,
        role: "release-migration",
        serviceId: migrationService.value.id,
        deployId: migrationDeploy.value.id,
        jobId: entry.id,
        commit:
          migrationDeploy.value.commit?.id ?? migrationDeploy.value.commitId,
        imageDigest:
          migrationDeploy.value.image?.digest ??
          migrationDeploy.value.imageDigest,
        status: entry.status,
        observedAt: entry.finishedAt ?? entry.updatedAt,
      })),
    services: serviceFacts,
    runtimeWitness: {
      serviceId: configuration.witnessServiceId,
      key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      sha256: witnessSha256,
      sourceResponseSha256: witnessRaw.bodySha256,
    },
  };
}

export async function captureRenderMigrationProvenance(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const base = exactHttpsBase(
    configuration.apiBase ?? "https://api.render.com/",
    "api.render.com",
    "Render API base must be https://api.render.com",
  );
  const ownerId = required(
    configuration.ownerId,
    "Render owner ID is required",
  );
  const databaseId = required(
    configuration.databaseId,
    "Render database ID is required",
  );
  const serviceId = required(
    configuration.serviceId,
    "Render migration service ID is required",
  );
  const deployId = required(
    configuration.deployId,
    "Render migration deploy ID is required",
  );
  const jobId = required(
    configuration.jobId,
    "Render migration job ID is required",
  );
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${required(configuration.token, "Render API token is required")}`,
  };
  const request = (path, message) =>
    getJson(fetchImpl, new URL(path, base), headers, message);
  const [owner, database, service, deploy, job] = await Promise.all([
    request(
      `v1/owners/${encodeURIComponent(ownerId)}`,
      "Render owner capture failed",
    ),
    request(
      `v1/postgres/${encodeURIComponent(databaseId)}`,
      "Render database capture failed",
    ),
    request(
      `v1/services/${encodeURIComponent(serviceId)}`,
      "Render migration service capture failed",
    ),
    request(
      `v1/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
      "Render migration deploy capture failed",
    ),
    request(
      `v1/services/${encodeURIComponent(serviceId)}/jobs/${encodeURIComponent(jobId)}`,
      "Render migration job capture failed",
    ),
  ]);
  const logUrl = new URL("v1/logs", base);
  logUrl.searchParams.set("ownerId", ownerId);
  logUrl.searchParams.set("resource", serviceId);
  logUrl.searchParams.set("instance", jobId);
  logUrl.searchParams.set("type", "app");
  const jobs = await request(
    `v1/services/${encodeURIComponent(serviceId)}/jobs?limit=100`,
    "Render migration job inventory capture failed",
  );
  const inventory = Array.isArray(jobs.value)
    ? jobs.value.map((entry) => entry.job ?? entry)
    : (jobs.value?.jobs ?? []);
  const matchingCallers = inventory.filter((entry) => {
    const entryCommand = entry.startCommand ?? entry.command;
    const entryDeployId = entry.deployId ?? entry.deploy?.id;
    return (
      entry.status === "succeeded" &&
      entryCommand === "pnpm codex-rotating:release-migration" &&
      entryDeployId === deployId
    );
  });
  const logs = await getJson(
    fetchImpl,
    logUrl,
    headers,
    "Render migration output capture failed",
  );
  const logEntries = Array.isArray(logs.value) ? logs.value : logs.value?.logs;
  const migrationOutputs = (logEntries ?? []).flatMap((entry) => {
    const message = entry.message ?? entry.text ?? "";
    try {
      const value = JSON.parse(message);
      return value?.caller ===
        "scripts/run-codex-rotating-release-migration.mjs"
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  if (migrationOutputs.length !== 1)
    throw new Error(
      "Render logs do not contain exactly one canonical migration output",
    );
  const rawResponses = [
    owner.raw,
    database.raw,
    service.raw,
    deploy.raw,
    job.raw,
    jobs.raw,
    logs.raw,
  ];
  const command =
    job.value.startCommand ??
    job.value.command ??
    service.value.serviceDetails?.startCommand ??
    service.value.startCommand;
  return {
    observationVersion: 3,
    source: "render-api",
    captureIdentity: {
      ownerId: owner.value.id,
      apiHost: base.hostname,
      observedAt: new Date().toISOString(),
      rawResponsesSha256: sha256(
        Buffer.from(canonicalProviderJson(rawResponses)),
      ),
    },
    rawResponses,
    database: {
      id: database.value.id,
      name: database.value.name,
      version: String(database.value.version),
      ownerId: database.value.ownerId ?? database.value.owner?.id,
    },
    migrationCaller: {
      callerCount: matchingCallers.length,
      serviceId: service.value.id,
      deployId: deploy.value.id,
      jobId: job.value.id,
      commit: deploy.value.commit?.id ?? deploy.value.commitId,
      imageDigest: deploy.value.image?.digest ?? deploy.value.imageDigest,
      status: job.value.status,
      command,
      observedAt: job.value.finishedAt ?? job.value.updatedAt,
    },
    migrationOutput: migrationOutputs[0],
  };
}

function nextLink(response) {
  const link = response.headers.get("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/u);
  return match?.[1] ?? null;
}

async function githubPages(fetchImpl, initialUrl, headers) {
  const pages = [];
  let url = String(initialUrl);
  const visited = new Set();
  while (url) {
    if (visited.has(url)) throw new Error("GitHub pagination loop detected");
    visited.add(url);
    const response = await fetchImpl(url, { headers, method: "GET" });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `GitHub workflow capture failed: HTTP ${response.status}`,
      );
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("GitHub workflow response is not JSON");
    }
    const next = nextLink(response);
    pages.push({
      url,
      status: response.status,
      bodySha256: sha256(Buffer.from(canonicalProviderJson(body))),
      body,
      nextUrl: next,
    });
    url = next ?? "";
    if (
      !next &&
      Array.isArray(body.workflow_runs) &&
      body.workflow_runs.length === 100
    ) {
      throw new Error(
        "GitHub pagination ended without an authoritative final page",
      );
    }
  }
  return pages;
}

export async function captureGitHubWorkflowProvenance(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const base = exactHttpsBase(
    configuration.apiBase ?? "https://api.github.com/",
    "api.github.com",
    "GitHub API base must be https://api.github.com",
  );
  const token = required(configuration.token, "GitHub API token is required");
  const owner = required(
    configuration.owner,
    "GitHub repository owner is required",
  );
  const repository = required(
    configuration.repository,
    "GitHub repository name is required",
  );
  const workflow = required(
    configuration.workflow,
    "GitHub workflow identity is required",
  );
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const identity = await getJson(
    fetchImpl,
    new URL("user", base),
    headers,
    "GitHub capture identity failed",
  );
  const repositoryFact = await getJson(
    fetchImpl,
    new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      base,
    ),
    headers,
    "GitHub repository identity failed",
  );
  const rawPages = [];
  for (const status of ["queued", "in_progress"]) {
    const url = new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
      base,
    );
    url.searchParams.set("status", status);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", "1");
    rawPages.push(...(await githubPages(fetchImpl, url, headers)));
  }
  const runs = rawPages
    .flatMap((page) => page.body.workflow_runs ?? [])
    .map((run) => ({
      runId: String(run.id),
      status: run.status,
      workflowPath: run.path,
      headSha: run.head_sha,
      event: run.event,
      repositoryId: String(run.repository?.id ?? repositoryFact.value.id),
    }));
  const deduplicated = [
    ...new Map(runs.map((run) => [run.runId, run])).values(),
  ].sort((left, right) => left.runId.localeCompare(right.runId));
  const workflowFacts = [];
  for (const run of deduplicated) {
    const path = run.workflowPath.replace(/^\.github\/workflows\//u, "");
    const content = await getJson(
      fetchImpl,
      new URL(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/.github/workflows/${encodeURIComponent(path)}?ref=${encodeURIComponent(run.headSha)}`,
        base,
      ),
      headers,
      "GitHub workflow source capture failed",
    );
    const decoded = Buffer.from(content.value.content ?? "", "base64").toString(
      "utf8",
    );
    const marker = decoded.match(
      /(?:^|\n)\s*workflow_schema_version:\s*["']?([0-9]+)["']?\s*(?:\n|$)/u,
    );
    const workflowSchemaVersion = Number(marker?.[1]);
    if (![1, 2, 3, 4].includes(workflowSchemaVersion)) {
      throw new Error(
        "GitHub workflow source has an unsupported or absent schema marker",
      );
    }
    rawPages.push(content.raw);
    workflowFacts.push({
      ...run,
      workflowSchemaVersion,
      workflowBlobSha: content.value.sha,
    });
  }
  const observedAt = new Date().toISOString();
  return {
    observationVersion: 2,
    source: "github-actions-api",
    captureIdentity: {
      actorId: String(identity.value.id),
      actorLogin: identity.value.login,
      apiHost: base.hostname,
      authenticated: true,
      observedAt,
      rawResponsesSha256: sha256(
        Buffer.from(
          canonicalProviderJson([
            identity.raw,
            repositoryFact.raw,
            ...rawPages,
          ]),
        ),
      ),
    },
    cohort: {
      repositoryId: String(repositoryFact.value.id),
      repositoryFullName: repositoryFact.value.full_name,
      workflow,
      statuses: ["queued", "in_progress"],
      perPage: 100,
    },
    rawResponses: [identity.raw, repositoryFact.raw, ...rawPages],
    runs: workflowFacts,
  };
}

export async function captureGitHubWorkflowDrainProvenance(
  configuration,
  {
    fetchImpl = globalThis.fetch,
    intervalMs = 60_000,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000) {
    throw new Error("GitHub drain capture interval must be at least 15000ms");
  }
  const first = await captureGitHubWorkflowProvenance(configuration, fetchImpl);
  await sleep(intervalMs);
  const second = await captureGitHubWorkflowProvenance(
    configuration,
    fetchImpl,
  );
  if (
    canonicalProviderJson(first.cohort) !== canonicalProviderJson(second.cohort)
  ) {
    throw new Error(
      "GitHub drain captures do not describe the same exact cohort",
    );
  }
  const rawResponses = [...first.rawResponses, ...second.rawResponses];
  return {
    observationVersion: 2,
    source: "github-actions-api",
    supportedWorkflowSchemaVersions: [1, 2, 3, 4],
    captureIdentity: {
      ...second.captureIdentity,
      rawResponsesSha256: sha256(
        Buffer.from(canonicalProviderJson(rawResponses)),
      ),
    },
    cohort: first.cohort,
    rawResponses,
    observations: [first, second].map((sample) => ({
      captureIdentity: sample.captureIdentity,
      cohort: sample.cohort,
      rawResponses: sample.rawResponses,
      observedAt: sample.captureIdentity.observedAt,
      inventoriedWorkflowSchemaVersions: [1, 2, 3, 4],
      runs: sample.runs,
    })),
  };
}

export async function main(env = process.env, stdout = process.stdout) {
  let observation;
  if (env.REVIEW_ROUTER_PROVENANCE_PROVIDER === "render-migration") {
    observation = await captureRenderMigrationProvenance({
      token: env.RENDER_API_KEY,
      ownerId: env.REVIEW_ROUTER_RENDER_OWNER_ID,
      databaseId: env.REVIEW_ROUTER_RENDER_DATABASE_ID,
      serviceId: env.REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID,
      deployId: env.REVIEW_ROUTER_RENDER_MIGRATION_DEPLOY_ID,
      jobId: env.REVIEW_ROUTER_RENDER_MIGRATION_JOB_ID,
    });
  } else if (env.REVIEW_ROUTER_PROVENANCE_PROVIDER === "render") {
    observation = await captureRenderProvenance({
      token: env.RENDER_API_KEY,
      ownerId: env.REVIEW_ROUTER_RENDER_OWNER_ID,
      databaseId: env.REVIEW_ROUTER_RENDER_DATABASE_ID,
      migration: {
        serviceId: env.REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID,
        deployId: env.REVIEW_ROUTER_RENDER_MIGRATION_DEPLOY_ID,
        jobId: env.REVIEW_ROUTER_RENDER_MIGRATION_JOB_ID,
      },
      witnessServiceId: env.REVIEW_ROUTER_RENDER_WITNESS_SERVICE_ID,
      services: ["api", "web", "worker"].map((role) => ({
        role,
        serviceId: env[`REVIEW_ROUTER_RENDER_${role.toUpperCase()}_SERVICE_ID`],
        deployId: env[`REVIEW_ROUTER_RENDER_${role.toUpperCase()}_DEPLOY_ID`],
      })),
    });
  } else if (env.REVIEW_ROUTER_PROVENANCE_PROVIDER === "github") {
    const repository = required(
      env.REVIEW_ROUTER_GITHUB_REPOSITORY,
      "GitHub repository full name is required",
    ).split("/");
    if (repository.length !== 2 || repository.some((part) => !part)) {
      throw new Error("GitHub repository full name must be owner/name");
    }
    observation = await captureGitHubWorkflowDrainProvenance(
      {
        token: env.GITHUB_TOKEN,
        owner: repository[0],
        repository: repository[1],
        workflow: env.REVIEW_ROUTER_GITHUB_WORKFLOW,
      },
      {
        intervalMs: Number(
          env.REVIEW_ROUTER_DRAIN_OBSERVATION_INTERVAL_MS ?? 60_000,
        ),
      },
    );
  } else {
    throw new Error(
      "REVIEW_ROUTER_PROVENANCE_PROVIDER must be render, render-migration, or github",
    );
  }
  stdout.write(`${JSON.stringify(observation)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "provider provenance capture failed"}\n`,
    );
    process.exitCode = 1;
  }
}
