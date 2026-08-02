import { createHash, randomUUID } from "node:crypto";
import {
  ReviewProviderKindV2,
  ReviewTaskKindV2,
  type PrismaClient,
} from "@prisma/client";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it } from "vitest";
import {
  InvestigationPrivateMaterialPersistenceStatus,
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
} from "../index";
import { AesGcmInvestigationPrivateMaterialCipher } from "../infrastructure/crypto/aes-gcm-investigation-private-material-cipher";
import { PrismaInvestigationStore } from "../infrastructure/prisma/prisma-investigation-store";
import {
  createInvestigationStoreContractSeed,
  defineInvestigationStoreContract,
  type InvestigationStoreContractHarness,
} from "../testing/investigation-store-contract";
import {
  abortInvestigationTurn,
  commitInvestigationTurn,
  planInvestigationTurn,
  type ReviewInvestigation,
} from "../domain/review-investigation";
import {
  InvestigationReceiptKind,
  type InvestigationEvidenceReceipt,
} from "../domain/investigation-obligation";
import {
  ReviewInvestigationAbortReason,
  ReviewInvestigationTurnPurpose,
} from "../domain/review-investigation-types";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

if (databaseUrl) {
  defineInvestigationStoreContract("PrismaInvestigationStore", async (seed) =>
    createHarness(seed),
  );
} else {
  describe.skip("PrismaInvestigationStore InvestigationStorePort contract", () => {
    it("requires REVIEW_ROUTER_TEST_DATABASE_URL", () => undefined);
  });
}

