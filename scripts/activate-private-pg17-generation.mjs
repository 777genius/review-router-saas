#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalActivationSql,
  canonicalActivationRecoverySql,
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
const activationDigest = /^sha256:[a-f0-9]{64}$/u;
const activationIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const activationMatches = (value, pattern) =>
  typeof value === "string" && pattern.test(value);
const activationReceiptFields = new Set([
  "rolloutId",
  "sourceSystemIdentifier",
  "targetSystemIdentifier",
  "postgresMajor",
  "expectedCommitSha",
  "migrationChecksum",
  "targetDeployIds",
  "permitEpoch",
  "permitNonce",
  "canonicalPrivilegesSha256",
  "catalogFactsSha256",
  "preactivationCatalogPolicySha256",
  "activatedCatalogPolicySha256",
  "beforePrincipalInventorySha256",
  "beforePrincipalPolicySha256",
  "activatedPrincipalInventorySha256",
  "activatedPrincipalPolicySha256",
  "firstWriteReceiptSha256",
  "transactionId",
  "activatedAt",
  "firstWriteBoundary",
]);
const activationReceiptIsStructured = (observed, rolloutId) =>
  observed !== null &&
  typeof observed === "object" &&
  !Array.isArray(observed) &&
  Object.keys(observed).length === activationReceiptFields.size &&
  Object.keys(observed).every((field) => activationReceiptFields.has(field)) &&
  observed?.rolloutId === rolloutId &&
  activationMatches(observed?.canonicalPrivilegesSha256, activationDigest) &&
  activationMatches(observed?.sourceSystemIdentifier, /^[0-9]+$/u) &&
  activationMatches(observed?.targetSystemIdentifier, /^[0-9]+$/u) &&
  observed?.sourceSystemIdentifier !== observed?.targetSystemIdentifier &&
  activationMatches(observed?.expectedCommitSha, /^[a-f0-9]{40}$/u) &&
  observed?.postgresMajor === 17 &&
  activationMatches(observed?.migrationChecksum, activationDigest) &&
  Array.isArray(observed?.targetDeployIds) &&
  observed.targetDeployIds.length > 0 &&
  new Set(observed.targetDeployIds).size === observed.targetDeployIds.length &&
  observed.targetDeployIds.every(
    (deployId) =>
      typeof deployId === "string" && activationIdentifier.test(deployId),
  ) &&
  Number.isSafeInteger(observed?.permitEpoch) &&
  observed.permitEpoch > 0 &&
  activationMatches(observed?.permitNonce, /^[a-f0-9]{32}$/u) &&
  activationMatches(observed?.catalogFactsSha256, activationDigest) &&
  activationMatches(
    observed?.preactivationCatalogPolicySha256,
    activationDigest,
  ) &&
  activationMatches(observed?.activatedCatalogPolicySha256, activationDigest) &&
  activationMatches(observed?.firstWriteReceiptSha256, activationDigest) &&
  activationMatches(
    observed?.beforePrincipalInventorySha256,
    activationDigest,
  ) &&
  activationMatches(observed?.beforePrincipalPolicySha256, activationDigest) &&
  activationMatches(
    observed?.activatedPrincipalInventorySha256,
    activationDigest,
  ) &&
  activationMatches(
    observed?.activatedPrincipalPolicySha256,
    activationDigest,
  ) &&
  observed?.firstWriteBoundary === true &&
  activationMatches(observed?.transactionId, /^[0-9]+$/u) &&
  typeof observed?.activatedAt === "string" &&
  !Number.isNaN(Date.parse(observed.activatedAt)) &&
  new Date(observed.activatedAt).toISOString() === observed.activatedAt;
const activationObservation = (observed) => ({
  step: "activate_target_generation",
  observedAt: observed.activatedAt,
  facts: {
    ...observed,
    observationSha256: `sha256:${createHash("sha256").update(JSON.stringify(observed)).digest("hex")}`,
  },
});

export function executePrivateGenerationActivation(
  env = process.env,
  commands = new RedactedProcessCommandAdapter(),
  options = {},
) {
  for (const name of forbiddenCutoverAuthorityEnvironment) {
    if (env[name] !== undefined)
      throw new Error(
        `release_activation_authority_environment_forbidden:${name}`,
      );
  }
  const configuration = resolveReleaseMigrationConfiguration(env);
  const rolloutId = required(env, "REVIEW_ROUTER_ROLLOUT_ID");
  const recoveryConnection = decomposePostgresConnection(
    configuration.releaseUrl,
  );
  try {
    const recoveryOutput = commands.execute(
      "psql",
      [
        ...recoveryConnection.args,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
      ],
      {
        env: recoveryConnection.env,
        input: canonicalActivationRecoverySql(rolloutId),
      },
    ).stdout;
    const recovered = JSON.parse(
      recoveryOutput
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("{")) ?? "null",
    );
    if (recovered !== null) {
      if (!activationReceiptIsStructured(recovered, rolloutId))
        throw new Error("release_activation_receipt_unproven");
      return activationObservation(recovered);
    }
  } finally {
    recoveryConnection.cleanup();
  }
  const activation = canonicalActivationSql(configuration, {
    rolloutId,
  });
  options.captureActivationSqlSha256?.(
    `sha256:${createHash("sha256").update(JSON.stringify(activation.sql)).digest("hex")}`,
  );
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
  if (!activationReceiptIsStructured(observed, rolloutId))
    throw new Error("release_activation_receipt_unproven");
  return activationObservation(observed);
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
