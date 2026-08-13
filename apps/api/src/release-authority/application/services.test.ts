import { describe, expect, it, vi } from "vitest";
import type {
  ActivationAuthorization,
  ActivationReceipt,
} from "@reviewrouter/features-release-rollout";
import {
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RunnerOperationsService,
  type ReleaseAuthorityLedgerPort,
  type ReleaseRolloutReconciliationPort,
  type RunnerOperationsLedgerPort,
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
  rolloutId: targetReceipt.rolloutId,
  expectedCommitSha: targetReceipt.expectedCommitSha,
  sourceSystemIdentifier: targetReceipt.sourceSystemIdentifier,
  targetSystemIdentifier: targetReceipt.targetSystemIdentifier,
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
  activatedAt: targetReceipt.observedAt,
  activationObservationSha256: targetReceipt.observationSha256,
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

describe("target-aware uncertain activation reconciliation", () => {
  const context = {
    rolloutId: authorization.rolloutId,
    runId: targetReceipt.runId,
    runAttempt: targetReceipt.runAttempt,
    state: "outcome_unknown" as const,
    activationBoundary: "uncertain" as const,
    receiptOrdinal: 13,
    authorization,
  };

  const reconcileWith = async (
    proof: Awaited<ReturnType<TargetActivationReceiptReaderPort["read"]>>,
  ) => {
    const reconcile = vi.fn().mockResolvedValue({ state: "result" });
    const repository = {
      context: vi.fn().mockResolvedValue(context),
      reconcile,
    } as unknown as ReleaseRolloutReconciliationPort;
    const reader = {
      read: vi.fn().mockResolvedValue(proof),
    } satisfies TargetActivationReceiptReaderPort;
    await new ReleaseRolloutReconciliationService(repository, reader).reconcile(
      authorization.rolloutId,
    );
    return reconcile.mock.calls[0]?.[0];
  };

  it("reconstructs the exact immutable receipt chain from matching target facts", async () => {
    const input = await reconcileWith(targetFacts);
    expect(input.targetObservation.kind).toBe("matching_activation_receipt");
    expect(input.targetObservation.authorization).toEqual(authorization);
    expect(input.targetObservation.activationReceipt).toMatchObject({
      rolloutId: authorization.rolloutId,
      runId: targetReceipt.runId,
      runAttempt: targetReceipt.runAttempt,
      receiptId: `${authorization.rolloutId}:activate_target_generation:14`,
      previousReceiptSha256: authorization.previousReceiptSha256,
      permitEpoch: authorization.epoch,
      permitNonce: authorization.nonce,
    });
    expect(input.targetObservation.nextReceiptSha256).toBe(
      input.targetObservation.activationReceipt.receiptSha256,
    );
  });

  it.each([
    [null, "target_receipt_absent"],
    [
      { receiptAbsent: true, permitAbsent: true },
      "activation_absent_without_revocation",
    ],
    [
      { ...targetFacts, permitNonce: "f".repeat(32) },
      "target_receipt_conflict",
    ],
  ] as const)(
    "keeps source fenced for target evidence %j",
    async (proof, kind) => {
      const input = await reconcileWith(proof);
      expect(input.targetObservation).toEqual({ kind });
    },
  );

  it("keeps source fenced when the independent target read fails", async () => {
    const reconcile = vi.fn().mockResolvedValue({ state: "result" });
    const repository = {
      context: vi.fn().mockResolvedValue(context),
      reconcile,
    } as unknown as ReleaseRolloutReconciliationPort;
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("target unavailable")),
    } satisfies TargetActivationReceiptReaderPort;
    await new ReleaseRolloutReconciliationService(repository, reader).reconcile(
      authorization.rolloutId,
    );
    expect(reconcile).toHaveBeenCalledWith({
      rolloutId: authorization.rolloutId,
      targetObservation: { kind: "target_read_unavailable" },
    });
  });
});

describe("witness-gated runner terminal ordering", () => {
  const observation = {
    step: "cleanup_role_runner",
    observedAt: "2026-08-12T00:02:00.000Z",
  } as never;

  it("does not invoke terminal CAS when independent witness is unproven", async () => {
    const markTerminal = vi.fn();
    const repository = {
      cleanupWitness: vi
        .fn()
        .mockRejectedValue(
          new Error("release runner independent cleanup witness unproven"),
        ),
      markTerminal,
    } as unknown as RunnerOperationsLedgerPort;
    const service = new RunnerOperationsService(repository);

    await expect(service.markTerminal("job-1", observation)).rejects.toThrow(
      "independent cleanup witness unproven",
    );
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("checks the exact job witness before invoking terminal CAS", async () => {
    const calls: string[] = [];
    const repository = {
      cleanupWitness: vi.fn(async (jobId: string) => {
        calls.push(`witness:${jobId}`);
        return { canary: "canary" };
      }),
      markTerminal: vi.fn(async (jobId: string) => {
        calls.push(`terminal:${jobId}`);
      }),
    } as unknown as RunnerOperationsLedgerPort;
    const service = new RunnerOperationsService(repository);

    await service.markTerminal("job-1", observation);
    expect(calls).toEqual(["witness:job-1", "terminal:job-1"]);
  });
});