describeDatabase("PrismaInvestigationStore PostgreSQL invariants", () => {
  it("encrypts, expires, and prunes private material", async () => {
    const seed = createInvestigationStoreContractSeed(
      `private-${randomUUID()}`,
    );
    const harness = await createHarness(seed, 1_000);
    try {
      const store = harness.store as PrismaInvestigationStore;
      await open(store, seed, "private-open");
      const cipher = new AesGcmInvestigationPrivateMaterialCipher(
        "key-1",
        new Map([["key-1", Buffer.alloc(32, 9)]]),
      );
      const material = await cipher.encrypt({
        privateMaterialId: `private-${randomUUID()}`,
        investigationId: seed.investigationId,
        obligationId: seed.obligations[0]!.obligationId,
        plaintextCanonicalJson: '{"query":"sensitive symbol"}',
        associatedDataCanonicalJson: `{"investigationId":"${seed.investigationId}"}`,
        createdAt: "2026-08-02T10:00:00.000Z",
        expiresAt: "2026-08-02T10:05:00.000Z",
      });
      await expect(store.savePrivateMaterial(material)).resolves.toBe(
        InvestigationPrivateMaterialPersistenceStatus.Created,
      );
      await expect(store.savePrivateMaterial(material)).resolves.toBe(
        InvestigationPrivateMaterialPersistenceStatus.Idempotent,
      );
      const global = await cipher.encrypt({
        privateMaterialId: `private-global-${randomUUID()}`,
        investigationId: seed.investigationId,
        obligationId: null,
        plaintextCanonicalJson: '{"query":"global private state"}',
        associatedDataCanonicalJson: `{"investigationId":"${seed.investigationId}"}`,
        createdAt: "2026-08-02T10:00:00.000Z",
        expiresAt: "2026-08-02T10:05:00.000Z",
      });
      await expect(store.savePrivateMaterial(global)).resolves.toBe(
        InvestigationPrivateMaterialPersistenceStatus.Created,
      );
      await expect(
        store.savePrivateMaterial({
          ...global,
          privateMaterialId: `private-global-conflict-${randomUUID()}`,
        }),
      ).resolves.toBe(InvestigationPrivateMaterialPersistenceStatus.Conflict);
      await expect(
        store.findActivePrivateMaterial({
          investigationId: seed.investigationId,
          obligationId: seed.obligations[0]!.obligationId,
          activeAfter: "2026-08-02T10:04:59.999Z",
        }),
      ).resolves.toEqual(material);
      await expect(
        store.findActivePrivateMaterial({
          investigationId: seed.investigationId,
          obligationId: seed.obligations[0]!.obligationId,
          activeAfter: material.expiresAt,
        }),
      ).resolves.toBeNull();
      await expect(
        store.pruneExpiredPrivateMaterial({
          expiresAtOrBefore: material.expiresAt,
          limit: 10,
        }),
      ).resolves.toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it("prunes expired inconclusive dossiers but preserves accepted receipts", async () => {
    const suffix = randomUUID();
    const removable = createInvestigationStoreContractSeed(`prune-${suffix}`);
    const protectedSeed = createInvestigationStoreContractSeed(
      `protected-${suffix}`,
    );
    const removableHarness = await createHarness(removable, 1_000);
    const protectedHarness = await createHarness(protectedSeed, 1_000);
    try {
      const removableStore = removableHarness.store as PrismaInvestigationStore;
      const protectedStore = protectedHarness.store as PrismaInvestigationStore;
      await open(removableStore, removable, "prune-open");
      const removableTurn = planned(removable, `turn-prune-${suffix}`);
      await plan(removableStore, removableTurn, "prune-plan");
      const removableTerminal = abortInvestigationTurn({
        investigation: removableTurn,
        abort: {
          turnId: removableTurn.activeTurn!.turnId,
          reason: ReviewInvestigationAbortReason.ConfinementViolation,
          nextEligibleAt: null,
        },
        abortedAt: "2026-08-02T10:03:00.000Z",
      });
      await abort(
        removableStore,
        removableTurn,
        removableTerminal,
        "prune-abort",
      );

      await open(protectedStore, protectedSeed, "protected-open");
      const protectedTurn = planned(protectedSeed, `turn-protected-${suffix}`);
      await plan(protectedStore, protectedTurn, "protected-plan");
      const receipt = evidenceReceipt(protectedSeed);
      const withReceipt = commitInvestigationTurn({
        investigation: protectedTurn,
        commit: {
          turnId: protectedTurn.activeTurn!.turnId,
          closureClaims: [
            {
              obligationId: protectedSeed.obligations[0]!.obligationId,
              receipt,
            },
          ],
          unresolvableDecisions: [],
          proposedObligations: [],
          findings: [],
          criticDecision: null,
          usageTokens: 10,
          durationMs: 10,
          provenance: null,
        },
        committedAt: "2026-08-02T10:03:00.000Z",
      });
      await expect(
        protectedStore.commit({
          investigation: withReceipt,
          expectedVersion: protectedTurn.version,
          commandId: "protected-commit",
          commandHash: "8".repeat(64),
          transition: {
            kind: InvestigationStoreTransitionKind.TurnCommitted,
            turnId: protectedTurn.activeTurn!.turnId,
            acceptedAttestationId: null,
            sanitizedOutcomeHash: null,
          },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Committed,
      });
      const criticTurn = planInvestigationTurn({
        investigation: withReceipt,
        turn: {
          turnId: `critic-protected-${suffix}`,
          purpose: ReviewInvestigationTurnPurpose.Critic,
          leasedAtVersion: withReceipt.version + 1,
          dossierDigest: withReceipt.dossierDigest,
          obligationIds: [],
          semanticTurnOrdinal: withReceipt.semanticTurns,
          criticCycleOrdinal: withReceipt.criticCycles + 1,
          leasedAt: "2026-08-02T10:04:00.000Z",
          expiresAt: "2026-08-02T10:05:00.000Z",
        },
      });
      await plan(protectedStore, criticTurn, "protected-critic-plan");
      const protectedTerminal = abortInvestigationTurn({
        investigation: criticTurn,
        abort: {
          turnId: criticTurn.activeTurn!.turnId,
          reason: ReviewInvestigationAbortReason.ConfinementViolation,
          nextEligibleAt: null,
        },
        abortedAt: "2026-08-02T10:06:00.000Z",
      });
      await abort(
        protectedStore,
        criticTurn,
        protectedTerminal,
        "protected-abort",
      );

      await expect(
        removableStore.pruneRetainedInvestigations({
          retainUntilOrBefore: "2026-08-03T00:00:00.000Z",
          limit: 10,
        }),
      ).resolves.toBe(1);
      await expect(
        removableStore.findById(removable.investigationId),
      ).resolves.toBeNull();
      await expect(
        protectedStore.findById(protectedSeed.investigationId),
      ).resolves.not.toBeNull();
    } finally {
      await removableHarness.dispose();
      await protectedHarness.dispose();
    }
  });
});

async function createHarness(
  seed: ReviewInvestigation,
  operationalRetentionMs = 86_400_000,
): Promise<InvestigationStoreContractHarness> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
  await seedExecution(prisma, seed);
  const store = new PrismaInvestigationStore(prisma, {
    operationalRetentionMs,
  });
  return {
    store,
    async restart() {
      return new PrismaInvestigationStore(prisma, { operationalRetentionMs });
    },
    async dispose() {
      await cleanup(prisma, seed);
      await prisma.$disconnect();
    },
  };
}

async function seedExecution(
  prisma: PrismaClient,
  seed: ReviewInvestigation,
): Promise<void> {
  const now = new Date(seed.createdAt);
  const limitsProfileId = "investigation-test-limits-v1";
  const sloProfileId = "investigation-test-slo-v1";
  const producerReleaseId = `producer-${seed.investigationId}`;
  const authorizationId = `authorization-${seed.investigationId}`;
  const producerDigest = createHash("sha256")
    .update(seed.investigationId)
    .digest("hex");
  await prisma.reviewProtocolLimitsV2.upsert({
    where: { protocolLimitsProfileId: limitsProfileId },
    update: {},
    create: {
      protocolLimitsProfileId: limitsProfileId,
      limitsDigest: "a".repeat(64),
      maxWorkSlots: 16,
      maxAttemptsPerSlot: 4,
      maxObservationBytes: 1_000_000,
      maxObservationFindings: 1_000,
      maxProjectionBytes: 1_000_000,
      maxProjectionFindings: 1_000,
      maxPublicationOperations: 100,
      maxPublicationChunks: 100,
      maxPublicationBodyBytes: 1_000_000,
      maxRequestBatchSize: 100,
      maxLeaseDurationMs: 120_000,
      maxResultReportDurationMs: 180_000,
      maxReconciliationDurationMs: 3_600_000,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.upsert({
    where: { operationalSloProfileId: sloProfileId },
    update: {},
    create: {
      operationalSloProfileId: sloProfileId,
      sloDigest: "b".repeat(64),
      integrationEventDeliveryMs: 1_000,
      outboxClaimAgeMs: 1_000,
      missingCompletionProcessMs: 1_000,
      dueCompletionProcessMs: 1_000,
      publicationReconciliationMs: 1_000,
      v1DrainMs: 1_000,
      admissionMs: 1_000,
      pruningBacklogAgeMs: 1_000,
      registeredAt: now,
    },
  });
  await prisma.workspace.create({
    data: {
      id: seed.scope.workspaceId,
      slug: seed.scope.workspaceId,
      name: seed.scope.workspaceId,
    },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${seed.investigationId}`,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: seed.scope.repositoryConnectionId,
      workspaceId: seed.scope.workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${seed.investigationId}`,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      owner: "reviewrouter-test",
      name: seed.investigationId,
      fullName: `reviewrouter-test/${seed.investigationId}`,
      defaultBranch: "main",
      visibility: "private",
    },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: seed.scope.workspaceId,
      currentRepositoryConnectionId: seed.scope.repositoryConnectionId,
      boundAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId,
      distributionKind: "hosted_composite",
      actionCommitSha: producerDigest.slice(0, 40),
      runtimeCommitSha: producerDigest.slice(24, 64),
      wrapperEntrypointDigest: producerDigest,
      runtimeEntrypointDigest: createHash("sha256")
        .update(producerDigest)
        .digest("hex"),
      schemaDigest: createHash("sha256")
        .update(`schema-${producerDigest}`)
        .digest("hex"),
      capabilityProfile: "investigation-test",
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
      state: "registered",
      registeredAt: now,
    },
  });
  await prisma.reviewRunAuthorization.create({
    data: {
      authorizationId,
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
      sourceRunId: `run-${seed.investigationId}`,
      sourceRunAttempt: "1",
      workflowIdentityHash: "f".repeat(64),
      baseSha: seed.revision.baseSha,
      mergeBaseSha: seed.revision.mergeBaseSha,
      headSha: seed.revision.headSha,
      reviewRevisionHash: seed.revision.reviewRevisionHash,
      trustDomain: "trusted_local",
      producerReleaseId,
      selectedProtocolVersion: "review-action-v2",
      schemaDigest: createHash("sha256")
        .update(`schema-${producerDigest}`)
        .digest("hex"),
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
      mutationEpoch: 1n,
      providerVoteLanes: [],
      authorizationSafetyDecisionHash: "1".repeat(64),
      protocolOfferHash: "2".repeat(64),
      oidcReplayKeyHash: `oidc-${seed.investigationId}`,
      tokenSigningKeyId: "test-key",
      tokenIssuer: "reviewrouter-test",
      tokenAudience: "review-run",
      state: "active",
      expiresAt: new Date(now.getTime() + 3_600_000),
      maxExpiresAt: new Date(now.getTime() + 7_200_000),
      createdAt: now,
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      executionId: seed.executionId,
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
      generation: 1n,
      version: 1n,
      baseSha: seed.revision.baseSha,
      mergeBaseSha: seed.revision.mergeBaseSha,
      headSha: seed.revision.headSha,
      reviewRevisionHash: seed.revision.reviewRevisionHash,
      compatibilityKey: `compatibility-${seed.investigationId}`,
      planHash: "1".repeat(64),
      startIdentityHash: "2".repeat(64),
      canonicalStartHash: "3".repeat(64),
      authorizationId,
      producerReleaseId,
      mutationEpoch: 1n,
      admissionSafetyDecisionHash: "4".repeat(64),
      protocolLimitsProfileId: "limits-test",
      sourceRunId: `run-${seed.investigationId}`,
      sourceRunAttempt: "1",
      createdAt: now,
      updatedAt: now,
      admissionDeadlineAt: new Date(now.getTime() + 60_000),
      executionDeadlineAt: new Date(now.getTime() + 120_000),
      retainUntil: new Date(now.getTime() + 86_400_000),
    },
  });
  await prisma.reviewExecutionWorkSlotV2.create({
    data: {
      executionId: seed.executionId,
      workSlotId: seed.workSlotId,
      planOrdinal: 1,
      taskKind: ReviewTaskKindV2.finding_discovery,
      providerKind: ReviewProviderKindV2.codex,
      providerVoteIdentityHash: "5".repeat(64),
      shardKey: seed.stableReviewUnitKey,
      required: true,
      attemptBudget: 3,
      retryPolicyVersion: "retry-v1",
    },
  });
}

async function cleanup(
  prisma: PrismaClient,
  seed: ReviewInvestigation,
): Promise<void> {
  await prisma.reviewInvestigation.updateMany({
    where: { investigationId: seed.investigationId },
    data: { activeTurnId: null, certificateId: null },
  });
  await prisma.reviewInvestigationCommandReceipt.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationPrivateMaterial.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationObligation.updateMany({
    where: { investigationId: seed.investigationId },
    data: { receiptId: null, state: "open", unresolvableReason: null },
  });
  await prisma.reviewInvestigationReceipt.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationTurn.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationCertificate.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationObligation.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigation.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewExecutionWorkSlotV2.deleteMany({
    where: { executionId: seed.executionId },
  });
  await prisma.reviewExecutionV2.deleteMany({
    where: { executionId: seed.executionId },
  });
  await prisma.reviewRunAuthorization.deleteMany({
    where: { authorizationId: `authorization-${seed.investigationId}` },
  });
  await prisma.producerRelease.deleteMany({
    where: { producerReleaseId: `producer-${seed.investigationId}` },
  });
  await prisma.scmRepositoryIdentity.updateMany({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: null,
      currentRepositoryConnectionId: null,
      unboundAt: new Date(),
    },
  });
  await prisma.repositoryConnection.deleteMany({
    where: { id: seed.scope.repositoryConnectionId },
  });
  await prisma.scmRepositoryIdentity.deleteMany({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
  });
  await prisma.workspace.deleteMany({ where: { id: seed.scope.workspaceId } });
}

async function open(
  store: PrismaInvestigationStore,
  seed: ReviewInvestigation,
  commandId: string,
): Promise<void> {
  await expect(
    store.commit({
      investigation: seed,
      expectedVersion: null,
      commandId,
      commandHash: "6".repeat(64),
      transition: { kind: InvestigationStoreTransitionKind.Opened },
    }),
  ).resolves.toMatchObject({
    status: InvestigationStoreCommitStatus.Committed,
  });
}

function planned(
  seed: ReviewInvestigation,
  turnId: string,
): ReviewInvestigation {
  return planInvestigationTurn({
    investigation: seed,
    turn: {
      turnId,
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      leasedAtVersion: seed.version + 1,
      dossierDigest: seed.dossierDigest,
      obligationIds: seed.obligations.map((item) => item.obligationId),
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: "2026-08-02T10:01:00.000Z",
      expiresAt: "2026-08-02T10:02:00.000Z",
    },
  });
}

async function plan(
  store: PrismaInvestigationStore,
  next: ReviewInvestigation,
  commandId: string,
): Promise<void> {
  await expect(
    store.commit({
      investigation: next,
      expectedVersion: next.version - 1,
      commandId,
      commandHash: "7".repeat(64),
      transition: {
        kind: InvestigationStoreTransitionKind.TurnPlanned,
        turnId: next.activeTurn!.turnId,
      },
    }),
  ).resolves.toMatchObject({
    status: InvestigationStoreCommitStatus.Committed,
  });
}

async function abort(
  store: PrismaInvestigationStore,
  current: ReviewInvestigation,
  next: ReviewInvestigation,
  commandId: string,
): Promise<void> {
  await expect(
    store.commit({
      investigation: next,
      expectedVersion: current.version,
      commandId,
      commandHash: "9".repeat(64),
      transition: {
        kind: InvestigationStoreTransitionKind.TurnAborted,
        turnId: current.activeTurn!.turnId,
        reason: ReviewInvestigationAbortReason.ConfinementViolation,
      },
    }),
  ).resolves.toMatchObject({
    status: InvestigationStoreCommitStatus.Committed,
  });
}

function evidenceReceipt(
  seed: ReviewInvestigation,
): InvestigationEvidenceReceipt {
  return {
    receiptId: `receipt-${seed.investigationId}`,
    operationKey: `operation-${seed.investigationId}`,
    kind: InvestigationReceiptKind.Tree,
    canonicalSubject: seed.obligations[0]!.canonicalSubject,
    reviewRevisionHash: seed.revision.reviewRevisionHash,
    gatewayPolicyVersion: seed.contract.gatewayPolicyVersion,
    evidenceDigest: "a".repeat(64),
    operationReceiptIds: [],
    acceptedAttestationId: null,
    acceptedAttestationHash: null,
    complete: true,
    truncated: false,
    failed: false,
  };
}
