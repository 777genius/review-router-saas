import { describe, expect, it, vi } from "vitest";
import type {
  ProviderAuthorityDecision,
  RecoveryEffectAuthorityPort,
} from "../../packages/features/release-rollout/src/index";
import { createPrivatePg17SourceFreezeRecovery } from "./private-pg17-source-freeze-recovery";

const observedAt = "2026-08-14T00:00:00.000Z";
const serviceId = "srv-source";
const sourceFreeze = {
  status: "complete" as const,
  serviceIds: [serviceId],
  services: [
    {
      serviceId,
      latestSuccessfulDeployId: "dep-source",
      observedAt,
    },
  ],
};
const decision: ProviderAuthorityDecision = {
  rolloutId: "rollout-source-freeze",
  operation: "resume_source",
  sourceSystemIdentifier: "16123",
  targetSystemIdentifier: "17123",
  expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
  activationBoundary: "before",
  decision: "allow",
  decisionId: "decision-source-freeze",
  decidedAt: observedAt,
};
const databaseWitness = {
  systemIdentifier: "16123",
  aclSha256: `sha256:${"b".repeat(64)}`,
  observedAt,
  sourceWritesRestored: true as const,
};

describe("private PG17 source-freeze recovery composition", () => {
  it("uses the checkpoint-backed transition recovery after ledger.begin", async () => {
    const transitionWitness = {
      serviceIds: [serviceId],
      deployIds: ["dep-restored"],
      observedAt,
      resumed: true as const,
    };
    const beforeResume = vi.fn().mockResolvedValue(transitionWitness);
    const recovery = createPrivatePg17SourceFreezeRecovery({
      ledger: {} as RecoveryEffectAuthorityPort,
      ownerId: "recovery-owner",
      apiKey: "unused-in-transition-path",
      sourceSystemIdentifier: "16123",
      beforeResume,
    });

    await expect(
      recovery.recoverSourceFreeze({
        decision,
        databaseWitness,
        sourceWriterServiceIds: [serviceId],
        sourceFreeze,
        activationBoundary: "before",
      }),
    ).resolves.toEqual(transitionWitness);
    expect(beforeResume).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "activated"] as const)(
    "rejects activation %s before invoking transition recovery",
    async (activationBoundary) => {
      const beforeResume = vi.fn();
      const recovery = createPrivatePg17SourceFreezeRecovery({
        ledger: {} as RecoveryEffectAuthorityPort,
        ownerId: "recovery-owner",
        apiKey: "must-not-be-used",
        sourceSystemIdentifier: "16123",
        beforeResume,
      });

      await expect(
        recovery.recoverSourceFreeze({
          decision,
          databaseWitness,
          sourceWriterServiceIds: [serviceId],
          sourceFreeze,
          activationBoundary,
        }),
      ).rejects.toThrow(`private_pg17_source_freeze_forward_only`);
      expect(beforeResume).not.toHaveBeenCalled();
    },
  );
});
