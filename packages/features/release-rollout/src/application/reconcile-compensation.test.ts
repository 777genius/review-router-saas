import { describe, expect, it, vi } from "vitest";
import {
  createReleaseRollout,
  RolloutPhase,
  RolloutStep,
  transitionFailure,
} from "../domain/release-rollout";
import {
  ReleaseCompensationReconciliationUseCase,
  reconcileCompensationSafety,
} from "./reconcile-compensation";
import type { CompensationCheckpoint } from "./ports";
import { createReleaseMigrationTransition } from "../domain/release-migration-transition";

const rollout = createReleaseRollout({
  rolloutId: "rollout-reconcile-test",
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
const databaseWitness = {
  systemIdentifier: "1",
  aclSha256: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-08-13T00:00:00.000Z",
  sourceWritesRestored: true as const,
};
const providerWitness = {
  serviceIds: ["srv-source"],
  deployIds: ["dep-source"],
  observedAt: "2026-08-13T00:00:01.000Z",
  resumed: true as const,
};

function ports(initial: {
  activationBoundary: "before" | "uncertain" | "activated";
  state: "pre_activation" | "compensating" | "compensated" | "activated";
  lastStep: string | null;
  receiptCount: number;
  sourceFreeze?: CompensationCheckpoint["sourceFreeze"];
}) {
  let checkpoint: CompensationCheckpoint = {
    ...initial,
    lastReceiptSha256: `sha256:${"0".repeat(64)}`,
    sourceFreeze: initial.sourceFreeze ?? {
      status: "complete" as const,
      serviceIds: ["srv-source"],
      services: [
        {
          serviceId: "srv-source",
          latestSuccessfulDeployId: "dep-source",
          observedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    },
  };
  const compareAndSet = vi.fn().mockImplementation(async (input) => {
    checkpoint = {
      ...checkpoint,
      state:
        input.step === RolloutStep.CompleteCompensation
          ? "compensated"
          : "compensating",
      lastStep: input.step,
      lastReceiptSha256: input.nextReceiptSha256,
      receiptCount: checkpoint.receiptCount + 1,
    };
    return true;
  });
  let recoveryEffect:
    | import("../domain/recovery-effect").RecoveryEffectRecord
    | undefined;
  return {
    recoveryOwnerId: "test-recovery-owner",
    authority: {
      decide: vi.fn().mockImplementation(async (input) => ({
        ...input,
        decision: "allow",
        decisionId: "decision-1",
        decidedAt: "2026-08-13T00:00:00.000Z",
      })),
    },
    ledger: {
      observeCompensationCheckpoint: vi.fn(async () => checkpoint),
      compareAndSet,
      reconcileRollout: vi.fn().mockResolvedValue({ state: "ok" }),
      listProvisioningIntents: vi.fn().mockResolvedValue([
        {
          id: "intent-role",
          effect: {
            state: "cleaned",
            ownerId: "owner-role",
            epoch: 2,
            providerId: "job-role",
            safeForCompensation: true,
          },
        },
      ]),
      intendRecoveryEffect: vi.fn(
        async (input) =>
          (recoveryEffect ??= {
            ...input,
            serviceId: null,
            state: "intended",
            epoch: 0,
            claimOwnerId: null,
            permitToken: null,
            leaseExpiresAt: null,
            consumedAt: null,
            completedAt: null,
            observation: null,
          }),
      ),
      claimRecoveryEffect: vi.fn(
        async (input) =>
          (recoveryEffect = {
            ...recoveryEffect!,
            state: "claimed",
            epoch: recoveryEffect!.epoch + 1,
            claimOwnerId: input.ownerId,
            permitToken: "a".repeat(64),
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      ),
      consumeRecoveryEffectPermit: vi.fn(async (input) => {
        recoveryEffect = {
          ...recoveryEffect!,
          state: "consumed",
          leaseExpiresAt: null,
          consumedAt: new Date().toISOString(),
        };
        return {
          record: recoveryEffect,
          executionAuthorization: {
            receipt: "b".repeat(64),
            rolloutId: input.rolloutId,
            effectKey: input.effectKey,
            kind: input.kind,
            ownerId: input.ownerId,
            epoch: input.epoch,
            permitToken: input.permitToken,
          },
        };
      }),
      validateRecoveryEffectExecution: vi.fn(async (input) => {
        recoveryEffect = { ...recoveryEffect!, state: "executing" };
        return {
          record: recoveryEffect,
          executionAuthorization: {
            receipt: input.executionReceipt,
            rolloutId: input.rolloutId,
            effectKey: input.effectKey,
            kind: input.kind,
            ownerId: input.ownerId,
            epoch: input.epoch,
            permitToken: input.permitToken,
          },
        };
      }),
      completeRecoveryEffect: vi.fn(
        async (input) =>
          (recoveryEffect = {
            ...recoveryEffect!,
            state: "completed",
            completedAt: new Date().toISOString(),
            observation: input.observation,
          }),
      ),
      reconcileRecoveryEffect: vi.fn(
        async (input) =>
          (recoveryEffect = {
            ...recoveryEffect!,
            state: "forward_repair",
            completedAt: new Date().toISOString(),
            observation: input.observation,
          }),
      ),
    },
    compensateDatabase: vi.fn().mockResolvedValue(databaseWitness),
    observeDatabaseCompensation: vi.fn().mockResolvedValue(null),
    provider: {
      recoveryEffectsAreAuthorityMediated: true as const,
      recoverSourceFreeze: vi.fn().mockResolvedValue(providerWitness),
    },
  };
}

describe("release compensation reconciliation", () => {
  it.each([
    {
      stage: "freeze",
      phase: RolloutPhase.ProviderFrozen,
      lastStep: RolloutStep.FreezeProviderServices,
    },
    {
      stage: "quiesce",
      phase: RolloutPhase.SourceQuiesced,
      lastStep: RolloutStep.QuiesceSource,
    },
    {
      stage: "copy",
      phase: RolloutPhase.GenerationCopied,
      lastStep: RolloutStep.CopyDatabaseGeneration,
    },
    {
      stage: "bootstrap",
      phase: RolloutPhase.TargetRolesBootstrapped,
      lastStep: RolloutStep.BootstrapTargetRoles,
    },
    {
      stage: "release migration",
      phase: RolloutPhase.MigrationApplied,
      lastStep: RolloutStep.RunReleaseMigration,
    },
    {
      stage: "transition preflight",
      phase: RolloutPhase.MigrationApplied,
      lastStep: RolloutStep.RunReleaseMigration,
    },
    {
      stage: "partial transition",
      phase: RolloutPhase.MigrationApplied,
      lastStep: RolloutStep.StageTargetServices,
    },
  ] as const)(
    "returns the compensated aggregate after a $stage fault",
    async ({ phase, lastStep }) => {
      const dependencies = ports({
        activationBoundary: "before",
        state: "pre_activation",
        lastStep,
        receiptCount: 3,
      });
      const recovered = await new ReleaseCompensationReconciliationUseCase(
        dependencies,
      ).recover(
        transitionFailure({ ...rollout, phase }, "definite_pre_activation"),
      );
      expect(recovered.phase).toBe(RolloutPhase.RecoveryCompensated);
      expect(dependencies.provider.recoverSourceFreeze).toHaveBeenCalledOnce();
    },
  );

  it("compensates a crash after freeze and appends complete receipts", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
    });
    const result = await new ReleaseCompensationReconciliationUseCase(
      dependencies,
    ).execute(rollout);
    expect(result.outcome).toBe("compensated");
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledTimes(3);
    expect(dependencies.authority.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "resume_source",
        activationBoundary: "before",
      }),
    );
  });

  it("is an exact no-effect retry after compensation completed", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "compensated",
      lastStep: RolloutStep.CompleteCompensation,
      receiptCount: 6,
    });
    await new ReleaseCompensationReconciliationUseCase(dependencies).execute(
      rollout,
    );
    expect(dependencies.ledger.compareAndSet).not.toHaveBeenCalled();
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    expect(dependencies.provider.recoverSourceFreeze).not.toHaveBeenCalled();
  });

  it("stays forward-only after activation", async () => {
    const dependencies = ports({
      activationBoundary: "activated",
      state: "activated",
      lastStep: RolloutStep.ActivateTargetGeneration,
      receiptCount: 14,
    });
    const result = await new ReleaseCompensationReconciliationUseCase(
      dependencies,
    ).execute(rollout);
    expect(result.outcome).toBe("forward_only");
    expect(dependencies.authority.decide).not.toHaveBeenCalled();
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
  });

  it("completes an incomplete compensation without repeating effects", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "compensating",
      lastStep: RolloutStep.EffectCompensation,
      receiptCount: 5,
    });
    await new ReleaseCompensationReconciliationUseCase(dependencies).execute(
      rollout,
    );
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledTimes(1);
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledWith(
      expect.objectContaining({ step: RolloutStep.CompleteCompensation }),
    );
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
  });

  it.each([["prepared"], ["dispatching"], ["bound"], ["blocked"]] as const)(
    "denies compensation while an intent is %s",
    async (state) => {
      const dependencies = ports({
        activationBoundary: "before",
        state: "pre_activation",
        lastStep: RolloutStep.FreezeProviderServices,
        receiptCount: 3,
      });
      dependencies.ledger.listProvisioningIntents.mockResolvedValue([
        {
          id: "intent-role",
          effect: {
            state,
            ownerId: "owner-role",
            epoch: 1,
            providerId: state === "bound" ? "job-role" : null,
            safeForCompensation: false,
          },
        },
      ]);
      await expect(
        new ReleaseCompensationReconciliationUseCase(dependencies).execute(
          rollout,
        ),
      ).resolves.toMatchObject({
        outcome: "denied",
        externalEffects: { safeForCompensation: false },
      });
      expect(dependencies.ledger.compareAndSet).not.toHaveBeenCalled();
      expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    },
  );

  it("denies missing and duplicate evidence", () => {
    expect(reconcileCompensationSafety([])).toMatchObject({
      result: "blocked",
      reason: "missing_evidence",
      safeForCompensation: false,
    });
    const effect = {
      state: "abandoned" as const,
      ownerId: "owner-role",
      epoch: 0,
      providerId: null,
      safeForCompensation: true,
    };
    expect(
      reconcileCompensationSafety([
        { id: "same", effect },
        { id: "same", effect },
      ]),
    ).toMatchObject({
      result: "blocked",
      reason: "duplicate",
      safeForCompensation: false,
    });
  });

  it("allows zero intents only with durable partial freeze mutation evidence", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
      sourceFreeze: {
        status: "partial",
        serviceIds: ["srv-source"],
        services: [
          {
            serviceId: "srv-source",
            latestSuccessfulDeployId: "dep-source",
            observedAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      },
    });
    dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);
    await expect(
      new ReleaseCompensationReconciliationUseCase(dependencies).execute(
        rollout,
      ),
    ).resolves.toMatchObject({
      outcome: "compensated",
      externalEffects: { intentCount: 0 },
    });
    expect(dependencies.provider.recoverSourceFreeze).toHaveBeenCalledWith(
      expect.objectContaining({ sourceWriterServiceIds: ["srv-source"] }),
    );
    expect(
      dependencies.ledger.observeCompensationCheckpoint.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.ledger.listProvisioningIntents.mock.invocationCallOrder[0]!,
    );
    expect(
      dependencies.ledger.listProvisioningIntents.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.provider.recoverSourceFreeze.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["first", ["srv-a"]],
    ["middle", ["srv-a", "srv-b"]],
  ] as const)(
    "resumes exactly the durably observed services after failure following the %s suspend",
    async (_position, serviceIds) => {
      const dependencies = ports({
        activationBoundary: "before",
        state: "pre_activation",
        lastStep: RolloutStep.VerifyProtectedEnvironment,
        receiptCount: 2,
        sourceFreeze: {
          status: "partial",
          serviceIds: [...serviceIds],
          services: serviceIds.map((serviceId) => ({
            serviceId,
            latestSuccessfulDeployId: `dep-${serviceId}`,
            observedAt: "2026-08-13T00:00:00.000Z",
          })),
        },
      });
      dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);
      await new ReleaseCompensationReconciliationUseCase(dependencies).execute(
        rollout,
      );
      expect(dependencies.provider.recoverSourceFreeze).toHaveBeenCalledWith(
        expect.objectContaining({ sourceWriterServiceIds: [...serviceIds] }),
      );
    },
  );

  it("never forwards a pre-suspended unchanged service to the provider", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
      sourceFreeze: {
        status: "complete",
        serviceIds: ["srv-mutated-a", "srv-mutated-b"],
        services: ["srv-mutated-a", "srv-mutated-b"].map((serviceId) => ({
          serviceId,
          latestSuccessfulDeployId: `dep-${serviceId}`,
          observedAt: "2026-08-13T00:00:00.000Z",
        })),
      },
    });
    dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);

    await new ReleaseCompensationReconciliationUseCase(dependencies).execute(
      rollout,
    );

    expect(dependencies.provider.recoverSourceFreeze).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceWriterServiceIds: ["srv-mutated-a", "srv-mutated-b"],
      }),
    );
    expect(
      dependencies.provider.recoverSourceFreeze.mock.calls[0]?.[0]
        .sourceWriterServiceIds,
    ).not.toContain("srv-pre-suspended");
  });

  it.each(["unknown"] as const)(
    "denies zero intents when freeze evidence is %s",
    async (status) => {
      const dependencies = ports({
        activationBoundary: "before",
        state: "pre_activation",
        lastStep: RolloutStep.VerifyProtectedEnvironment,
        receiptCount: 2,
      });
      dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);
      dependencies.ledger.observeCompensationCheckpoint.mockResolvedValue({
        activationBoundary: "before",
        state: "pre_activation",
        lastStep: RolloutStep.VerifyProtectedEnvironment,
        receiptCount: 2,
        lastReceiptSha256: `sha256:${"0".repeat(64)}`,
        sourceFreeze: { status, serviceIds: [], services: [] },
      });
      await expect(
        new ReleaseCompensationReconciliationUseCase(dependencies).execute(
          rollout,
        ),
      ).resolves.toMatchObject({
        outcome: "denied",
        externalEffects: { reason: "missing_evidence" },
      });
      expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    },
  );

  it("returns a durable retryable denial for unknown nonempty freeze evidence", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
      sourceFreeze: {
        status: "unknown",
        serviceIds: ["srv-source"],
        services: [
          {
            serviceId: "srv-source",
            latestSuccessfulDeployId: "dep-source",
            observedAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      },
    });
    dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);
    const useCase = new ReleaseCompensationReconciliationUseCase(dependencies);
    await expect(useCase.execute(rollout)).resolves.toMatchObject({
      outcome: "denied",
      externalEffects: { reason: "missing_evidence" },
    });
    await expect(useCase.execute(rollout)).resolves.toMatchObject({
      outcome: "denied",
      externalEffects: { reason: "missing_evidence" },
    });
    expect(
      dependencies.ledger.observeCompensationCheckpoint,
    ).toHaveBeenCalledTimes(2);
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    expect(dependencies.ledger.compareAndSet).not.toHaveBeenCalled();
  });

  it("treats proven no source mutation and zero runner intents as a no-op", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
    });
    dependencies.ledger.listProvisioningIntents.mockResolvedValue([]);
    dependencies.ledger.observeCompensationCheckpoint.mockResolvedValue({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.VerifyProtectedEnvironment,
      receiptCount: 2,
      lastReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceFreeze: { status: "none", serviceIds: [], services: [] },
    });
    await expect(
      new ReleaseCompensationReconciliationUseCase(dependencies).execute(
        rollout,
      ),
    ).resolves.toMatchObject({ outcome: "no_op" });
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    expect(dependencies.provider.recoverSourceFreeze).not.toHaveBeenCalled();
    expect(dependencies.ledger.reconcileRollout).not.toHaveBeenCalled();
  });

  it("keeps source frozen on timeout evidence", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "compensating",
      lastStep: RolloutStep.BeginCompensation,
      receiptCount: 4,
    });
    dependencies.ledger.listProvisioningIntents.mockResolvedValue([
      {
        id: "intent-role",
        effect: {
          state: "blocked",
          ownerId: "owner-role",
          epoch: 1,
          providerId: null,
          safeForCompensation: false,
          reconciliation: {
            result: "blocked",
            safeForCompensation: false,
            reason: "timeout",
          },
        },
      },
    ]);
    const result = await new ReleaseCompensationReconciliationUseCase(
      dependencies,
    ).execute(rollout);
    expect(result).toMatchObject({
      outcome: "denied",
      externalEffects: { result: "blocked", reason: "timeout" },
    });
    expect(dependencies.authority.decide).not.toHaveBeenCalled();
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
  });

  it("denies a late unsafe identity after begin before any recovery effect", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "pre_activation",
      lastStep: RolloutStep.FreezeProviderServices,
      receiptCount: 3,
    });
    const safe = await dependencies.ledger.listProvisioningIntents();
    dependencies.ledger.listProvisioningIntents
      .mockResolvedValueOnce(safe)
      .mockResolvedValue([
        {
          id: "intent-role",
          effect: {
            state: "blocked",
            ownerId: "owner-role",
            epoch: 2,
            providerId: "job-late",
            safeForCompensation: false,
            reconciliation: {
              result: "blocked",
              safeForCompensation: false,
              reason: "duplicate",
            },
          },
        },
      ]);

    await expect(
      new ReleaseCompensationReconciliationUseCase(dependencies).execute(
        rollout,
      ),
    ).resolves.toMatchObject({
      outcome: "denied",
      externalEffects: { reason: "duplicate", safeForCompensation: false },
    });
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledTimes(1);
    expect(dependencies.authority.decide).not.toHaveBeenCalled();
    expect(dependencies.compensateDatabase).not.toHaveBeenCalled();
    expect(dependencies.provider.recoverSourceFreeze).not.toHaveBeenCalled();
  });

  it("does not complete when a late unsafe identity follows the recovery effect", async () => {
    const dependencies = ports({
      activationBoundary: "before",
      state: "compensating",
      lastStep: RolloutStep.BeginCompensation,
      receiptCount: 4,
    });
    const safe = await dependencies.ledger.listProvisioningIntents();
    const blocked = [
      {
        id: "intent-role",
        effect: {
          state: "blocked",
          ownerId: "owner-role",
          epoch: 2,
          providerId: "job-late",
          safeForCompensation: false,
          reconciliation: {
            result: "blocked" as const,
            safeForCompensation: false,
            reason: "duplicate" as const,
          },
        },
      },
    ];
    dependencies.ledger.listProvisioningIntents
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce(safe)
      .mockResolvedValue(blocked);

    await expect(
      new ReleaseCompensationReconciliationUseCase(dependencies).execute(
        rollout,
      ),
    ).resolves.toMatchObject({
      outcome: "denied",
      externalEffects: { reason: "duplicate", safeForCompensation: false },
    });
    expect(dependencies.compensateDatabase).toHaveBeenCalledTimes(1);
    expect(dependencies.provider.recoverSourceFreeze).toHaveBeenCalledTimes(1);
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledTimes(1);
    expect(dependencies.ledger.compareAndSet).toHaveBeenCalledWith(
      expect.objectContaining({ step: RolloutStep.EffectCompensation }),
    );
    expect(dependencies.ledger.reconcileRollout).not.toHaveBeenCalled();
  });
});
