import { describe, expect, it, vi } from "vitest";
import type {
  ActivationAuthorization,
  ActivationReceipt,
} from "@reviewrouter/features-release-rollout";
import {
  ReleaseAuthorityService,
  type ReleaseAuthorityLedgerPort,
  type TargetActivationFacts,
  type TargetActivationReceiptReaderPort,
} from "../../release-rollout-ledger.js";

const authorization: ActivationAuthorization = {
  rolloutId: "rollout-1",
  expectedCommitSha: "c".repeat(40),
  postgresMajor: 17,
  migrationChecksum: `sha256:${"7".repeat(64)}`,
  epoch: 3,
  nonce: "a".repeat(32),
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  previousReceiptSha256: `sha256:${"b".repeat(64)}`,
  targetDeployIds: ["deploy-1"],
  authorizedAt: "2026-08-12T00:00:00.000Z",
};

const targetReceipt: ActivationReceipt = {
  step: "activate_target_generation",
  receiptId: "receipt-1",
  observedAt: "2026-08-12T00:01:00.000Z",
  rolloutId: authorization.rolloutId,
  expectedCommitSha: authorization.expectedCommitSha,
  runId: "run-1",
  runAttempt: 1,
  sourceSystemIdentifier: authorization.sourceSystemIdentifier,
  targetSystemIdentifier: authorization.targetSystemIdentifier,
  provider: { renderDeployIds: ["deploy-1"] },
  observationSha256: `sha256:${"d".repeat(64)}`,
  previousReceiptSha256: authorization.previousReceiptSha256,
  receiptSha256: `sha256:${"e".repeat(64)}`,
  canonicalPrivilegesSha256: `sha256:${"1".repeat(64)}`,
  catalogFactsSha256: `sha256:${"2".repeat(64)}`,
  transactionId: "12345",
  firstWriteReceiptSha256: `sha256:${"3".repeat(64)}`,
  firstWriteBoundary: true,
  postgresMajor: authorization.postgresMajor,
  migrationChecksum: authorization.migrationChecksum,
  permitEpoch: authorization.epoch,
  permitNonce: authorization.nonce,
  targetDeployIds: authorization.targetDeployIds,
};

const targetFacts: TargetActivationFacts = {
  canonicalPrivilegesSha256: targetReceipt.canonicalPrivilegesSha256,
  catalogFactsSha256: targetReceipt.catalogFactsSha256,
  transactionId: targetReceipt.transactionId,
  firstWriteReceiptSha256: targetReceipt.firstWriteReceiptSha256,
  firstWriteBoundary: targetReceipt.firstWriteBoundary,
  postgresMajor: targetReceipt.postgresMajor,
  migrationChecksum: targetReceipt.migrationChecksum,
  permitEpoch: targetReceipt.permitEpoch,
  permitNonce: targetReceipt.permitNonce,
  targetDeployIds: targetReceipt.targetDeployIds,
};

const finalizeInput = {
  authorization,
  provider: { renderDeployIds: ["caller-controlled"] },
  nextReceiptSha256: targetReceipt.receiptSha256,
  activationReceipt: targetReceipt,
};

const service = (proof: TargetActivationFacts | null) => {
  const finalizeActivation = vi.fn().mockResolvedValue(true);
  const repository = {
    finalizeActivation,
  } as unknown as ReleaseAuthorityLedgerPort;
  const reader: TargetActivationReceiptReaderPort = {
    read: vi.fn().mockResolvedValue(proof),
  };
  return {
    finalizeActivation,
    service: new ReleaseAuthorityService(repository, undefined, reader),
  };
};

describe("independent target activation receipt verification", () => {
  it("rejects a forged proposed receipt without persisting authority", async () => {
    const fixture = service(targetFacts);
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        activationReceipt: {
          ...targetReceipt,
          transactionId: "forged",
        },
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it("rejects missing target proof without persisting authority", async () => {
    const fixture = service(null);
    await expect(fixture.service.finalize(finalizeInput)).rejects.toThrow(
      "target_activation_receipt_missing",
    );
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it("persists the full receipt only after independently verifying target facts", async () => {
    const fixture = service(targetFacts);
    await expect(fixture.service.finalize(finalizeInput)).resolves.toBe(true);
    expect(fixture.finalizeActivation).toHaveBeenCalledWith(finalizeInput);
  });

  it("rejects target proof that differs from authorization", async () => {
    const fixture = service({
      ...targetFacts,
      permitNonce: "f".repeat(32),
    });
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        activationReceipt: {
          ...targetReceipt,
          permitNonce: "f".repeat(32),
        },
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });
});
