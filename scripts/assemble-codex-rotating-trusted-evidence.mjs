#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import { gitBlobSha } from "./lib/github-actions-trusted-evidence.mjs";

const workflowPath = ".github/workflows/codex-rotating-release-migration.yml";
const sha256 = (value) =>
  createHash("sha256")
    .update(Buffer.from(canonicalProviderJson(value)))
    .digest("hex");

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

export function assembleTrustedMigrationEvidence({
  env,
  databaseObservation,
  migrationOutput,
}) {
  const commit = required(env, "GITHUB_SHA");
  const runAttempt = Number(required(env, "GITHUB_RUN_ATTEMPT"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    throw new Error("trusted_evidence_invalid_run_attempt");
  if (
    databaseObservation?.observationVersion !== 4 ||
    databaseObservation?.source !== "render-api" ||
    migrationOutput?.version !== 3 ||
    migrationOutput?.caller !==
      "scripts/run-codex-rotating-release-migration.mjs" ||
    migrationOutput?.callerCount !== 1 ||
    migrationOutput?.status !== "succeeded"
  )
    throw new Error("trusted_evidence_producer_observation_missing");
  const scope = {
    ownerId: required(env, "RENDER_OWNER_ID"),
    projectId: required(env, "RENDER_PROJECT_ID"),
    environmentId: required(env, "RENDER_ENVIRONMENT_ID"),
  };
  const imageDigest = required(env, "REVIEW_ROUTER_RELEASE_IMAGE_DIGEST");
  const databaseIdentity = required(
    env,
    "REVIEW_ROUTER_RENDER_DATABASE_IDENTITY",
  );
  if (
    migrationOutput.commit !== commit ||
    migrationOutput.imageDigest !== imageDigest ||
    migrationOutput.databaseIdentity !== databaseIdentity ||
    !migrationOutput.databaseGeneration ||
    Object.keys(migrationOutput.databaseGeneration).length !== 2 ||
    typeof migrationOutput.databaseGeneration.systemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(
      migrationOutput.databaseGeneration.systemIdentifier ?? "",
    ) ||
    typeof migrationOutput.databaseGeneration.recoveryWitnessSha256 !==
      "string" ||
    !/^[a-f0-9]{64}$/u.test(
      migrationOutput.databaseGeneration.recoveryWitnessSha256 ?? "",
    )
  )
    throw new Error("trusted_evidence_migration_output_binding_mismatch");
  const roleByUsername = new Map(
    migrationOutput.roles.map((role) => [role.username, role]),
  );
  const roleNames = {
    api: "reviewrouter_api",
    web: "reviewrouter_web",
    worker: "reviewrouter_worker",
    codexEffectAuthority: "reviewrouter_codex_effect_authority",
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
      superuser: observed.superuser,
      createDatabase: observed.createDatabase,
      createRole: observed.createRole,
      replication: observed.replication,
      bypassRls: observed.bypassRls,
      canSetReleaseRole: observed.canSetReleaseRole,
    };
  });
  const artifactName = required(
    env,
    "REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME",
  );
  return {
    version: 5,
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
      id: databaseObservation.database.id,
      postgresMajorVersion: String(databaseObservation.database.version).split(
        ".",
      )[0],
      identity: databaseIdentity,
      observationSha256: sha256(databaseObservation),
    },
    databaseGeneration: migrationOutput.databaseGeneration,
    migration: {
      callerCount: migrationOutput.callerCount,
      status: migrationOutput.status,
      preflightStatus: migrationOutput.preflightStatus,
      migrationStatus: migrationOutput.migrationStatus,
      evidenceStatus: "verified",
      outputSha256: sha256(migrationOutput),
    },
    runtimeRoles,
    databaseObservation,
    migrationOutput,
  };
}

export function main(env = process.env, stdout = process.stdout) {
  const evidence = assembleTrustedMigrationEvidence({
    env,
    databaseObservation: readJson(
      required(env, "REVIEW_ROUTER_RENDER_DATABASE_OBSERVATION_FILE"),
      "database-observation",
    ),
    migrationOutput: readJson(
      required(env, "REVIEW_ROUTER_MIGRATION_OUTPUT_FILE"),
      "migration-output",
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
