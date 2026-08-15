import { describe, expect, it, vi } from "vitest";
import {
  createReleaseRollout,
  RolloutPhase,
  RolloutStep,
  type ReleaseRollout,
  type StepObservation,
} from "../domain/release-rollout";
import { ReleaseRolloutUseCases } from "./use-cases";
import { ProviderAuthorityOperation } from "./ports";
import { createReleaseMigrationTransition } from "../domain/release-migration-transition";

const resumedPostcondition = {
  serviceId: "srv-target",
  ownerId: "tea-owner",
  serviceType: "web_service",
  suspended: false,
  region: "frankfurt",
  plan: "starter",
  runtime: "image" as const,
  image: `registry.example.test/app@sha256:${"a".repeat(64)}`,
  repository: null,
  branch: null,
  rootDirectory: null,
  buildCommand: null,
  startCommand: null,
  preDeployCommand: "",
  healthPath: "/health",
  automaticDeployments: false as const,
  automaticDeployTrigger: "off" as const,
  shutdownDelaySeconds: 60,
  instanceCount: 1,
  environmentSha256: `sha256:${"b".repeat(64)}`,
};

const rollout = createReleaseRollout({
  rolloutId: "rollout-app-test",
  expectedCommitSha: "d".repeat(40),
  migrationTransition: createReleaseMigrationTransition({
    commitSha: "d".repeat(40),
    releaseImageDigest: `sha256:${"e".repeat(64)}`,
  }),
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
      step: RolloutStep.RunReleaseMigration,
      receiptId: `${rollout.rolloutId}:run_release_migration:1`,
      observedAt: "2026-08-12T00:00:00.000Z",
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: undefined,
      observationSha256: `sha256:${"0".repeat(64)}`,
      previousReceiptSha256: `sha256:${"0".repeat(64)}`,
      receiptSha256: `sha256:${"1".repeat(64)}`,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
    },
    {
      step: RolloutStep.StageTargetServices,
      receiptId: `${rollout.rolloutId}:stage_target_services:2`,
      observedAt: "2026-08-12T00:00:00.000Z",
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: { renderDeployIds: ["dep-target"] },
      observationSha256: `sha256:${"1".repeat(64)}`,
      previousReceiptSha256: `sha256:${"1".repeat(64)}`,
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
    beforePrincipalInventorySha256: `sha256:${"8".repeat(64)}`,
    beforePrincipalPolicySha256: `sha256:${"9".repeat(64)}`,
    activatedPrincipalInventorySha256: `sha256:${"a".repeat(64)}`,
    activatedPrincipalPolicySha256: `sha256:${"b".repeat(64)}`,
    catalogFactsSha256: `sha256:${"4".repeat(64)}`,
    preactivationCatalogPolicySha256: `sha256:${"c".repeat(64)}`,
    activatedCatalogPolicySha256: `sha256:${"d".repeat(64)}`,
    firstWriteReceiptSha256: `sha256:${"5".repeat(64)}`,
    observationSha256: `sha256:${"6".repeat(64)}`,
    transactionId: "42",
    postgresMajor: 17,
    migrationChecksum: `sha256:${"7".repeat(64)}`,
    permitEpoch: 1,
    permitNonce: "a".repeat(32),
    targetDeployIds: ["dep-target"],
  },
};
const basePorts = () => ({
  authority: {
    decide: vi.fn().mockImplementation(async (input) => ({
      ...input,
      decision: "allow",
      decisionId: "decision-1",
      decidedAt: "2026-08-12T00:00:00.000Z",
    })),
  },
  preflight: { observeProtectedEnvironment: vi.fn() },
  provider: { freezeAndObserve: vi.fn() },
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
    beginReleaseMigration: vi.fn().mockImplementation(async (input) => ({
      schemaVersion: 1,
      rolloutId: input.rolloutId,
      runId: input.runId,
      runAttempt: input.runAttempt,
      targetSystemIdentifier: input.targetSystemIdentifier,
      targetRecoveryWitnessSha256: input.targetRecoveryWitnessSha256,
      transitionSha256: input.transitionSha256,
      expectedPreviousReceiptSha256: input.expectedPreviousReceiptSha256,
      epoch: 1,
      nonce: "f".repeat(32),
    })),
    completeReleaseMigration: vi
      .fn()
      .mockImplementation(async (input) => input.receipt),
    failReleaseMigration: vi.fn().mockResolvedValue(undefined),
    loadReleaseMigrationCheckpoint: vi.fn().mockResolvedValue({
      targetManifestPhase: "pre_migration",
      permit: null,
      receipt: null,
    }),
    compareAndSet: vi.fn().mockResolvedValue(true),
    markActivationUncertain: vi.fn().mockResolvedValue(undefined),
    fenceTargetSwitch: vi.fn().mockImplementation(async (input) => ({
      schemaVersion: 1,
      ...input,
      nonce: "b".repeat(32),
      version: 1,
      fencedAt: "2026-08-12T00:00:00.000Z",
    })),
    authorizeActivation: vi.fn().mockResolvedValue({
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      postgresMajor: 17,
      migrationChecksum: "sha256:" + "7".repeat(64),
      transitionSha256: rollout.migrationTransition.transitionSha256,
      postManifestIdentity: rollout.migrationTransition.postManifestIdentity,
      epoch: 1,
      nonce: "a".repeat(32),
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      previousReceiptSha256: `sha256:${"2".repeat(64)}`,
      targetDeployIds: ["dep-target"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    }),
    finalizeActivation: vi.fn().mockResolvedValue(true),
    observeActivationState: vi.fn().mockResolvedValue("before"),
    verifyFinalAuthority: vi.fn().mockResolvedValue(true),
  },
});

