import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RoutineTargetActivationReceiptReaderAdapter } from "./target-receipt.js";

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
