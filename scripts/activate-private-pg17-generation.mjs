#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalActivationSql,
  canonicalDatabaseGenerationObservationSql,
  resolveReleaseMigrationConfiguration,
  runReleaseMigrationSubprocess,
} from "./run-codex-rotating-release-migration.mjs";

const required = (env, name) => {
  const value = env[name];
  if (!value)
    throw new Error(`release_activation_required_environment:${name}`);
  return value;
};

export function executePrivateGenerationActivation(
  env = process.env,
  run = runReleaseMigrationSubprocess,
) {
  const configuration = resolveReleaseMigrationConfiguration(env);
  const sourceSystemIdentifier = required(
    env,
    "REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER",
  );
  const targetSystemIdentifier = required(
    env,
    "REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER",
  );
  const rolloutId = required(env, "REVIEW_ROUTER_ROLLOUT_ID");
  const childEnv = { ...env, DATABASE_URL: configuration.releaseUrl };
  const generation = JSON.parse(
    run(
      "activation_target_generation",
      "psql",
      [
        configuration.releaseUrl,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        canonicalDatabaseGenerationObservationSql(),
      ],
      { env: childEnv },
    ).trim(),
  );
  if (
    generation.systemIdentifier !== targetSystemIdentifier ||
    generation.recoveryWitnessSha256 !==
      required(env, "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256")
  )
    throw new Error("release_activation_target_generation_mismatch");
  const activation = canonicalActivationSql(configuration, {
    rolloutId,
    sourceSystemIdentifier,
    targetSystemIdentifier,
  });
  const output = run(
    "transactional_activation",
    "psql",
    [configuration.releaseUrl, "--no-psqlrc", "--tuples-only", "--no-align"],
    { env: childEnv, input: activation.sql },
  );
  const observed = JSON.parse(
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{")) ?? "null",
  );
  if (
    observed?.rolloutId !== rolloutId ||
    observed?.sourceSystemIdentifier !== sourceSystemIdentifier ||
    observed?.targetSystemIdentifier !== targetSystemIdentifier ||
    observed?.canonicalPrivilegesSha256 !==
      activation.canonicalPrivilegesSha256 ||
    observed?.firstWriteBoundary !== true ||
    !/^[0-9]+$/u.test(observed?.transactionId ?? "")
  )
    throw new Error("release_activation_receipt_unproven");
  return {
    step: "activate_target_generation",
    receiptId: `activation-${rolloutId}`,
    observedAt: observed.activatedAt,
    payloadSha256: `sha256:${createHash("sha256")
      .update(JSON.stringify(observed))
      .digest("hex")}`,
    sourceSystemIdentifier,
    targetSystemIdentifier,
    canonicalPrivilegesSha256: activation.canonicalPrivilegesSha256,
    transactionId: observed.transactionId,
    firstWriteBoundary: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(executePrivateGenerationActivation())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "release_activation_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
