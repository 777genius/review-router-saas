#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import {
  RenderPrivateRunnerAdapter,
  RenderProviderFreezeAdapter,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`release_rollout_control_missing:${name}`);
  return value;
};
const mode = process.argv[2];
const apiKey = required("RENDER_API_KEY");
const output = (values: Record<string, string>) => {
  const path = required("GITHUB_OUTPUT");
  for (const [key, value] of Object.entries(values))
    appendFileSync(path, `${key}=${value}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
};

if (mode === "freeze") {
  const receipt = await new RenderProviderFreezeAdapter().freezeAndObserve({
    apiKey,
    ownerId: required("RENDER_OWNER_ID"),
    serviceIds: required("REVIEW_ROUTER_RENDER_FROZEN_SERVICE_IDS").split(","),
  });
  output({
    receipt: Buffer.from(JSON.stringify(receipt)).toString("base64url"),
  });
} else if (mode === "provision") {
  const runId = required("GITHUB_RUN_ID");
  const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
  const sha = required("REVIEW_ROUTER_EXPECTED_SHA");
  const label = `rr-${runId}-${runAttempt}-${sha.slice(0, 12)}-${required("REVIEW_ROUTER_RUNNER_PURPOSE")}`;
  const result = await new RenderPrivateRunnerAdapter().provision({
    apiKey,
    ownerId: required("RENDER_OWNER_ID"),
    repository: required("GITHUB_REPOSITORY"),
    runId,
    runAttempt,
    commitSha: sha,
    jitLabel: label,
    baseServiceId: required("REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID"),
    baseDeployId: required("REVIEW_ROUTER_RUNNER_BASE_DEPLOY_ID"),
    imageDigest: required("REVIEW_ROUTER_RUNNER_BASE_IMAGE_DIGEST"),
  });
  output({
    label,
    job_id: result.jobId,
    identity: Buffer.from(JSON.stringify(result.identity)).toString(
      "base64url",
    ),
    receipt: Buffer.from(JSON.stringify(result.receipt)).toString("base64url"),
  });
} else if (mode === "cleanup") {
  const receipt = await new RenderPrivateRunnerAdapter().cleanup({
    apiKey,
    baseServiceId: required("REVIEW_ROUTER_RUNNER_BASE_SERVICE_ID"),
    jobId: required("REVIEW_ROUTER_RUNNER_JOB_ID"),
  });
  output({
    receipt: Buffer.from(JSON.stringify(receipt)).toString("base64url"),
  });
} else {
  throw new Error("release_rollout_control_mode_invalid");
}
