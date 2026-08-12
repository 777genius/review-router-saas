import { describe, expect, it, vi } from "vitest";
import {
  createReleaseRollout,
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
    expectedJobName: "private-job",
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
const basePorts = () => ({
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
});
