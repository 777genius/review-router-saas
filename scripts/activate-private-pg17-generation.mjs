#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalActivationSql,
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

const forbiddenCutoverAuthorityEnvironment = Object.freeze([
  "REVIEW_ROUTER_ACTIVATION_FENCE_JSON",
  "REVIEW_ROUTER_ACTIVATION_PERMIT_JSON",
  "REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL",
  "REVIEW_ROUTER_ACTIVATION_RECEIPT_GUARD_DATABASE_URL",
]);

export function executePrivateGenerationActivation(
  env = process.env,
  commands = new RedactedProcessCommandAdapter(),
) {
  for (const name of forbiddenCutoverAuthorityEnvironment) {
    if (env[name] !== undefined)
      throw new Error(
        `release_activation_authority_environment_forbidden:${name}`,
      );
  }
  const configuration = resolveReleaseMigrationConfiguration(env);
  const rolloutId = required(env, "REVIEW_ROUTER_ROLLOUT_ID");
  const activation = canonicalActivationSql(configuration, { rolloutId });
  const connection = decomposePostgresConnection(configuration.releaseUrl);
  let output;
  try {
    output = commands.execute(
      "psql",
      [...connection.args, "--no-psqlrc", "--tuples-only", "--no-align"],
      { env: connection.env, input: activation.sql },
    ).stdout;
  } catch (error) {
    throw new Error("release_activation_step_failed:transactional_activation", {
      cause: error,
    });
  } finally {
    connection.cleanup();
  }
  const observed = JSON.parse(
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{")) ?? "null",
  );
  if (
    observed?.rolloutId !== rolloutId ||
    !/^sha256:[a-f0-9]{64}$/u.test(observed?.canonicalPrivilegesSha256 ?? "") ||
    !/^[0-9]+$/u.test(observed?.sourceSystemIdentifier ?? "") ||
    !/^[0-9]+$/u.test(observed?.targetSystemIdentifier ?? "") ||
    observed?.sourceSystemIdentifier === observed?.targetSystemIdentifier ||
    !/^[a-f0-9]{40}$/u.test(observed?.expectedCommitSha ?? "") ||
    observed?.postgresMajor !== 17 ||
    !/^sha256:[a-f0-9]{64}$/u.test(observed?.migrationChecksum ?? "") ||
    !Array.isArray(observed?.targetDeployIds) ||
    observed.targetDeployIds.length < 1 ||
    !Number.isSafeInteger(observed?.permitEpoch) ||
    observed.permitEpoch < 1 ||
    !/^[a-f0-9]{32}$/u.test(observed?.permitNonce ?? "") ||
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
      ...observed,
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
