import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type {
  TargetActivationFacts,
  TargetActivationReceiptReaderPort,
  TargetMigrationReceiptFacts,
  TargetMigrationReceiptReaderPort,
} from "../domain/model.js";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";
import type { ReleaseMigrationPermit } from "@reviewrouter/features-release-rollout";
import {
  executeSameConnectionFenced,
  type SameConnectionIdentityExpectation,
  type SameConnectionTransactionTiming,
} from "./same-connection-fence.js";

export class RoutineTargetActivationReceiptReaderAdapter
  implements TargetActivationReceiptReaderPort, TargetMigrationReceiptReaderPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fence?: SameConnectionIdentityExpectation,
    private readonly timing?: SameConnectionTransactionTiming,
  ) {}

  async read(rolloutId: string): Promise<TargetActivationFacts | null> {
    const query = (connection: Prisma.TransactionClient) =>
      connection.$queryRaw<{ value: unknown }[]>(Prisma.sql`
        SELECT reviewrouter_activation.read_activation_receipt(${rolloutId}) AS value
      `);
    const rows = this.fence
      ? await executeSameConnectionFenced(
          this.prisma,
          this.fence,
          query,
          this.timing,
        )
      : await this.prisma.$queryRaw<{ value: unknown }[]>(Prisma.sql`
          SELECT reviewrouter_activation.read_activation_receipt(${rolloutId}) AS value
        `);
    if (rows.length !== 1)
      throw new Error("target_activation_receipt_result_invalid");
    const value = rows[0]?.value;
    if (value === null) return null;
    if (!isTargetActivationReceipt(value) || value.rolloutId !== rolloutId)
      throw new Error("target_activation_receipt_result_invalid");
    return {
      ...value,
      activationObservationSha256: `sha256:${createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex")}`,
    };
  }

  async readMigrationReceipt(
    permit: ReleaseMigrationPermit,
  ): Promise<TargetMigrationReceiptFacts> {
    const query = (connection: Prisma.TransactionClient) =>
      connection.$queryRaw<{ value: unknown }[]>(Prisma.sql`
        SELECT reviewrouter_activation.read_migration_receipt(
          ${permit.rolloutId}, ${permit.epoch}, ${permit.nonce}
        ) AS value
      `);
    const rows = this.fence
      ? await executeSameConnectionFenced(
          this.prisma,
          this.fence,
          query,
          this.timing,
        )
      : await query(this.prisma);
    const value = rows[0]?.value;
    if (rows.length !== 1 || !isTargetMigrationReceipt(value, permit))
      throw new Error("target_migration_receipt_result_invalid");
    return {
      ...value,
      targetMigrationReceiptSha256: `sha256:${sha256Canonical(value)}`,
    };
  }
}

const digest = /^sha256:[a-f0-9]{64}$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);
const receiptFields = new Set([
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

function isTargetActivationReceipt(
  value: unknown,
): value is Omit<TargetActivationFacts, "activationObservationSha256"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === receiptFields.size &&
    Object.keys(receipt).every((field) => receiptFields.has(field)) &&
    matches(receipt.rolloutId, identifier) &&
    matches(receipt.expectedCommitSha, /^[a-f0-9]{40}$/u) &&
    matches(receipt.sourceSystemIdentifier, /^[0-9]+$/u) &&
    matches(receipt.targetSystemIdentifier, /^[0-9]+$/u) &&
    receipt.sourceSystemIdentifier !== receipt.targetSystemIdentifier &&
    receipt.postgresMajor === 17 &&
    Number.isSafeInteger(receipt.permitEpoch) &&
    Number(receipt.permitEpoch) > 0 &&
    matches(receipt.permitNonce, /^[a-f0-9]{32}$/u) &&
    Array.isArray(receipt.targetDeployIds) &&
    receipt.targetDeployIds.length > 0 &&
    new Set(receipt.targetDeployIds).size === receipt.targetDeployIds.length &&
    receipt.targetDeployIds.every(
      (deployId) => typeof deployId === "string" && identifier.test(deployId),
    ) &&
    receipt.firstWriteBoundary === true &&
    matches(receipt.transactionId, /^[0-9]+$/u) &&
    typeof receipt.activatedAt === "string" &&
    !Number.isNaN(Date.parse(receipt.activatedAt)) &&
    new Date(receipt.activatedAt).toISOString() === receipt.activatedAt &&
    [
      receipt.migrationChecksum,
      receipt.canonicalPrivilegesSha256,
      receipt.catalogFactsSha256,
      receipt.preactivationCatalogPolicySha256,
      receipt.activatedCatalogPolicySha256,
      receipt.firstWriteReceiptSha256,
      receipt.beforePrincipalInventorySha256,
      receipt.beforePrincipalPolicySha256,
      receipt.activatedPrincipalInventorySha256,
      receipt.activatedPrincipalPolicySha256,
    ].every(
      (candidate) => typeof candidate === "string" && digest.test(candidate),
    )
  );
}

