import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RoutineTargetActivationReceiptReaderAdapter } from "./target-receipt.js";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const receipt = {
  rolloutId: "rollout-activation-1",
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  postgresMajor: 17,
  expectedCommitSha: "a".repeat(40),
  migrationChecksum: digest("1"),
  targetDeployIds: ["deploy-target-1"],
  permitEpoch: 1,
  permitNonce: "b".repeat(32),
  canonicalPrivilegesSha256: digest("2"),
  catalogFactsSha256: digest("3"),
  preactivationCatalogPolicySha256: digest("9"),
  activatedCatalogPolicySha256: digest("a"),
  beforePrincipalInventorySha256: digest("4"),
  beforePrincipalPolicySha256: digest("5"),
  activatedPrincipalInventorySha256: digest("6"),
  activatedPrincipalPolicySha256: digest("7"),
  firstWriteReceiptSha256: digest("8"),
  transactionId: "42",
  activatedAt: "2026-08-14T00:00:00.000Z",
  firstWriteBoundary: true,
};

const reader = (value: unknown) =>
  new RoutineTargetActivationReceiptReaderAdapter({
    $queryRaw: vi.fn().mockResolvedValue([{ value }]),
  } as never);

describe("target activation receipt reader", () => {
  it("reconstructs the exact durable observation hash", async () => {
    const observed = await reader(receipt).read(receipt.rolloutId);
    expect(observed).toEqual({
      ...receipt,
      activationObservationSha256: `sha256:${createHash("sha256")
        .update(JSON.stringify(receipt))
        .digest("hex")}`,
    });
  });

  it.each([
    "beforePrincipalInventorySha256",
    "preactivationCatalogPolicySha256",
    "activatedCatalogPolicySha256",
    "beforePrincipalPolicySha256",
    "activatedPrincipalInventorySha256",
    "activatedPrincipalPolicySha256",
  ])("rejects missing durable %s", async (field) => {
    const missing = Object.fromEntries(
      Object.entries(receipt).filter(([name]) => name !== field),
    );
    await expect(reader(missing).read(receipt.rolloutId)).rejects.toThrow(
      "target_activation_receipt_result_invalid",
    );
  });

  it.each([
    "beforePrincipalInventorySha256",
    "beforePrincipalPolicySha256",
    "activatedPrincipalInventorySha256",
    "activatedPrincipalPolicySha256",
  ])("rejects malformed durable %s", async (field) => {
    const malformed = { ...receipt, [field]: "missing" };
    await expect(reader(malformed).read(receipt.rolloutId)).rejects.toThrow(
      "target_activation_receipt_result_invalid",
    );
  });

  it.each([
    { ...receipt, unboundEvidence: digest("9") },
    { ...receipt, transactionId: 42 },
    {
      ...receipt,
      targetDeployIds: [receipt.targetDeployIds[0], receipt.targetDeployIds[0]],
    },
  ])("rejects non-canonical durable receipt shapes", async (malformed) => {
    await expect(reader(malformed).read(receipt.rolloutId)).rejects.toThrow(
      "target_activation_receipt_result_invalid",
    );
  });

  it("rejects a well-formed receipt for a different rollout", async () => {
    await expect(reader(receipt).read("rollout-activation-2")).rejects.toThrow(
      "target_activation_receipt_result_invalid",
    );
  });
});

describe("target migration receipt reader", () => {
  const permit = {
    schemaVersion: 1 as const,
    rolloutId: "rollout-migration-1",
    runId: "1",
    runAttempt: 1,
    targetSystemIdentifier: "200",
    targetRecoveryWitnessSha256: "a".repeat(64),
    transitionSha256: digest("b"),
    expectedPreviousReceiptSha256: digest("c"),
    sourceLegacyAmbiguity: {
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
      activeLeaseIds: [],
      fetchedSetupIds: [],
      pendingIntentIds: [],
      intentStatuses: [],
      observations: [
        {
          observedAt: "2026-08-13T23:59:58.000Z",
          inventorySha256:
            "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
        },
        {
          observedAt: "2026-08-13T23:59:59.000Z",
          inventorySha256:
            "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
        },
      ] as const,
      stable: true as const,
    },
    eligibilityCutoff: "2026-08-14T00:00:00.000Z",
    epoch: 2,
    nonce: "d".repeat(32),
  };
  const migrationReceipt = {
    schemaVersion: 1,
    rolloutId: permit.rolloutId,
    sourceSystemIdentifier: "100",
    targetSystemIdentifier: permit.targetSystemIdentifier,
    targetDatabaseIdentity: "16385",
    targetDatabaseName: "target",
    targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
    transitionSha256: permit.transitionSha256,
    previousReceiptSha256: permit.expectedPreviousReceiptSha256,
    permitEpoch: permit.epoch,
    permitNonce: permit.nonce,
    postManifestIdentity: digest("e"),
    postCatalogDigest: digest("f"),
    legacyReconciliation: { status: "reconciled" },
    effectFingerprint: digest("1"),
    completedAt: "2026-08-14T00:00:00.000Z",
  };

  it("returns the exact guard-owned receipt digest", async () => {
    await expect(
      reader(migrationReceipt).readMigrationReceipt(permit),
    ).resolves.toEqual({
      ...migrationReceipt,
      targetMigrationReceiptSha256: `sha256:${sha256Canonical(
        migrationReceipt,
      )}`,
    });
  });

  it("rejects a replay under another permit nonce", async () => {
    await expect(
      reader(migrationReceipt).readMigrationReceipt({
        ...permit,
        nonce: "e".repeat(32),
      }),
    ).rejects.toThrow("target_migration_receipt_result_invalid");
  });
});
