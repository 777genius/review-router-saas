import { describe, expect, it, vi } from "vitest";
import {
  createReleaseRollout,
  RolloutPhase,
  RolloutStep,
  type StepObservation,
} from "../domain/release-rollout";
import { ReleaseRolloutUseCases } from "./use-cases";

const rollout = createReleaseRollout({
  rolloutId: "rollout-app-test",
  expectedCommitSha: "d".repeat(40),
  execution: {
    organization: "rr-control",
    controlRepository: "rr-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    event: "workflow_dispatch",
    actor: "operator",
    runId: "12",
    runAttempt: 1,
    roleJobName: "private-role-job",
    cutoverJobName: "private-cutover-job",
  },
  source: {
    renderResourceId: "dpg-source",
    internalHostname: "source.internal",
    databaseName: "reviewrouter",
    systemIdentifier: "1",
    majorVersion: 16,
    recoveryWitnessSha256: "b".repeat(64),
  },
  target: {
    renderResourceId: "dpg-target",
    internalHostname: "target.internal",
    databaseName: "reviewrouter",
    systemIdentifier: "2",
    majorVersion: 17,
    recoveryWitnessSha256: "c".repeat(64),
  },
});
const observed = (step: StepObservation["step"]): StepObservation => ({
  step,
  observedAt: "2026-08-12T00:00:00.000Z",
  facts: { ok: true },
});
const stagedRollout = {
  ...rollout,
  phase: RolloutPhase.TargetStaged,
  receipts: [
    {
      step: RolloutStep.StageTargetServices,
      receiptId: `${rollout.rolloutId}:stage_target_services:1`,
      observedAt: "2026-08-12T00:00:00.000Z",
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: { renderDeployIds: ["dep-target"] },
      observationSha256: `sha256:${"1".repeat(64)}`,
      previousReceiptSha256: `sha256:${"0".repeat(64)}`,
      receiptSha256: `sha256:${"2".repeat(64)}`,
    },
  ],
} as const;
const activationObservation: StepObservation = {
  step: RolloutStep.ActivateTargetGeneration,
  observedAt: "2026-08-12T00:00:01.000Z",
  facts: {
    rolloutId: rollout.rolloutId,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    targetSystemIdentifier: rollout.target.systemIdentifier,
    firstWriteBoundary: true,
    canonicalPrivilegesSha256: `sha256:${"3".repeat(64)}`,
    catalogFactsSha256: `sha256:${"4".repeat(64)}`,
    firstWriteReceiptSha256: `sha256:${"5".repeat(64)}`,
    observationSha256: `sha256:${"6".repeat(64)}`,
    transactionId: "42",
    fenceNonce: "a".repeat(32),
    fenceVersion: 1,
    claimVersion: 1,
    targetDeployIds: ["dep-target"],
  },
};
const basePorts = () => ({
  preflight: { observeProtectedEnvironment: vi.fn() },
  provider: { freezeAndObserve: vi.fn(), compensateAndObserve: vi.fn() },
  runner: {
    provision: vi.fn(),
    cleanup: vi.fn(),
    reconcileOrphans: vi.fn().mockResolvedValue([]),
  },
  database: {} as never,
  services: {} as never,
  evidence: {} as never,
  ledger: {
    claim: vi.fn().mockResolvedValue("claimed"),
    compareAndSet: vi.fn().mockResolvedValue(true),
    markActivationUncertain: vi.fn().mockResolvedValue(undefined),
    fenceActivation: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      jobId: "44",
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      previousReceiptSha256: stagedRollout.receipts[0].receiptSha256,
      nonce: "a".repeat(32),
      version: 1,
      claimVersion: 1,
      targetDeployIds: ["dep-target"],
      fencedAt: "2026-08-12T00:00:00.000Z",
    }),
    finalizeActivation: vi.fn().mockResolvedValue(true),
    observeActivationState: vi.fn().mockResolvedValue("before"),
    verifyFinalAuthority: vi.fn().mockResolvedValue(true),
  },
});

