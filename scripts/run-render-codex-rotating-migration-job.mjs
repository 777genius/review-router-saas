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

export async function runRenderMigrationJob(
  env,
  {
    fetchImpl = globalThis.fetch,
    poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const serviceId = required(env, "REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID");
  const token = required(env, "RENDER_API_KEY");
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const releaseEnvironment = [
    "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
    "REVIEW_ROUTER_API_DATABASE_URL",
    "REVIEW_ROUTER_WEB_DATABASE_URL",
    "REVIEW_ROUTER_WORKER_DATABASE_URL",
    "REVIEW_ROUTER_RENDER_COMMIT_SHA",
    "REVIEW_ROUTER_RENDER_IMAGE_DIGEST",
  ].map((key) => ({ key, value: required(env, key) }));
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
        startCommand: "pnpm codex-rotating:release-migration",
        envVars: releaseEnvironment,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`render_migration_job_create_failed:${response.status}`);
  const created = await response.json();
  const jobId = created.id ?? created.job?.id;
  if (typeof jobId !== "string" || !jobId)
    throw new Error("render_migration_job_id_missing");
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
    if (observed.status === "succeeded")
      return { jobId, status: observed.status };
    if (terminalFailure.has(observed.status))
      throw new Error(
        `render_migration_job_terminal_failure:${observed.status}`,
      );
    await poll(10_000);
  }
  throw new Error("render_migration_job_observation_timeout");
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