const rolloutBeforeMigration = (): ReleaseRollout => ({
  ...rollout,
  phase: RolloutPhase.CutoverRunnerProvisioned,
  receipts: [
    {
      step: RolloutStep.ProvisionCutoverRunner,
      receiptId: `${rollout.rolloutId}:provision_cutover_runner:1`,
      observedAt: "2026-08-12T00:00:00.000Z",
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: 1,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: undefined,
      observationSha256: `sha256:${"2".repeat(64)}`,
      previousReceiptSha256: `sha256:${"0".repeat(64)}`,
      receiptSha256: `sha256:${"1".repeat(64)}`,
    },
  ],
});

describe("release rollout application boundary", () => {
  it.each([
    { stage: "freeze", phase: RolloutPhase.ProviderFrozen },
    { stage: "quiesce", phase: RolloutPhase.SourceQuiesced },
    { stage: "copy", phase: RolloutPhase.GenerationCopied },
    { stage: "bootstrap", phase: RolloutPhase.TargetRolesBootstrapped },
    { stage: "release migration", phase: RolloutPhase.MigrationApplied },
    { stage: "transition preflight", phase: RolloutPhase.MigrationApplied },
    { stage: "partial transition", phase: RolloutPhase.MigrationApplied },
  ])(
    "routes a definite failure after $stage through unified recovery",
    async ({ phase }) => {
      const ports = basePorts();
      const recover = vi.fn(async (failed: ReleaseRollout) => ({
        ...failed,
        phase: RolloutPhase.RecoveryCompensated,
      }));
      const useCases = new ReleaseRolloutUseCases({
        ...ports,
        compensation: { recover },
      });
      const result = await useCases.recoverFromFailure(
        { ...rollout, phase },
        "definite_pre_activation",
      );
      expect(result.phase).toBe(RolloutPhase.RecoveryCompensated);
      expect(recover).toHaveBeenCalledWith(
        expect.objectContaining({ phase: RolloutPhase.PreActivationFailed }),
      );
    },
  );

  it.each(["uncertain", "activated"] as const)(
    "never invokes source recovery when durable activation state is %s",
    async (state) => {
      const ports = basePorts();
      ports.ledger.observeActivationState.mockResolvedValue(state);
      const recover = vi.fn();
      await new ReleaseRolloutUseCases({
        ...ports,
        compensation: { recover },
      }).recoverFromFailure(rollout, "definite_pre_activation");
      expect(recover).not.toHaveBeenCalled();
      expect(ports.ledger.markActivationUncertain).toHaveBeenCalledOnce();
    },
  );
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

  it("uses durable begin/effect/complete and records only the trusted post manifest", async () => {
    const ports = basePorts();
    const beforeMigration = rolloutBeforeMigration();
    const runReleaseMigration = vi.fn(async (_target, transition, permit) => ({
      step: RolloutStep.RunReleaseMigration,
      observedAt: "2026-08-12T00:00:01.000Z",
      facts: {
        version: 3,
        status: "succeeded",
        migrationStatus: "succeeded",
        preflightStatus: "passed",
        aclGateState: "closed",
        commit: rollout.expectedCommitSha,
        imageDigest: transition.releaseImageDigest,
        roles: ["a", "b", "c", "d"],
        transitionSha256: transition.transitionSha256,
        migrationArtifactDigest: transition.migrationArtifactDigest,
        migrationBundleSha256: transition.migrationBundleSha256,
        preManifestIdentity: transition.preManifestIdentity,
        postManifestIdentity: transition.postManifestIdentity,
        postCatalogDigest: transition.postCatalogDigest,
        permitEpoch: permit.epoch,
        permitNonce: permit.nonce,
        targetSystemIdentifier: permit.targetSystemIdentifier,
        targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      },
    }));
    ports.database = { runReleaseMigration } as never;
    const useCases = new ReleaseRolloutUseCases(ports);
    const completed = await useCases.runReleaseMigration(beforeMigration);
    expect(completed.targetManifestPhase).toBe("post_migration");
    expect(ports.ledger.beginReleaseMigration).toHaveBeenCalledOnce();
    expect(ports.ledger.completeReleaseMigration).toHaveBeenCalledOnce();
    expect(ports.ledger.compareAndSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: RolloutStep.RunReleaseMigration }),
    );
    expect(completed.receipts.at(-1)).toMatchObject({
      migrationChecksum: rollout.migrationTransition.postManifestIdentity,
      transitionSha256: rollout.migrationTransition.transitionSha256,
      postManifestIdentity: rollout.migrationTransition.postManifestIdentity,
    });
    ports.ledger.loadReleaseMigrationCheckpoint.mockResolvedValue({
      targetManifestPhase: "post_migration",
      permit: completed.migrationPermit!,
      receipt: completed.receipts.at(-1),
    });
    runReleaseMigration.mockClear();
    const recovered = await useCases.runReleaseMigration(beforeMigration);
    expect(recovered.receipts.at(-1)?.receiptSha256).toBe(
      completed.receipts.at(-1)?.receiptSha256,
    );
    expect(runReleaseMigration).not.toHaveBeenCalled();
  });

  it("quarantines an effect failure and never attempts completion", async () => {
    const ports = basePorts();
    ports.database = {
      runReleaseMigration: vi.fn().mockRejectedValue(new Error("sql_failed")),
    } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).runReleaseMigration(
        rolloutBeforeMigration(),
      ),
    ).rejects.toThrow("sql_failed");
    expect(ports.ledger.failReleaseMigration).toHaveBeenCalledWith({
      permit: expect.objectContaining({
        transitionSha256: rollout.migrationTransition.transitionSha256,
      }),
      reasonSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(ports.ledger.completeReleaseMigration).not.toHaveBeenCalled();
  });

  it("quarantines a stale worker observation instead of accepting its digest", async () => {
    const ports = basePorts();
    ports.database = {
      runReleaseMigration: vi.fn().mockResolvedValue({
        ...observed(RolloutStep.RunReleaseMigration),
        facts: {
          migrationStatus: "succeeded",
          migrationChecksum: `sha256:${"f".repeat(64)}`,
        },
      }),
    } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).runReleaseMigration(
        rolloutBeforeMigration(),
      ),
    ).rejects.toThrow("migration_observation_invalid");
    expect(ports.ledger.failReleaseMigration).toHaveBeenCalledOnce();
    expect(ports.ledger.completeReleaseMigration).not.toHaveBeenCalled();
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

  it("does not install or activate when authorization identity mismatches", async () => {
    const ports = basePorts();
    ports.ledger.authorizeActivation.mockResolvedValue({
      rolloutId: "wrong-rollout",
      epoch: 1,
      nonce: "a".repeat(32),
      sourceSystemIdentifier: "1",
      targetSystemIdentifier: "2",
      previousReceiptSha256: `sha256:${"2".repeat(64)}`,
      targetDeployIds: ["dep-target"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    });
    const activate = vi.fn();
    ports.database = { activate } as never;
    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("activation_authorization_identity_mismatch");
    expect(activate).not.toHaveBeenCalled();
    expect(ports.ledger.markActivationUncertain).not.toHaveBeenCalled();
  });

  it("does not activate before Release Control confirms permit installation", async () => {
    const ports = basePorts();
    const activate = vi.fn();
    ports.database = { activate } as never;
    ports.ledger.authorizeActivation.mockRejectedValue(
      new Error("runner_ledger_request_failed:504"),
    );

    await expect(
      new ReleaseRolloutUseCases(ports).activateTargetGeneration(
        stagedRollout,
        "44",
      ),
    ).rejects.toThrow("runner_ledger_request_failed:504");

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

  it("finalizes activated authority with the target permit receipt", async () => {
    const ports = basePorts();
    ports.database = {
      activate: vi.fn().mockResolvedValue(activationObservation),
    } as never;
    const activated = await new ReleaseRolloutUseCases(
      ports,
    ).activateTargetGeneration(stagedRollout, "44");
    expect(activated.phase).toBe(RolloutPhase.TargetActivated);
    expect(activated.activationReceipt).toMatchObject({
      permitNonce: "a".repeat(32),
      permitEpoch: 1,
    });
    expect(ports.ledger.finalizeActivation).toHaveBeenCalledOnce();
    expect(ports.ledger.markActivationUncertain).not.toHaveBeenCalled();
  });

  it("denies provider resume before any effect when authority is absent or mismatched", async () => {
    const ports = basePorts();
    const resume = vi.fn();
    ports.services = { resumeDeployAndObserve: resume } as never;
    ports.authority.decide.mockRejectedValue(new Error("outage"));
    await expect(
      new ReleaseRolloutUseCases(ports).resumeTargetServices({
        ...stagedRollout,
        phase: RolloutPhase.CutoverRunnerCleaned,
        activated: true,
        sourcePermanentlyIneligible: true,
        activationReceipt: {} as never,
      }),
    ).rejects.toThrow("provider_authority_unavailable_or_denied");
    expect(resume).not.toHaveBeenCalled();
  });

  it("passes an activated receipt-bound decision to target resume", async () => {
    const ports = basePorts();
    const resumedRollout = {
      ...stagedRollout,
      phase: RolloutPhase.CutoverRunnerCleaned,
      activated: true,
      sourcePermanentlyIneligible: true,
      activationReceipt: {} as never,
    };
    ports.services = {
      resumeDeployAndObserve: vi.fn().mockResolvedValue({
        step: RolloutStep.ResumeTargetServices,
        observedAt: "2026-08-12T00:00:02.000Z",
        facts: [
          {
            serviceId: "srv-target",
            deployId: "dep-target",
            resumed: true,
            servicePostcondition: resumedPostcondition,
          },
        ],
        provider: {
          renderServiceIds: ["srv-target"],
          renderDeployIds: ["dep-target"],
        },
      }),
    } as never;
    await new ReleaseRolloutUseCases(ports).resumeTargetServices(
      resumedRollout,
    );
    expect(ports.authority.decide).toHaveBeenCalledWith({
      rolloutId: rollout.rolloutId,
      operation: ProviderAuthorityOperation.ResumeTarget,
      sourceSystemIdentifier: "1",
      targetSystemIdentifier: "2",
      expectedReceiptSha256: stagedRollout.receipts.at(-1)!.receiptSha256,
      activationBoundary: "activated",
    });
  });
});
