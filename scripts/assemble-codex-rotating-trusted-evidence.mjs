#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gitBlobSha } from "./lib/github-actions-trusted-evidence.mjs";

const workflowPath = ".github/workflows/codex-rotating-release-migration.yml";

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`trusted_evidence_required_environment:${name}`);
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`trusted_evidence_invalid_json:${label}`);
  }
}

export function assembleTrustedMigrationEvidence({ env, providerObservation }) {
  const commit = required(env, "GITHUB_SHA");
  const runAttempt = Number(required(env, "GITHUB_RUN_ATTEMPT"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    throw new Error("trusted_evidence_invalid_run_attempt");
  if (
    providerObservation?.observationVersion !== 3 ||
    providerObservation?.source !== "render-api" ||
    providerObservation?.migrationOutput?.caller !==
      "scripts/run-codex-rotating-release-migration.mjs"
  )
    throw new Error("trusted_evidence_producer_observation_missing");
  const migrationOutput = providerObservation.migrationOutput;
  const scope = {
    ownerId: required(env, "RENDER_OWNER_ID"),
    projectId: required(env, "RENDER_PROJECT_ID"),
    environmentId: required(env, "RENDER_ENVIRONMENT_ID"),
  };
  const imageDigest = required(env, "REVIEW_ROUTER_RENDER_IMAGE_DIGEST");
  const databaseIdentity = required(
    env,
    "REVIEW_ROUTER_RENDER_DATABASE_IDENTITY",
  );
  const jobId = providerObservation.migrationCaller?.jobId;
  if (
    migrationOutput.commit !== commit ||
    migrationOutput.imageDigest !== imageDigest ||
    migrationOutput.databaseIdentity !== databaseIdentity
  )
    throw new Error("trusted_evidence_migration_output_binding_mismatch");
  const roleByUsername = new Map(
    migrationOutput.roles.map((role) => [role.username, role]),
  );
  const roleNames = {
    api: "reviewrouter_api",
    web: "reviewrouter_web",
    worker: "reviewrouter_worker",
    releaseMigration: "reviewrouter_release_migration",
  };
  const runtimeRoles = Object.entries(roleNames).map(([role, username]) => {
    const observed = roleByUsername.get(username);
    if (!observed) throw new Error("trusted_evidence_runtime_role_missing");
    return {
      role,
      username,
      databaseIdentity,
      login: observed.login,
      canSetReleaseRole: observed.canSetReleaseRole,
    };
  });
  const artifactName = required(
    env,
    "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME",
  );
  return {
    version: 3,
    rolloutId: required(env, "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID"),
    execution: {
      repositoryId: required(env, "GITHUB_REPOSITORY_ID"),
      repositoryFullName: required(env, "GITHUB_REPOSITORY"),
      workflowPath,
      workflowSha: gitBlobSha(readFileSync(workflowPath)),
      workflowRef: commit,
      runId: required(env, "GITHUB_RUN_ID"),
      runAttempt,
      jobId: required(env, "REVIEW_ROUTER_GITHUB_JOB_ID"),
      jobName: "trusted-release-migration",
      artifactName,
      headSha: commit,
    },
    scope,
    release: { commit, imageDigest },
    database: {
      id: providerObservation.database.id,
      postgresMajorVersion: String(providerObservation.database.version).split(
        ".",
      )[0],
      identity: databaseIdentity,
    },
    exclusiveMigration: {
      jobId,
      callerCount: providerObservation.migrationCaller.callerCount,
      status: providerObservation.migrationCaller.status,
      preflightStatus: migrationOutput.preflightStatus,
      migrationStatus: migrationOutput.migrationStatus,
      evidenceStatus: "verified",
    },
    runtimeRoles,
    providerObservation,
    migrationOutput,
  };
}

export function main(env = process.env, stdout = process.stdout) {
  const evidence = assembleTrustedMigrationEvidence({
    env,
    providerObservation: readJson(
      required(env, "REVIEW_ROUTER_RENDER_PROVIDER_OBSERVATION_FILE"),
      "provider-observation",
    ),
  });
  stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "trusted_evidence_assembly_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
