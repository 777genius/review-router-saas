#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalActivationSql,
  canonicalDatabaseGenerationObservationSql,
  resolveReleaseMigrationConfiguration,
} from "./run-codex-rotating-release-migration.mjs";
import {
  decomposePostgresConnection,
  RedactedProcessCommandAdapter,
} from "../packages/features/release-rollout/src/index.ts";

const required = (env, name) => {
  const value = env[name];
  if (!value)
    throw new Error(`release_activation_required_environment:${name}`);
  return value;
};

export function executePrivateGenerationActivation(
  env = process.env,
  commands = new RedactedProcessCommandAdapter(),
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
  const runPsql = (step, args, options = {}) => {
    const connection = decomposePostgresConnection(configuration.releaseUrl);
    try {
      return commands.execute("psql", [...connection.args, ...args], {
        env: connection.env,
        input: options.input,
      }).stdout;
    } catch {
      throw new Error(`release_activation_step_failed:${step}`);
    } finally {
      connection.cleanup();
    }
  };
  const generation = JSON.parse(
    runPsql("activation_target_generation", [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      canonicalDatabaseGenerationObservationSql(),
    ]).trim(),
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
  const output = runPsql(
    "transactional_activation",
    ["--no-psqlrc", "--tuples-only", "--no-align"],
    { input: activation.sql },
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
    !/^sha256:[a-f0-9]{64}$/u.test(observed?.catalogFactsSha256 ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(observed?.firstWriteReceiptSha256 ?? "") ||
    observed?.firstWriteBoundary !== true ||
    !/^[0-9]+$/u.test(observed?.transactionId ?? "")
  )
    throw new Error("release_activation_receipt_unproven");
  return {
    step: "activate_target_generation",
    observedAt: observed.activatedAt,
    facts: {
      rolloutId,
      sourceSystemIdentifier,
      targetSystemIdentifier,
      canonicalPrivilegesSha256: activation.canonicalPrivilegesSha256,
      catalogFactsSha256: observed.catalogFactsSha256,
      firstWriteReceiptSha256: observed.firstWriteReceiptSha256,
      transactionId: observed.transactionId,
      firstWriteBoundary: true,
      observationSha256: `sha256:${createHash("sha256").update(JSON.stringify(observed)).digest("hex")}`,
    },
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