const migrationReceiptFields = new Set([
  "schemaVersion",
  "rolloutId",
  "sourceSystemIdentifier",
  "targetSystemIdentifier",
  "targetDatabaseIdentity",
  "targetDatabaseName",
  "targetRecoveryWitnessSha256",
  "transitionSha256",
  "previousReceiptSha256",
  "permitEpoch",
  "permitNonce",
  "postManifestIdentity",
  "postCatalogDigest",
  "sourceLegacyAmbiguity",
  "eligibilityCutoff",
  "legacyReconciliation",
  "effectFingerprint",
  "completedAt",
]);

function isTargetMigrationReceipt(
  value: unknown,
  permit: ReleaseMigrationPermit,
): value is Omit<TargetMigrationReceiptFacts, "targetMigrationReceiptSha256"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === migrationReceiptFields.size &&
    Object.keys(receipt).every((field) => migrationReceiptFields.has(field)) &&
    receipt.schemaVersion === 1 &&
    receipt.rolloutId === permit.rolloutId &&
    matches(receipt.sourceSystemIdentifier, /^[1-9][0-9]{0,19}$/u) &&
    receipt.targetSystemIdentifier === permit.targetSystemIdentifier &&
    matches(receipt.targetDatabaseIdentity, /^[0-9]+$/u) &&
    typeof receipt.targetDatabaseName === "string" &&
    receipt.targetDatabaseName.length > 0 &&
    receipt.targetRecoveryWitnessSha256 ===
      permit.targetRecoveryWitnessSha256 &&
    receipt.transitionSha256 === permit.transitionSha256 &&
    receipt.previousReceiptSha256 === permit.expectedPreviousReceiptSha256 &&
    receipt.permitEpoch === permit.epoch &&
    receipt.permitNonce === permit.nonce &&
    matches(receipt.postManifestIdentity, digest) &&
    matches(receipt.postCatalogDigest, digest) &&
    Boolean(
      receipt.sourceLegacyAmbiguity &&
      typeof receipt.sourceLegacyAmbiguity === "object" &&
      !Array.isArray(receipt.sourceLegacyAmbiguity),
    ) &&
    sha256Canonical(receipt.sourceLegacyAmbiguity) ===
      sha256Canonical(permit.sourceLegacyAmbiguity) &&
    receipt.eligibilityCutoff === permit.eligibilityCutoff &&
    Boolean(
      receipt.legacyReconciliation &&
      typeof receipt.legacyReconciliation === "object" &&
      !Array.isArray(receipt.legacyReconciliation),
    ) &&
    matches(receipt.effectFingerprint, digest) &&
    typeof receipt.completedAt === "string" &&
    !Number.isNaN(Date.parse(receipt.completedAt)) &&
    new Date(receipt.completedAt).toISOString() === receipt.completedAt
  );
}
