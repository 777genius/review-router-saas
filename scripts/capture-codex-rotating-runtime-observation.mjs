#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const kinds = {
  canary: ["/internal/rollout/codex-rotating/canary", "canary-runtime"],
  compatibility: ["/internal/rollout/codex-rotating/compatibility", null],
  events: ["/internal/rollout/codex-rotating/events", "operator-command-log"],
};

function required(env, name) {
  const value = env[name];
  if (!value)
    throw new Error(`runtime_observation_required_environment:${name}`);
  return value;
}

export async function captureRuntimeObservation(
  env,
  fetchImpl = globalThis.fetch,
) {
  const kind = required(env, "REVIEW_ROUTER_RUNTIME_OBSERVATION_KIND");
  const contract = kinds[kind];
  if (!contract) throw new Error("runtime_observation_kind_invalid");
  const base = new URL(
    required(env, "REVIEW_ROUTER_RUNTIME_OBSERVATION_ORIGIN"),
  );
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("runtime_observation_origin_invalid");
  const url = new URL(contract[0], base);
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${required(env, "REVIEW_ROUTER_RUNTIME_OBSERVATION_TOKEN")}`,
      "X-ReviewRouter-Rollout-Id": required(
        env,
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID",
      ),
    },
  });
  if (!response.ok)
    throw new Error(`runtime_observation_request_failed:${response.status}`);
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("runtime_observation_response_invalid_json");
  }
  if (
    value?.rolloutId !== env.REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID ||
    (contract[1] && value?.source !== contract[1])
  )
    throw new Error("runtime_observation_response_identity_mismatch");
  delete value.rolloutId;
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await captureRuntimeObservation(process.env))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "runtime_observation_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
