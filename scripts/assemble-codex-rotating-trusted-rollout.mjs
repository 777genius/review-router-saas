#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gitBlobSha } from "./lib/github-actions-trusted-evidence.mjs";

const workflowPath = ".github/workflows/codex-rotating-rollout-evidence.yml";
const artifacts = {
  database: [
    "database.json",
    "scripts/capture-codex-rotating-production-writer.mjs",
  ],
  deployments: [
    "deployments.json",
    "scripts/codex-rotating-provider-provenance.mjs",
  ],
  compatibilityProbe: [
    "compatibility-probe.json",
    "scripts/capture-codex-rotating-runtime-observation.mjs",
  ],
  events: ["events.json", null],
  canaryRuntime: ["canary-runtime.json", null],
  workflowRuns: [
    "workflow-runs.json",
    "scripts/codex-rotating-provider-provenance.mjs",
  ],
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`trusted_rollout_required_environment:${name}`);
  return value;
}

export function assembleTrustedRollout(env = process.env) {
  const directory = required(env, "REVIEW_ROUTER_ROLLOUT_ARTIFACT_DIRECTORY");
  const descriptors = {};
  for (const [name, [file, sourceFile]] of Object.entries(artifacts)) {
    const path = `artifacts/${file}`;
    const bytes = readFileSync(`${directory}/${path}`);
    JSON.parse(bytes.toString("utf8"));
    descriptors[name] = {
      path,
      sha256: digest(bytes),
      ...(sourceFile
        ? { sourceFile, sourceFileSha256: digest(readFileSync(sourceFile)) }
        : {}),
    };
  }
  const headSha = required(env, "GITHUB_SHA");
  return {
    version: 3,
    rolloutId: required(env, "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID"),
    execution: {
      repositoryId: required(env, "GITHUB_REPOSITORY_ID"),
      repositoryFullName: required(env, "GITHUB_REPOSITORY"),
      workflowPath,
      workflowSha: gitBlobSha(readFileSync(workflowPath)),
      workflowRef: headSha,
      runId: required(env, "GITHUB_RUN_ID"),
      runAttempt: Number(required(env, "GITHUB_RUN_ATTEMPT")),
      jobId: required(env, "REVIEW_ROUTER_GITHUB_JOB_ID"),
      jobName: "trusted-rollout-evidence",
      artifactName: required(
        env,
        "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME",
      ),
      headSha,
    },
    rollout: { version: 2, artifacts: descriptors },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(`${JSON.stringify(assembleTrustedRollout())}\n`);
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "trusted_rollout_assembly_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
