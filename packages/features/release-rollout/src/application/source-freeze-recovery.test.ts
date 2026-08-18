import { describe, expect, it, vi } from "vitest";
import {
  RecoveryEffectState,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";
import { SourceFreezeRecoveryUseCase } from "./source-freeze-recovery";

const now = "2026-08-14T00:00:00.000Z";
const service = {
  serviceId: "srv-source",
  latestSuccessfulDeployId: "dep-source",
  observedAt: now,
};
const checkpoint = (
  activationBoundary: "before" | "uncertain" | "activated" = "before",
) => ({
  activationBoundary,
  state:
    activationBoundary === "before"
      ? ("compensating" as const)
      : ("outcome_unknown" as const),
  lastReceiptSha256: `sha256:${"a".repeat(64)}`,
  lastStep: "begin_compensation",
  receiptCount: 4,
  sourceFreeze: {
    status: "complete" as const,
    serviceIds: [service.serviceId],
    services: [service],
  },
});

function harness() {
  let record: RecoveryEffectRecord | undefined;
  const base = (
    state: RecoveryEffectRecord["state"],
  ): RecoveryEffectRecord => ({
    rolloutId: "rollout-source-freeze",
    effectKey: "resume_source_service:srv-source",
    kind: "resume_source_service",
    serviceId: "srv-source",
    state,
    epoch: state === RecoveryEffectState.Intended ? 0 : 1,
    claimOwnerId:
      state === RecoveryEffectState.Intended ? null : "recovery-owner",
    permitToken: state === RecoveryEffectState.Intended ? null : "b".repeat(64),
    leaseExpiresAt:
      state === RecoveryEffectState.Claimed ? "2099-01-01T00:00:00.000Z" : null,
    consumedAt:
      state === RecoveryEffectState.Consumed ||
      state === RecoveryEffectState.Executing ||
      state === RecoveryEffectState.Completed
        ? now
        : null,
    completedAt: state === RecoveryEffectState.Completed ? now : null,
    observation:
      state === RecoveryEffectState.Completed
        ? {
            serviceId: "srv-source",
            resumed: true,
            serviceContractSha256: `sha256:${"c".repeat(64)}`,
            environmentSha256: `sha256:${"d".repeat(64)}`,
          }
        : null,
  });
  const authorization = {
    receipt: "e".repeat(64),
    rolloutId: "rollout-source-freeze",
    effectKey: "resume_source_service:srv-source",
    kind: "resume_source_service" as const,
    ownerId: "recovery-owner",
    epoch: 1,
    permitToken: "b".repeat(64),
  };
  const authority = {
    intendRecoveryEffect: vi.fn(
      async () => (record ??= base(RecoveryEffectState.Intended)),
    ),
    claimRecoveryEffect: vi.fn(
      async () => (record = base(RecoveryEffectState.Claimed)),
    ),
    consumeRecoveryEffectPermit: vi.fn(async () => ({
      record: (record = base(RecoveryEffectState.Consumed)),
      executionAuthorization: authorization,
    })),
    validateRecoveryEffectExecution: vi.fn(async () => ({
      record: (record = base(RecoveryEffectState.Executing)),
      executionAuthorization: authorization,
    })),
    completeRecoveryEffect: vi.fn(
      async () => (record = base(RecoveryEffectState.Completed)),
    ),
    reconcileRecoveryEffect: vi.fn(
      async () => (record = base(RecoveryEffectState.Completed)),
    ),
  };
  const observed = {
    serviceId: service.serviceId,
    suspended: false,
    configurationSha256: `sha256:${"c".repeat(64)}`,
    environmentSha256: `sha256:${"d".repeat(64)}`,
    provenance: {
      kind: "source_revision" as const,
      revision: "f".repeat(40),
      deploymentId: "dep-source",
    },
  };
  const providerIo = vi.fn(async () => observed);
  const provider = {
    resumeFrozenSourceService: vi.fn(async ({ executeAuthorized }) =>
      executeAuthorized(providerIo),
    ),
    observeFrozenSourceService: vi.fn(async () => null),
  };
  return {
    authority,
    provider,
    providerIo,
    useCase: new SourceFreezeRecoveryUseCase({
      ownerId: "recovery-owner",
      authority,
      provider,
    }),
  };
}

const decision = {
  rolloutId: "rollout-source-freeze",
  operation: "resume_source" as const,
  sourceSystemIdentifier: "16123",
  targetSystemIdentifier: "17123",
  expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
  activationBoundary: "before" as const,
  decision: "allow" as const,
  decisionId: "decision-source-freeze",
  decidedAt: now,
};
const databaseWitness = {
  systemIdentifier: "16123",
  aclSha256: `sha256:${"f".repeat(64)}`,
  observedAt: now,
  sourceWritesRestored: true as const,
};

describe("authority-mediated source-freeze recovery", () => {
  it.each([
    { scenario: "before a service-transition contract", receiptCount: 0 },
    {
      scenario: "after transition preflight but before begin",
      receiptCount: 4,
    },
  ])(
    "recovers from durable freeze evidence $scenario",
    async ({ receiptCount }) => {
      const test = harness();
      const durableCheckpoint = { ...checkpoint(), receiptCount };
      const result = await test.useCase.execute({
        checkpoint: durableCheckpoint,
        decision,
        databaseWitness,
      });
      expect(result).toMatchObject({
        decision: { outcome: "recover" },
        witness: { resumed: true },
      });
      expect(test.provider.resumeFrozenSourceService).toHaveBeenCalledOnce();
      expect(
        test.authority.validateRecoveryEffectExecution.mock
          .invocationCallOrder[0],
      ).toBeLessThan(test.providerIo.mock.invocationCallOrder[0]!);
    },
  );

  it("is an exact replay and does not repeat provider I/O", async () => {
    const test = harness();
    await test.useCase.execute({
      checkpoint: checkpoint(),
      decision,
      databaseWitness,
    });
    await test.useCase.execute({
      checkpoint: checkpoint(),
      decision,
      databaseWitness,
    });
    expect(test.provider.resumeFrozenSourceService).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "activated"] as const)(
    "never consumes a permit or resumes source when activation is %s",
    async (activationBoundary) => {
      const test = harness();
      const result = await test.useCase.execute({
        checkpoint: checkpoint(activationBoundary),
        decision,
        databaseWitness,
      });
      expect(result.decision.outcome).toBe("forward_only");
      expect(test.authority.intendRecoveryEffect).not.toHaveBeenCalled();
      expect(test.provider.resumeFrozenSourceService).not.toHaveBeenCalled();
    },
  );

  it("does not resume when authority detects uncertainty after permit consumption", async () => {
    const test = harness();
    test.authority.validateRecoveryEffectExecution.mockRejectedValueOnce(
      new Error("recovery_effect_execution_not_authorized"),
    );

    await expect(
      test.useCase.execute({
        checkpoint: checkpoint(),
        decision,
        databaseWitness,
      }),
    ).rejects.toThrow("recovery_effect_execution_not_authorized");
    expect(test.authority.consumeRecoveryEffectPermit).toHaveBeenCalledOnce();
    expect(test.providerIo).not.toHaveBeenCalled();
  });
});
