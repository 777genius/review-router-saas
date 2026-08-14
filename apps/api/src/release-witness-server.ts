import { config as loadDotenv } from "dotenv";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { createReleaseWitnessApp } from "./release-witness-composition.js";
import { readinessTimingPolicyFromEnvironment } from "./release-authority/adapters/readiness-config.js";

for (const path of ["../../.env.local", "../../.env", ".env.local", ".env"])
  loadDotenv({ path, override: false });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`release_witness_env_missing:${name}`);
  return value;
};
const witnessPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_DATABASE_URL"),
  poolMax: 2,
});
const sourceWitnessPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_SOURCE_RELEASE_WITNESS_DATABASE_URL"),
  poolMax: 1,
});
const targetWitnessPrisma = createPrismaClient({
  databaseUrl: required("REVIEW_ROUTER_ACTIVATION_RECEIPT_READER_DATABASE_URL"),
  poolMax: 1,
});
const identity = (prefix: string) => ({
  serverIdentity: required(`${prefix}_SYSTEM_IDENTIFIER`),
  databaseIdentity: required(`${prefix}_DATABASE_OID`),
  databaseName: required(`${prefix}_DATABASE_NAME`),
});
const app = await createReleaseWitnessApp({
  witnessPrisma,
  triggerTokenSha256: required("REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256"),
  deploymentRevision: required("REVIEW_ROUTER_RELEASE_COMMIT_SHA"),
  artifactDigest: required("REVIEW_ROUTER_RELEASE_IMAGE_DIGEST"),
  authorityOwnerRoleName: required(
    "REVIEW_ROUTER_RELEASE_AUTHORITY_OWNER_ROLE",
  ),
  activationGuardRoleName: required("REVIEW_ROUTER_ACTIVATION_GUARD_ROLE"),
  readinessPolicy: readinessTimingPolicyFromEnvironment(process.env),
  renderReadToken: required("REVIEW_ROUTER_RELEASE_WITNESS_RENDER_READ_TOKEN"),
  sourceWitnessPrisma,
  targetWitnessPrisma,
  githubReadToken: required("REVIEW_ROUTER_RELEASE_WITNESS_GITHUB_READ_TOKEN"),
  signingKeyId: required("REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_KEY_ID"),
  signingPrivateKeyPem: required(
    "REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_PRIVATE_KEY_PEM",
  ),
  trustedDatabaseIdentity: {
    serverIdentity: required(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_SYSTEM_IDENTIFIER",
    ),
    databaseIdentity: required("REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_OID"),
    databaseName: required("REVIEW_ROUTER_RELEASE_AUTHORITY_DATABASE_NAME"),
  },
  trustedBindingPolicy: {
    repository: required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY"),
    workflowPath: required("REVIEW_ROUTER_RELEASE_CONTROL_WORKFLOW_PATH"),
    sourceDatabaseIdentity: {
      serverIdentity: required(
        "REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER",
      ),
      databaseIdentity: required("REVIEW_ROUTER_SOURCE_DATABASE_OID"),
      databaseName: required("REVIEW_ROUTER_SOURCE_DATABASE_NAME"),
    },
    authorityDatabaseIdentity: identity("REVIEW_ROUTER_RELEASE_AUTHORITY"),
    targetDatabaseIdentity: identity("REVIEW_ROUTER_ACTIVATION_TARGET"),
    sourceGeneration: {
      renderResourceId: required("REVIEW_ROUTER_SOURCE_RENDER_DATABASE_ID"),
      databaseName: required("REVIEW_ROUTER_SOURCE_DATABASE_NAME"),
      systemIdentifier: required(
        "REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER",
      ),
      majorVersion: 16,
      recoveryWitnessSha256: required(
        "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256",
      ),
    },
    targetGeneration: {
      renderResourceId: required("REVIEW_ROUTER_TARGET_RENDER_DATABASE_ID"),
      databaseName: required("REVIEW_ROUTER_ACTIVATION_TARGET_DATABASE_NAME"),
      systemIdentifier: required(
        "REVIEW_ROUTER_ACTIVATION_TARGET_SYSTEM_IDENTIFIER",
      ),
      majorVersion: 17,
      recoveryWitnessSha256: required(
        "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
      ),
    },
    authorityCatalogFingerprint: required(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_CATALOG_FINGERPRINT",
    ),
    authorityCatalogVerifier: required(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_CATALOG_VERIFIER",
    ),
    authorityMigrationManifestIdentity: required(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MANIFEST_IDENTITY",
    ),
    activationMigrationManifestIdentity: required(
      "REVIEW_ROUTER_ACTIVATION_MIGRATION_MANIFEST_SHA256",
    ),
    activationNamespaceFingerprint: required(
      "REVIEW_ROUTER_ACTIVATION_NAMESPACE_FINGERPRINT",
    ),
    installerRoutineBodySha256: required(
      "REVIEW_ROUTER_ACTIVATION_INSTALLER_BODY_SHA256",
    ),
    readerRoutineBodySha256: required(
      "REVIEW_ROUTER_ACTIVATION_READER_BODY_SHA256",
    ),
    maximumAgeMilliseconds: Number(
      process.env.REVIEW_ROUTER_RELEASE_WITNESS_MAXIMUM_AGE_MS || "300000",
    ),
  },
});
app.addHook("onClose", async () => {
  await Promise.all([
    witnessPrisma.$disconnect(),
    sourceWitnessPrisma.$disconnect(),
    targetWitnessPrisma.$disconnect(),
  ]);
});
await app.listen({
  port: Number(process.env.PORT ?? 4011),
  host: process.env.HOST ?? "127.0.0.1",
});
