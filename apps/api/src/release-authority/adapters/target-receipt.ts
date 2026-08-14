import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type {
  TargetActivationFacts,
  TargetActivationReceiptReaderPort,
} from "../domain/model.js";

export class RoutineTargetActivationReceiptReaderAdapter implements TargetActivationReceiptReaderPort {
  constructor(private readonly prisma: PrismaClient) {}

  async read(rolloutId: string): Promise<TargetActivationFacts | null> {
    const rows = await this.prisma.$queryRaw<{ value: unknown }[]>(Prisma.sql`
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
