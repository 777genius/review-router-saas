#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const api = "https://api.render.com/v1";
const terminalFailure = new Set([
  "canceled",
  "failed",
  "timed_out",
  "build_failed",
  "update_failed",
]);

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`render_migration_job_required_environment:${name}`);
  return value;
}

async function runExclusiveRenderJob(
  env,
  { environmentKeys, startCommand },
  {
    fetchImpl = globalThis.fetch,
    poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const serviceId = required(env, "REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID");
  const deployId = required(env, "REVIEW_ROUTER_RENDER_MIGRATION_DEPLOY_ID");
  const token = required(env, "RENDER_API_KEY");
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const releaseEnvironment = environmentKeys.map((key) => ({
    key,
    value: required(env, key),
  }));
  const expectedCommit = required(env, "REVIEW_ROUTER_RENDER_COMMIT_SHA");
  const expectedImageDigest = required(
    env,
    "REVIEW_ROUTER_RENDER_IMAGE_DIGEST",
  );
  const serviceResponse = await fetchImpl(
    `${api}/services/${encodeURIComponent(serviceId)}`,
    { method: "GET", headers },
  );
  if (!serviceResponse.ok)
    throw new Error(
      `render_migration_job_service_failed:${serviceResponse.status}`,
    );
  const serviceValue = await serviceResponse.json();
  const service = serviceValue.service ?? serviceValue;
  if (
    service.id !== serviceId ||
    (service.autoDeployTrigger ?? service.serviceDetails?.autoDeployTrigger) !==
      "off"
  )
    throw new Error("render_migration_job_service_not_immutable");
  const deployResponse = await fetchImpl(
    `${api}/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    { method: "GET", headers },
  );
  if (!deployResponse.ok)
    throw new Error(
      `render_migration_job_deploy_failed:${deployResponse.status}`,
    );
  const deployValue = await deployResponse.json();
  const deploy = deployValue.deploy ?? deployValue;
  if (
    deploy.id !== deployId ||
    deploy.status !== "live" ||
    (deploy.commit?.id ?? deploy.commitId) !== expectedCommit ||
    (deploy.image?.digest ?? deploy.imageDigest) !== expectedImageDigest
  )
    throw new Error("render_migration_job_deploy_identity_mismatch");
  const inventoryResponse = await fetchImpl(
    `${api}/services/${encodeURIComponent(serviceId)}/jobs?limit=100`,
    { method: "GET", headers },
  );
  if (!inventoryResponse.ok)
    throw new Error(
      `render_migration_job_inventory_failed:${inventoryResponse.status}`,
    );
  const inventoryValue = await inventoryResponse.json();
  const inventory = Array.isArray(inventoryValue)
    ? inventoryValue.map((entry) => entry.job ?? entry)
    : (inventoryValue.jobs ?? []);
  if (
    inventory.some((entry) =>
      ["pending", "queued", "running", "in_progress"].includes(entry.status),
    )
  )
    throw new Error("render_migration_job_exclusive_caller_already_active");
  const response = await fetchImpl(
    `${api}/services/${encodeURIComponent(serviceId)}/jobs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        startCommand,
        envVars: releaseEnvironment,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`render_migration_job_create_failed:${response.status}`);
  const created = await response.json();
  const createdJob = created.job ?? created;
  const jobId = createdJob.id;
  if (typeof jobId !== "string" || !jobId)
    throw new Error("render_migration_job_id_missing");
  if ((createdJob.deployId ?? createdJob.deploy?.id) !== deployId)
    throw new Error("render_migration_job_deploy_identity_mismatch");
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const observedResponse = await fetchImpl(
      `${api}/services/${encodeURIComponent(serviceId)}/jobs/${encodeURIComponent(jobId)}`,
      { method: "GET", headers },
    );
    if (!observedResponse.ok)
      throw new Error(
        `render_migration_job_observation_failed:${observedResponse.status}`,
      );
    const value = await observedResponse.json();
    const observed = value.job ?? value;
    if (observed.id !== jobId)
      throw new Error("render_migration_job_identity_mismatch");
    if ((observed.deployId ?? observed.deploy?.id) !== deployId)
      throw new Error("render_migration_job_deploy_identity_mismatch");
    if (observed.status === "succeeded")
      return { deployId, jobId, status: observed.status };
    if (terminalFailure.has(observed.status))
      throw new Error(
        `render_migration_job_terminal_failure:${observed.status}`,
      );
    await poll(10_000);
  }
  throw new Error("render_migration_job_observation_timeout");
}

const releaseEnvironmentKeys = [
  "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
  "REVIEW_ROUTER_API_DATABASE_URL",
  "REVIEW_ROUTER_WEB_DATABASE_URL",
  "REVIEW_ROUTER_WORKER_DATABASE_URL",
  "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
  "REVIEW_ROUTER_RENDER_COMMIT_SHA",
  "REVIEW_ROUTER_RENDER_IMAGE_DIGEST",
];

export function runRenderMigrationJob(env, dependencies) {
  return runExclusiveRenderJob(
    env,
    {
      environmentKeys: releaseEnvironmentKeys,
      startCommand: "pnpm codex-rotating:release-migration",
    },
    dependencies,
  );
}

export function runRenderRoleBootstrapJob(env, dependencies) {
  return runExclusiveRenderJob(
    env,
    {
      environmentKeys: [
        "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
        ...releaseEnvironmentKeys,
      ],
      startCommand: "pnpm codex-rotating:role-bootstrap",
    },
    dependencies,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runRenderMigrationJob(process.env))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "render_migration_job_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