describe("release rollout application boundary", () => {
  it("is the only transition path and rejects an adapter observation for another step", async () => {
    const ports = basePorts();
    ports.provider.freezeAndObserve.mockResolvedValue(
      observed(RolloutStep.CaptureSourceBackup),
    );
    await expect(
      new ReleaseRolloutUseCases(ports).freezeProviderServices(rollout),
    ).rejects.toThrow("adapter_observation_step_mismatch");
    expect(rollout.receipts).toHaveLength(0);
  });

  it("durably claims a rollout ID and rejects duplicate/retry execution", async () => {
    const ports = basePorts();
    const useCases = new ReleaseRolloutUseCases(ports);
    expect((await useCases.claimRollout(rollout)).receipts[0]?.step).toBe(
      RolloutStep.ClaimRollout,
    );
    expect(ports.ledger.compareAndSet).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommitSha: rollout.expectedCommitSha,
        runId: rollout.execution.runId,
        runAttempt: 1,
        sourceSystemIdentifier: rollout.source.systemIdentifier,
        targetSystemIdentifier: rollout.target.systemIdentifier,
        step: RolloutStep.ClaimRollout,
      }),
    );
    ports.ledger.claim.mockResolvedValue("duplicate");
    await expect(useCases.claimRollout(rollout)).rejects.toThrow(
      "rollout_id_already_claimed",
    );
  });

  it("does not transition when exact runner workflow job identity is wrong", async () => {
    const ports = basePorts();
    ports.runner.provision.mockResolvedValue({
      identity: {
        organization: "rr-control",
        repository: "rr-control/releases",
        workflowPath: rollout.execution.workflowPath,
        workflowRef: rollout.execution.workflowRef,
        event: rollout.execution.event,
        actor: rollout.execution.actor,
        runId: rollout.execution.runId,
        runAttempt: 1,
        workflowJobId: "44",
        workflowJobName: "attacker-job",
        commitSha: rollout.expectedCommitSha,
        runnerName: "rr-runner",
        cleanupCanary: "rr-cleanup:rollout-app-test:rr-runner",
        renderJobId: "job-44",
        baseServiceId: "srv-base",
        runnerGroupId: 9,
        runnerGroupName: "private-pg17",
        uniqueRunnerLabel: "rr-runner",
        workFolder: "_work/rr-runner",
        provenance: {
          kind: "git",
          deployId: "dep-1",
          commitSha: rollout.expectedCommitSha,
        },
      },
      observation: observed(RolloutStep.ProvisionRoleRunner),
    });
    await expect(
      new ReleaseRolloutUseCases(ports).provisionPrivateRunner(rollout),
    ).rejects.toThrow("runner_identity_mismatch");
    expect(rollout.receipts).toHaveLength(0);
  });

  it("permanently marks the source ineligible when activation outcome is unknown", async () => {
    const ports = basePorts();
    ports.database = {
      activate: vi.fn().mockRejectedValue(new Error("connection_lost")),
    } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("activation_uncertain");
    expect(ports.ledger.markActivationUncertain).toHaveBeenCalledWith({
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
    });
  });

  it("does not enter the activation transaction when the durable fence CAS fails", async () => {
    const ports = basePorts();
    ports.ledger.fenceActivation.mockResolvedValue(null);
    const activate = vi.fn();
    ports.database = { activate } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("activation_fence_cas_failed");
    expect(activate).not.toHaveBeenCalled();
    expect(ports.ledger.markActivationUncertain).not.toHaveBeenCalled();
  });

  it("remains forward-only after a crash between the fence and database transaction", async () => {
    const ports = basePorts();
    ports.database = {
      activate: vi.fn().mockRejectedValue(new Error("crash_before_db")),
    } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("activation_uncertain");
    expect(ports.ledger.markActivationUncertain).toHaveBeenCalledOnce();
  });

  it("remains forward-only after database COMMIT and before ledger finalize", async () => {
    const ports = basePorts();
    ports.database = {
      activate: vi.fn().mockResolvedValue(activationObservation),
    } as never;
    ports.ledger.finalizeActivation.mockRejectedValue(
      new Error("crash_before_finalize"),
    );
    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("activation_uncertain");
    expect(ports.ledger.markActivationUncertain).toHaveBeenCalledOnce();
  });

  it("finalizes activated authority only with the receipt bound to the same fence", async () => {
    const ports = basePorts();
    ports.database = {
      activate: vi.fn().mockResolvedValue(activationObservation),
    } as never;
    const activated = await new ReleaseRolloutUseCases(
      ports,
    ).activateTargetGeneration(stagedRollout, "44");
    expect(activated.phase).toBe(RolloutPhase.TargetActivated);
    expect(activated.activationReceipt).toMatchObject({
      fenceNonce: "a".repeat(32),
      fenceVersion: 1,
    });
    expect(ports.ledger.finalizeActivation).toHaveBeenCalledOnce();
    expect(ports.ledger.markActivationUncertain).not.toHaveBeenCalled();
  });
});
