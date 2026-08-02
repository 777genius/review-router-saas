import { describe, expect, it } from "vitest";
import {
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../application/ports/investigation-store-port";
import {
  createInvestigationObligation,
  InvestigationObligationOrigin,
  obligationIdentity,
} from "../domain/investigation-obligation";
import { planInvestigationTurn, createReviewInvestigation, serializeReviewInvestigation } from "../domain/review-investigation";
import {
  InvestigationObligationKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationTurnPurpose,
} from "../domain/review-investigation-types";
import type { ReviewInvestigation } from "../domain/review-investigation";

export type InvestigationStoreContractHarness = Readonly<{
  store: InvestigationStorePort;
  restart(): Promise<InvestigationStorePort>;
  dispose(): Promise<void>;
}>;

export type InvestigationStoreContractFactory = (
  seed: ReviewInvestigation,
) => Promise<InvestigationStoreContractHarness>;

export function defineInvestigationStoreContract(
  name: string,
  factory: InvestigationStoreContractFactory,
): void {
  describe(`${name} InvestigationStorePort contract`, () => {
    it("restores duplicate commands before evaluating optimistic concurrency", async () => {
      const seed = createInvestigationStoreContractSeed("duplicate");
      const harness = await factory(seed);
      try {
        await expect(
          harness.store.commit({
            investigation: seed,
            expectedVersion: null,
            commandId: "command-open-duplicate",
            commandHash: "1".repeat(64),
            transition: { kind: InvestigationStoreTransitionKind.Opened },
          }),
        ).resolves.toMatchObject({
          status: InvestigationStoreCommitStatus.Committed,
        });
        await expect(
          harness.store.commit({
            investigation: seed,
            expectedVersion: null,
            commandId: "command-open-duplicate",
            commandHash: "1".repeat(64),
            transition: { kind: InvestigationStoreTransitionKind.Opened },
          }),
        ).resolves.toMatchObject({
          status: InvestigationStoreCommitStatus.Restored,
          investigation: { version: 1 },
        });
        await expect(
          harness.store.restoreCommand({
            commandId: "command-open-duplicate",
            commandHash: "2".repeat(64),
          }),
        ).resolves.toEqual({
          status: InvestigationStoreCommitStatus.IdempotencyConflict,
          investigation: null,
        });
      } finally {
        await harness.dispose();
      }
    });

    it("rejects stale writers and restores byte-identical state after restart", async () => {
      const seed = createInvestigationStoreContractSeed("restart");
      const harness = await factory(seed);
      try {
        await harness.store.commit({
          investigation: seed,
          expectedVersion: null,
          commandId: "command-open-restart",
          commandHash: "3".repeat(64),
          transition: { kind: InvestigationStoreTransitionKind.Opened },
        });
        const first = planned(seed, "turn-first-restart");
        await expect(
          harness.store.commit({
            investigation: first,
            expectedVersion: 1,
            commandId: "command-plan-first",
            commandHash: "4".repeat(64),
            transition: {
              kind: InvestigationStoreTransitionKind.TurnPlanned,
              turnId: first.activeTurn!.turnId,
            },
          }),
        ).resolves.toMatchObject({
          status: InvestigationStoreCommitStatus.Committed,
        });

        const restarted = await harness.restart();
        const restored = await restarted.findById(seed.investigationId);
        expect(restored).not.toBeNull();
        expect(serializeReviewInvestigation(restored!)).toBe(
          serializeReviewInvestigation(first),
        );

        const stale = planned(seed, "turn-stale-restart");
        await expect(
          restarted.commit({
            investigation: stale,
            expectedVersion: 1,
            commandId: "command-plan-stale",
            commandHash: "5".repeat(64),
            transition: {
              kind: InvestigationStoreTransitionKind.TurnPlanned,
              turnId: stale.activeTurn!.turnId,
            },
          }),
        ).resolves.toMatchObject({
          status: InvestigationStoreCommitStatus.ConcurrencyConflict,
          investigation: { version: 2 },
        });
      } finally {
        await harness.dispose();
      }
    });
  });
}

export function createInvestigationStoreContractSeed(
  suffix: string,
): ReviewInvestigation {
  const identity = obligationIdentity({
    coverageContractVersion: "coverage-v1",
    stableReviewUnitKey: `stable-unit-${suffix}`,
    kind: InvestigationObligationKind.InventoryWitness,
    canonicalSubject: `inventory:${suffix}`,
    canonicalRequirement: "match canonical inventory witness",
  });
  const obligation = createInvestigationObligation({
    obligationId: digest(`obligation-${suffix}`),
    identity,
    riskPriority: 100,
    origin: InvestigationObligationOrigin.CoverageContract,
  });
  return createReviewInvestigation({
    investigationId: `investigation-contract-${suffix}`,
    naturalIdentityHash: digest(`identity-${suffix}`),
    scope: {
      workspaceId: `workspace-${suffix}`,
      repositoryConnectionId: `connection-${suffix}`,
      scmRepositoryIdentityId: `repository-${suffix}`,
      pullRequestNumber: 42,
      trustDomain: "trusted-local",
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: digest(`revision-${suffix}`),
    },
    executionId: `execution-contract-${suffix}`,
    workSlotId: `slot-contract-${suffix}`,
    stableReviewUnitKey: `stable-unit-${suffix}`,
    providerVoteLaneId: "lane-codex",
    providerStrategyId: "strategy-single-provider",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "gateway-v4",
      producerReleaseId: "producer-test",
      runtimeProfileVersion: "runtime-v1",
    },
    policy: {
      policyId: "contract-v1",
      maxObligations: 100,
      maxExpansionDepth: 5,
      maxSemanticTurns: 5,
      maxOperationalAttempts: 3,
      maxCriticCycles: 2,
      maxFindings: 20,
      maxProposalsPerTurn: 20,
      maxReceiptsPerTurn: 50,
    },
    obligations: [obligation],
    dossierDigest: digest(`dossier-${suffix}`),
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
  });
}

function planned(
  investigation: ReviewInvestigation,
  turnId: string,
): ReviewInvestigation {
  return planInvestigationTurn({
    investigation,
    turn: {
      turnId,
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      leasedAtVersion: investigation.version + 1,
      dossierDigest: investigation.dossierDigest,
      obligationIds: investigation.obligations.map((item) => item.obligationId),
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: "2026-08-02T10:01:00.000Z",
      expiresAt: "2026-08-02T10:02:00.000Z",
    },
  });
}

function digest(value: string): string {
  let output = "";
  for (let index = 0; index < 64; index += 1) {
    output += ((value.charCodeAt(index % value.length) + index) % 16).toString(16);
  }
  return output;
}
