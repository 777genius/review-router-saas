import { describe, expect, it, vi } from "vitest";
import {
  createReleaseRollout,
  RolloutStep,
  type StepReceipt,
} from "../domain/release-rollout";
import { ReleaseRolloutUseCases } from "./use-cases";

const receipt = (step: string): StepReceipt => ({
  step: step as StepReceipt["step"],
  receiptId: `receipt-${step}`,
  observedAt: "2026-08-11T00:00:00.000Z",
  payloadSha256: `sha256:${"a".repeat(64)}`,
});
const rollout = createReleaseRollout({
  rolloutId: "rollout-app-test",
  expectedCommitSha: "d".repeat(40),
  source: {
    renderResourceId: "dpg-source",
    systemIdentifier: "1",
    majorVersion: 16,
    recoveryWitnessSha256: "b".repeat(64),
  },
  target: {
    renderResourceId: "dpg-target",
    systemIdentifier: "2",
    majorVersion: 17,
    recoveryWitnessSha256: "c".repeat(64),
  },
});

describe("release rollout application boundary", () => {
  it("fails closed when an adapter returns a receipt for another use case", async () => {
    const ports = {
      provider: {
        freezeAndObserve: vi
          .fn()
          .mockResolvedValue(receipt(RolloutStep.CaptureSourceBackup)),
      },
      runner: {} as never,
      database: {} as never,
      services: {} as never,
      evidence: {} as never,
    };
    await expect(
      new ReleaseRolloutUseCases(ports).freezeProviderServices(rollout),
    ).rejects.toThrow("adapter_receipt_step_mismatch");
  });

  it("does not accept a provision receipt until runner identity is proven", async () => {
    const identity = {
      repository: "wrong/repository",
      runId: "12",
      runAttempt: 1,
      commitSha: "d".repeat(40),
      jitLabel: "rr-12-1",
      runnerName: "runner-12",
      baseServiceId: "srv-base",
      baseDeployId: "dep-pinned",
      imageDigest: `sha256:${"a".repeat(64)}`,
    };
    const ports = {
      provider: {} as never,
      runner: {
        provision: vi
          .fn()
          .mockResolvedValue({
            identity,
            receipt: receipt(RolloutStep.ProvisionPrivateRunner),
          }),
        cleanup: vi.fn(),
      },
      database: {} as never,
      services: {} as never,
      evidence: {} as never,
    };
    const useCases = new ReleaseRolloutUseCases(ports);
    await expect(
      useCases.provisionPrivateRunner(rollout, {
        repository: "777genius/review-router",
        runId: "12",
        runAttempt: 1,
        commitSha: "d".repeat(40),
        jitLabel: "rr-12-1",
      }),
    ).rejects.toThrow("runner_identity_mismatch");
    expect(rollout.receipts).toHaveLength(0);
  });
});
