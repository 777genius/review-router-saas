import { createHash, randomUUID } from "node:crypto";
import {
  ReviewProviderKindV2,
  ReviewTaskKindV2,
  type PrismaClient,
} from "@prisma/client";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it } from "vitest";
import {
  InvestigationEvidenceRequirementKind,
  InvestigationPolicyCanonicalVersion,
  InvestigationObligationKind,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationTextSearchMatchMode,
  InvestigationTurnProviderKind,
  InvestigationPrivateMaterialExpiryReason,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
  InvestigationPrivateMaterialPersistenceStatus,
  InvestigationStoreCommitGuardKind,
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  canonicalInvestigationEvidenceRequirement,
  canonicalJson,
  canonicalInventoryObligationSubject,
  canonicalPageObligationSubjectV2,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  reviewInvestigationCoverageProfileV2,
  investigationDossierCanonicalValue,
} from "../index";
import { RestoreReviewInvestigation } from "../application/use-cases/restore-review-investigation";
import { HydrateInvestigationTurnObligations } from "../application/use-cases/hydrate-investigation-turn-obligations";
import { PrepareInvestigationSearchQueryPrivateMaterial } from "../application/use-cases/prepare-investigation-search-query-private-material";
import { AesGcmInvestigationPrivateMaterialCipher } from "../infrastructure/crypto/aes-gcm-investigation-private-material-cipher";
import { PrismaInvestigationStore } from "../infrastructure/prisma/prisma-investigation-store";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  createInvestigationLeaseStoreContractCandidate,
  createInvestigationLeaseBindingSeed,
  defineInvestigationLeaseStoreContract,
  type InvestigationLeaseStoreContractHarness,
} from "../testing/investigation-lease-store-contract";
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
  createInvestigationObligation,
  InvestigationObligationOrigin,
  InvestigationReceiptKind,
  obligationIdentity,
  type InvestigationEvidenceReceipt,
} from "../domain/investigation-obligation";
import {
  ReviewInvestigationAbortReason,
  ReviewInvestigationTurnPurpose,
} from "../domain/review-investigation-types";
import { FixedInvestigationClock } from "../testing/investigation-test-kit";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

if (databaseUrl) {
  defineInvestigationStoreContract("PrismaInvestigationStore", async (seed) =>
    createHarness(seed),
  );
  defineInvestigationLeaseStoreContract(
    "PrismaInvestigationStore",
    createLeaseHarness,
  );
} else {
  describe.skip("PrismaInvestigationStore InvestigationStorePort contract", () => {
    it("requires REVIEW_ROUTER_TEST_DATABASE_URL", () => undefined);
  });
}

async function createLeaseHarness(): Promise<InvestigationLeaseStoreContractHarness> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
  const operationalRetentionMs = 86_400_000;
  const store = new PrismaInvestigationStore(prisma, {
    operationalRetentionMs,
  });
  const seeds: ReviewInvestigation[] = [];
  return {
    store,
    async seedBinding(candidate) {
      const { base, planned } = createInvestigationLeaseBindingSeed(candidate);
      seeds.push(base);
      await seedExecution(prisma, base);
      await store.commit({
        investigation: base,
        expectedVersion: null,
        commandId: `lease-open-${candidate.leaseId}`,
        commandHash: createHash("sha256")
          .update(`lease-open-${candidate.leaseId}`)
          .digest("hex"),
        transition: { kind: InvestigationStoreTransitionKind.Opened },
      });
      await store.commit({
        investigation: planned,
        expectedVersion: base.version,
        commandId: `lease-plan-${candidate.leaseId}`,
        commandHash: createHash("sha256")
          .update(`lease-plan-${candidate.leaseId}`)
          .digest("hex"),
        transition: {
          kind: InvestigationStoreTransitionKind.TurnPlanned,
          turnId: candidate.turnId,
        },
      });
    },
    async restart() {
      return new PrismaInvestigationStore(prisma, {
        operationalRetentionMs,
      });
    },
    async dispose() {
      for (const seed of seeds.reverse()) {
        await cleanup(prisma, seed);
      }
      await prisma.$disconnect();
    },
  };
}

describeDatabase("PrismaInvestigationStore PostgreSQL invariants", () => {
  it("round-trips token usage with reasoning included in output", async () => {
    const suffix = `token-usage-${randomUUID()}`;
    const seed = createInvestigationStoreContractSeed(suffix);
    const harness = await createHarness(seed);
    const store = harness.store as PrismaInvestigationStore;
    try {
      await open(store, seed, `token-usage-open-${suffix}`);
      const leased = planned(seed, `turn-token-usage-${suffix}`);
      await plan(store, leased, `token-usage-plan-${suffix}`);
      const provenance = {
        turnId: leased.activeTurn!.turnId,
        purpose: leased.activeTurn!.purpose,
        actualProviderKind: InvestigationTurnProviderKind.Codex,
        actualModel: "gpt-5.6-sol",
        runtimeProfile: leased.runtimeProfile,
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 110,
        durationMs: 1_000,
        acceptedAttestationId: `attestation-${suffix}`,
        acceptedAttestationHash: "a".repeat(64),
        terminalOutcomeHash: "b".repeat(64),
      } as const;
      const committed = commitInvestigationTurn({
        investigation: leased,
        commit: {
          turnId: leased.activeTurn!.turnId,
          closureClaims: [],
          unresolvableDecisions: [],
          proposedObligations: [],
          findings: [],
          criticDecision: null,
          usageTokens: 110,
          durationMs: 1_000,
          provenance,
        },
        committedAt: "2026-08-02T10:03:00.000Z",
      });
      await expect(
        store.commit({
          investigation: committed,
          expectedVersion: leased.version,
          commandId: `token-usage-commit-${suffix}`,
          commandHash: "8".repeat(64),
          transition: {
            kind: InvestigationStoreTransitionKind.TurnCommitted,
            turnId: leased.activeTurn!.turnId,
            acceptedAttestationId: provenance.acceptedAttestationId,
            sanitizedOutcomeHash: provenance.terminalOutcomeHash,
          },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Committed,
      });

      const restarted = (await harness.restart()) as PrismaInvestigationStore;
      await expect(
        restarted.findById(seed.investigationId),
      ).resolves.toMatchObject({
        totalUsageTokens: 110,
        turnProvenance: [provenance],
      });
    } finally {
      await harness.dispose();
    }
  });

  it("rehydrates an explicitly versioned legacy policy row", async () => {
    const base = createInvestigationStoreContractSeed(
      `legacy-policy-${randomUUID()}`,
    );
    const legacyPolicy = { ...base.policy };
    delete legacyPolicy.maxSeedProbesPerFile;
    delete legacyPolicy.maxSeedProbesOverall;
    const digest = new NodeSha256InvestigationDigest();
    const preimage = {
      ...base,
      policyCanonicalVersion: InvestigationPolicyCanonicalVersion.LegacyV1,
      policy: legacyPolicy,
    };
    const seed: ReviewInvestigation = {
      ...preimage,
      dossierDigest: await digest.digestUtf8(
        canonicalJson(investigationDossierCanonicalValue(preimage)),
      ),
    };
    const harness = await createHarness(seed);
    const store = harness.store as PrismaInvestigationStore;
    try {
      await open(store, seed, `legacy-policy-open-${randomUUID()}`);
      const restarted = (await harness.restart()) as PrismaInvestigationStore;
      await expect(
        new RestoreReviewInvestigation(restarted, digest).snapshot(
          seed.investigationId,
        ),
      ).resolves.toMatchObject({
        dossierDigest: seed.dossierDigest,
        policyCanonicalVersion: InvestigationPolicyCanonicalVersion.LegacyV1,
        policy: legacyPolicy,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("atomically rejects a turn commit after a lease fence takeover", async () => {
    const suffix = `commit-fence-${randomUUID()}`;
    const firstCandidate =
      createInvestigationLeaseStoreContractCandidate(suffix);
    const { base, planned: plannedInvestigation } =
      createInvestigationLeaseBindingSeed(firstCandidate);
    const harness = await createHarness(base);
    const store = harness.store as PrismaInvestigationStore;
    try {
      await open(store, base, `fence-open-${suffix}`);
      await plan(store, plannedInvestigation, `fence-plan-${suffix}`);
      const first = (await store.acquireLease(firstCandidate)).lease!;
      const secondCandidate = {
        ...firstCandidate,
        leaseId: `${firstCandidate.leaseId}-takeover`,
        attemptId: `${firstCandidate.attemptId}-takeover`,
        leaseCapabilityId: `${firstCandidate.leaseCapabilityId}-takeover`,
        acquireRequestIdHash: createHash("sha256")
          .update(`takeover-id:${suffix}`)
          .digest("hex"),
        acquireRequestHash: createHash("sha256")
          .update(`takeover-request:${suffix}`)
          .digest("hex"),
        acquiredAt: "2026-08-05T10:01:01.000Z",
        expiresAt: "2026-08-05T10:02:00.000Z",
      };
      const second = (await store.acquireLease(secondCandidate)).lease!;
      const next = commitInvestigationTurn({
        investigation: plannedInvestigation,
        commit: {
          turnId: plannedInvestigation.activeTurn!.turnId,
          closureClaims: [],
          unresolvableDecisions: [],
          proposedObligations: [],
          findings: [],
          criticDecision: null,
          usageTokens: 1,
          durationMs: 1,
          provenance: null,
        },
        committedAt: "2026-08-05T10:01:02.000Z",
      });
      const transition = {
        kind: InvestigationStoreTransitionKind.TurnCommitted,
        turnId: plannedInvestigation.activeTurn!.turnId,
        acceptedAttestationId: null,
        sanitizedOutcomeHash: null,
      } as const;
      await expect(
        store.commit({
          investigation: next,
          expectedVersion: plannedInvestigation.version,
          commandId: `fence-stale-commit-${suffix}`,
          commandHash: "a".repeat(64),
          transition,
          guard: {
            kind: InvestigationStoreCommitGuardKind.LeaseFence,
            leaseId: first.leaseId,
            attemptId: first.attemptId,
            turnId: first.turnId,
            fencingToken: first.fencingToken.toString(10),
          },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.LeaseFenceConflict,
        investigation: { version: plannedInvestigation.version },
      });
      await expect(
        store.commit({
          investigation: next,
          expectedVersion: plannedInvestigation.version,
          commandId: `fence-current-commit-${suffix}`,
          commandHash: "b".repeat(64),
          transition,
          guard: {
            kind: InvestigationStoreCommitGuardKind.LeaseFence,
            leaseId: second.leaseId,
            attemptId: second.attemptId,
            turnId: second.turnId,
            fencingToken: second.fencingToken.toString(10),
          },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Committed,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("atomically rejects a turn commit when the persisted lease binding is stale", async () => {
    const suffix = `commit-binding-${randomUUID()}`;
    const candidate = createInvestigationLeaseStoreContractCandidate(suffix);
    const { base, planned } = createInvestigationLeaseBindingSeed(candidate);
    const harness = await createHarness(base);
    const store = harness.store as PrismaInvestigationStore;
    try {
      await open(store, base, `binding-open-${suffix}`);
      await plan(store, planned, `binding-plan-${suffix}`);
      const lease = (await store.acquireLease(candidate)).lease!;
      await harness.prisma.reviewInvestigationLease.update({
        where: { leaseId: lease.leaseId },
        data: { providerStrategyId: `${lease.providerStrategyId}-stale` },
      });
      const next = commitInvestigationTurn({
        investigation: planned,
        commit: {
          turnId: planned.activeTurn!.turnId,
          closureClaims: [],
          unresolvableDecisions: [],
          proposedObligations: [],
          findings: [],
          criticDecision: null,
          usageTokens: 1,
          durationMs: 1,
          provenance: null,
        },
        committedAt: "2026-08-05T10:01:02.000Z",
      });
      await expect(
        store.commit({
          investigation: next,
          expectedVersion: planned.version,
          commandId: `binding-stale-commit-${suffix}`,
          commandHash: "c".repeat(64),
          transition: {
            kind: InvestigationStoreTransitionKind.TurnCommitted,
            turnId: planned.activeTurn!.turnId,
            acceptedAttestationId: null,
            sanitizedOutcomeHash: null,
          },
          guard: {
            kind: InvestigationStoreCommitGuardKind.LeaseFence,
            leaseId: lease.leaseId,
            attemptId: lease.attemptId,
            turnId: lease.turnId,
            fencingToken: lease.fencingToken.toString(10),
          },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.LeaseFenceConflict,
        investigation: { version: planned.version },
      });
      await expect(
        store.findById(planned.investigationId),
      ).resolves.toMatchObject({
        version: planned.version,
        activeTurn: { turnId: planned.activeTurn!.turnId },
      });
    } finally {
      await harness.dispose();
    }
  });

  it("atomically persists encrypted query material and fails closed after restart", async () => {
    const query = "PrismaSensitiveService.call";
    const queryHash = createHash("sha256").update(query).digest("hex");
    const operationInputHash = createHash("sha256")
      .update(canonicalStandardTextSearchOperationInput(queryHash))
      .digest("hex");
    const sourcePathHash = createHash("sha256")
      .update("src/prisma-sensitive.ts")
      .digest("hex");
    const base = createInvestigationStoreContractSeed(
      `private-lifecycle-${randomUUID()}`,
    );
    const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompletePageChain,
      operationKind: InvestigationOperationKind.TextSearch,
      initialOperationInputHash: operationInputHash,
      matchMode: InvestigationTextSearchMatchMode.FixedString,
      queryHash,
      probeKind: InvestigationProbeKind.DeclarationIdentifier,
      paths: ["."],
      pageSize: 500,
      revision: InvestigationOperationRevision.Head,
      sourcePathHash,
      searchPolicyVersion:
        reviewInvestigationCoverageProfileV2.searchPolicyVersion,
    });
    const identity = obligationIdentity({
      coverageContractVersion:
        reviewInvestigationCoverageProfileV2.coverageContractVersion,
      stableReviewUnitKey: base.stableReviewUnitKey,
      kind: InvestigationObligationKind.DirectReferenceSearch,
      canonicalSubject: canonicalPageObligationSubjectV2({
        obligationKind: InvestigationObligationKind.DirectReferenceSearch,
        initialOperationInputHash: operationInputHash,
        probeKind: InvestigationProbeKind.DeclarationIdentifier,
        queryHash,
      }),
      canonicalRequirement,
    });
    const obligation = createInvestigationObligation({
      obligationId: createHash("sha256")
        .update(canonicalRequirement)
        .digest("hex"),
      identity,
      riskPriority: 100,
      origin: InvestigationObligationOrigin.DeterministicExpansion,
    });
    const inventoryRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteInventory,
      reviewRevisionHash: base.revision.reviewRevisionHash,
    });
    const inventoryObligation = createInvestigationObligation({
      obligationId: createHash("sha256")
        .update(inventoryRequirement)
        .digest("hex"),
      identity: obligationIdentity({
        coverageContractVersion:
          reviewInvestigationCoverageProfileV2.coverageContractVersion,
        stableReviewUnitKey: base.stableReviewUnitKey,
        kind: InvestigationObligationKind.InventoryWitness,
        canonicalSubject: canonicalInventoryObligationSubject(
          base.revision.reviewRevisionHash,
        ),
        canonicalRequirement: inventoryRequirement,
      }),
      riskPriority: 1_000_000,
      origin: InvestigationObligationOrigin.CoverageContract,
    });
    const seed: ReviewInvestigation = {
      ...base,
      contract: {
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: base.contract.producerReleaseId,
      },
      obligations: [inventoryObligation, obligation],
    };
    const harness = await createHarness(seed);
    const cipher = new AesGcmInvestigationPrivateMaterialCipher(
      "key-prisma",
      new Map([["key-prisma", Buffer.alloc(32, 19)]]),
    );
    const digest = new NodeSha256InvestigationDigest();
    const ttlMs = 5 * 60 * 1_000;
    const clock = new FixedInvestigationClock(new Date(seed.createdAt));
    const material = await new PrepareInvestigationSearchQueryPrivateMaterial(
      cipher,
      digest,
      ttlMs,
    ).execute({ investigation: seed, obligation, query });
    try {
      await expect(
        harness.store.commit({
          investigation: seed,
          expectedVersion: null,
          commandId: "private-lifecycle-open",
          commandHash: "6".repeat(64),
          transition: { kind: InvestigationStoreTransitionKind.Opened },
        }),
      ).rejects.toThrow("investigation_private_material_required");
      await expect(
        harness.prisma.reviewInvestigation.findUnique({
          where: { investigationId: seed.investigationId },
        }),
      ).resolves.toBeNull();

      await expect(
        harness.store.commit({
          investigation: seed,
          expectedVersion: null,
          commandId: "private-lifecycle-open",
          commandHash: "6".repeat(64),
          transition: { kind: InvestigationStoreTransitionKind.Opened },
          privateMaterials: [material],
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Committed,
      });
      await expect(
        harness.store.commit({
          investigation: seed,
          expectedVersion: null,
          commandId: "private-lifecycle-open",
          commandHash: "6".repeat(64),
          transition: { kind: InvestigationStoreTransitionKind.Opened },
        }),
      ).resolves.toMatchObject({
        status: InvestigationStoreCommitStatus.Restored,
      });
      const persisted = await Promise.all([
        harness.prisma.reviewInvestigation.findUnique({
          where: { investigationId: seed.investigationId },
        }),
        harness.prisma.reviewInvestigationObligation.findMany({
          where: { investigationId: seed.investigationId },
        }),
        harness.prisma.reviewInvestigationCommandReceipt.findMany({
          where: { investigationId: seed.investigationId },
        }),
        harness.prisma.reviewInvestigationPrivateMaterial.findMany({
          where: { investigationId: seed.investigationId },
        }),
      ]);
      expect(
        JSON.stringify(persisted, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toContain(query);

      const restarted = (await harness.restart()) as PrismaInvestigationStore;
      const restored = (await restarted.findById(seed.investigationId))!;
      const hydrator = new HydrateInvestigationTurnObligations(
        restarted,
        cipher,
        digest,
        clock,
      );
      await expect(
        hydrator.execute({
          investigation: restored,
          obligationIds: [obligation.obligationId],
        }),
      ).resolves.toMatchObject([
        {
          canonicalRequirement: expect.stringContaining(query),
        },
      ]);

      clock.advance(ttlMs);
      await expect(
        hydrator.execute({
          investigation: restored,
          obligationIds: [obligation.obligationId],
        }),
      ).rejects.toThrow("investigation_private_material_unavailable");

      const ciphertext = Buffer.from(material.ciphertextBase64Url, "base64url");
      ciphertext[0] = ciphertext[0]! ^ 1;
      await harness.prisma.reviewInvestigationPrivateMaterial.update({
        where: { privateMaterialId: material.privateMaterialId },
        data: { ciphertext },
      });
      const freshClock = new FixedInvestigationClock(new Date(seed.createdAt));
      await expect(
        new HydrateInvestigationTurnObligations(
          restarted,
          cipher,
          digest,
          freshClock,
        ).execute({
          investigation: restored,
          obligationIds: [obligation.obligationId],
        }),
      ).rejects.toThrow("investigation_private_material_invalid");

      const contaminatedRequirement = JSON.stringify({
        ...JSON.parse(canonicalRequirement),
        query,
      });
      await expect(
        harness.prisma.reviewInvestigationObligation.updateMany({
          where: {
            investigationId: seed.investigationId,
            obligationId: obligation.obligationId,
          },
          data: { canonicalRequirement: contaminatedRequirement },
        }),
      ).resolves.toMatchObject({ count: 1 });
      await expect(restarted.findById(seed.investigationId)).rejects.toThrow();
    } finally {
      await harness.dispose();
    }
  });

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
      const concurrentExpiry = () =>
        store.reconcileExpiredPrivateMaterial({
          expiresAtOrBefore: material.expiresAt,
          limit: 10,
        });
      await expect(
        Promise.all([concurrentExpiry(), concurrentExpiry()]),
      ).resolves.toEqual(expect.arrayContaining([0, 2]));
      const reconciled = await store.findById(seed.investigationId);
      expect(reconciled).toMatchObject({
        version: seed.version + 1,
        state: ReviewInvestigationState.Inconclusive,
        conclusion: ReviewInvestigationConclusion.Inconclusive,
        activeTurn: null,
      });
      expect(reconciled!.dossierDigest).not.toBe(seed.dossierDigest);
      expect(
        reconciled!.obligations.find(
          (obligation) =>
            obligation.obligationId === seed.obligations[0]!.obligationId,
        ),
      ).toMatchObject({
        state: InvestigationObligationState.Unresolvable,
        receipt: null,
        unresolvableReason:
          InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
      });
      await expect(
        harness.prisma.reviewInvestigationPrivateMaterial.count({
          where: { investigationId: seed.investigationId },
        }),
      ).resolves.toBe(0);
      const commands =
        await harness.prisma.reviewInvestigationCommandReceipt.findMany({
          where: { investigationId: seed.investigationId },
          orderBy: { resultingVersion: "asc" },
        });
      expect(commands).toHaveLength(2);
      expect(commands[1]).toMatchObject({
        commandId: expect.stringMatching(
          /^private-material-expiry-[a-f0-9]{64}$/u,
        ),
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        resultingVersion: BigInt(seed.version + 1),
      });

      await expect(
        store.reconcileExpiredPrivateMaterial({
          expiresAtOrBefore: material.expiresAt,
          limit: 10,
        }),
      ).resolves.toBe(0);
      await expect(store.findById(seed.investigationId)).resolves.toMatchObject(
        {
          version: seed.version + 1,
          dossierDigest: reconciled!.dossierDigest,
        },
      );
      await expect(
        harness.prisma.reviewInvestigationCommandReceipt.count({
          where: { investigationId: seed.investigationId },
        }),
      ).resolves.toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it("keeps expired material through a live lease and fences it after lease expiry", async () => {
    const suffix = randomUUID();
    const seed = createInvestigationStoreContractSeed(`lease-${suffix}`);
    const harness = await createHarness(seed, 1_000);
    try {
      const store = harness.store as PrismaInvestigationStore;
      await open(store, seed, `lease-open-${suffix}`);
      const leased = planned(seed, `turn-private-material-${suffix}`);
      await plan(store, leased, `lease-plan-${suffix}`);
      const cipher = new AesGcmInvestigationPrivateMaterialCipher(
        "lease-key",
        new Map([["lease-key", Buffer.alloc(32, 11)]]),
      );
      const material = await cipher.encrypt({
        privateMaterialId: `private-lease-${suffix}`,
        investigationId: seed.investigationId,
        obligationId: seed.obligations[0]!.obligationId,
        plaintextCanonicalJson: '{"query":"leased private symbol"}',
        associatedDataCanonicalJson: `{"investigationId":"${seed.investigationId}"}`,
        createdAt: "2026-08-02T10:00:00.000Z",
        expiresAt: "2026-08-02T10:01:00.000Z",
      });
      await expect(store.savePrivateMaterial(material)).resolves.toBe(
        InvestigationPrivateMaterialPersistenceStatus.Created,
      );

      await expect(
        store.reconcileExpiredPrivateMaterial({
          expiresAtOrBefore: "2026-08-02T10:01:30.000Z",
          limit: 10,
        }),
      ).resolves.toBe(0);
      await expect(store.findById(seed.investigationId)).resolves.toMatchObject(
        {
          version: leased.version,
          state: ReviewInvestigationState.TurnLeased,
          activeTurn: { turnId: leased.activeTurn!.turnId },
        },
      );
      await expect(
        harness.prisma.reviewInvestigationPrivateMaterial.count({
          where: { privateMaterialId: material.privateMaterialId },
        }),
      ).resolves.toBe(1);

      await expect(
        store.reconcileExpiredPrivateMaterial({
          expiresAtOrBefore: leased.activeTurn!.expiresAt,
          limit: 10,
        }),
      ).resolves.toBe(1);
      await expect(store.findById(seed.investigationId)).resolves.toMatchObject(
        {
          version: leased.version + 1,
          state: ReviewInvestigationState.Inconclusive,
          conclusion: ReviewInvestigationConclusion.Inconclusive,
          activeTurn: null,
        },
      );
      await expect(
        harness.prisma.reviewInvestigationTurn.findUnique({
          where: { turnId: leased.activeTurn!.turnId },
        }),
      ).resolves.toMatchObject({
        state: "expired",
        abortReason:
          InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
        completedAt: new Date(leased.activeTurn!.expiresAt),
      });
      await expect(
        harness.prisma.reviewInvestigationPrivateMaterial.count({
          where: { privateMaterialId: material.privateMaterialId },
        }),
      ).resolves.toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("prunes expired terminal graphs but preserves live receipts and certificates", async () => {
    const suffix = randomUUID();
    const removable = createInvestigationStoreContractSeed(`prune-${suffix}`);
    const protectedSeed = createInvestigationStoreContractSeed(
      `protected-${suffix}`,
    );
    const concludedSeed = createInvestigationStoreContractSeed(
      `concluded-${suffix}`,
    );
    const liveCertificateSeed = createInvestigationStoreContractSeed(
      `live-certificate-${suffix}`,
    );
    const removableHarness = await createHarness(removable, 1_000);
    const protectedHarness = await createHarness(
      protectedSeed,
      2 * 24 * 60 * 60 * 1_000,
    );
    const concludedHarness = await createHarness(concludedSeed, 1_000);
    const liveCertificateHarness = await createHarness(
      liveCertificateSeed,
      1_000,
    );
    try {
      const removableStore = removableHarness.store as PrismaInvestigationStore;
      const protectedStore = protectedHarness.store as PrismaInvestigationStore;
      const concludedStore = concludedHarness.store as PrismaInvestigationStore;
      const liveCertificateStore =
        liveCertificateHarness.store as PrismaInvestigationStore;
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

      const cutoff = new Date("2026-08-03T00:00:00.000Z");
      await protectedHarness.prisma.reviewInvestigation.update({
        where: { investigationId: protectedSeed.investigationId },
        data: { retainUntil: new Date(cutoff.getTime() - 1) },
      });
      await protectedHarness.prisma.reviewInvestigationCommandReceipt.updateMany(
        {
          where: { investigationId: protectedSeed.investigationId },
          data: { retainUntil: new Date(cutoff.getTime() - 1) },
        },
      );
      await protectedHarness.prisma.reviewInvestigationTurn.updateMany({
        where: { investigationId: protectedSeed.investigationId },
        data: { retainUntil: new Date(cutoff.getTime() - 1) },
      });

      await open(concludedStore, concludedSeed, "concluded-open");
      await seedConcludedCertificate(concludedHarness.prisma, concludedSeed, {
        expiresAt: new Date(cutoff.getTime() - 1),
        retainUntil: new Date(cutoff.getTime() - 1),
      });

      await open(
        liveCertificateStore,
        liveCertificateSeed,
        "live-certificate-open",
      );
      await seedConcludedCertificate(
        liveCertificateHarness.prisma,
        liveCertificateSeed,
        {
          expiresAt: new Date(cutoff.getTime() + 60_000),
          retainUntil: new Date(cutoff.getTime() - 1),
        },
      );

      await expect(
        removableStore.pruneRetainedInvestigations({
          retainUntilOrBefore: cutoff.toISOString(),
          limit: 10,
        }),
      ).resolves.toBe(2);
      await expect(
        removableStore.findById(removable.investigationId),
      ).resolves.toBeNull();
      await expect(
        concludedStore.findById(concludedSeed.investigationId),
      ).resolves.toBeNull();
      await expect(
        protectedStore.findById(protectedSeed.investigationId),
      ).resolves.not.toBeNull();
      await expect(
        protectedHarness.prisma.reviewInvestigationReceipt.count({
          where: { investigationId: protectedSeed.investigationId },
        }),
      ).resolves.toBe(1);
      await expect(
        liveCertificateHarness.prisma.reviewInvestigation.count({
          where: { investigationId: liveCertificateSeed.investigationId },
        }),
      ).resolves.toBe(1);
      await expect(
        liveCertificateHarness.prisma.reviewInvestigationCertificate.count({
          where: { investigationId: liveCertificateSeed.investigationId },
        }),
      ).resolves.toBe(1);
      await expect(
        concludedHarness.prisma.reviewInvestigationCertificate.count({
          where: { investigationId: concludedSeed.investigationId },
        }),
      ).resolves.toBe(0);
      await expect(
        concludedHarness.prisma.reviewInvestigationObligation.count({
          where: { investigationId: concludedSeed.investigationId },
        }),
      ).resolves.toBe(0);
      await expect(
        concludedHarness.prisma.reviewInvestigationCommandReceipt.count({
          where: { investigationId: concludedSeed.investigationId },
        }),
      ).resolves.toBe(0);
    } finally {
      await removableHarness.dispose();
      await protectedHarness.dispose();
      await concludedHarness.dispose();
      await liveCertificateHarness.dispose();
    }
  });
});

type PrismaInvestigationStoreHarness = InvestigationStoreContractHarness &
  Readonly<{ prisma: PrismaClient }>;

async function createHarness(
  seed: ReviewInvestigation,
  operationalRetentionMs = 86_400_000,
): Promise<PrismaInvestigationStoreHarness> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
  await seedExecution(prisma, seed);
  const store = new PrismaInvestigationStore(prisma, {
    operationalRetentionMs,
  });
  return {
    prisma,
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

async function seedConcludedCertificate(
  prisma: PrismaClient,
  seed: ReviewInvestigation,
  input: Readonly<{ expiresAt: Date; retainUntil: Date }>,
): Promise<void> {
  const certificateId = `certificate-${randomUUID()}`;
  await prisma.$transaction(async (transaction) => {
    await transaction.reviewInvestigationCertificate.create({
      data: {
        certificateId,
        certificateHash: createHash("sha256")
          .update(certificateId)
          .digest("hex"),
        investigationId: seed.investigationId,
        terminalVersion: 2n,
        dossierDigest: seed.dossierDigest,
        reviewRevisionHash: seed.revision.reviewRevisionHash,
        stableReviewUnitKey: seed.stableReviewUnitKey,
        providerVoteLaneId: seed.providerVoteLaneId,
        coverageContractVersion: seed.contract.coverageContractVersion,
        expansionRulesVersion: seed.contract.expansionRulesVersion,
        gatewayPolicyVersion: seed.contract.gatewayPolicyVersion,
        criticPolicyVersion: seed.contract.criticPolicyVersion,
        runtimeProfileVersion: seed.contract.runtimeProfileVersion,
        producerReleaseId: seed.contract.producerReleaseId,
        conclusion: "findings",
        findingSetHash: "1".repeat(64),
        obligationSetHash: "2".repeat(64),
        receiptSetHash: "3".repeat(64),
        scopeHash: "4".repeat(64),
        coverageStateHash: "5".repeat(64),
        contextAttestationSetHash: "6".repeat(64),
        turnProvenanceHash: "7".repeat(64),
        terminalOutcomeHash: "8".repeat(64),
        terminalObservationCanonicalJson: "{}",
        issuedAt: new Date(input.expiresAt.getTime() - 1_000),
        expiresAt: input.expiresAt,
      },
    });
    await transaction.reviewInvestigation.update({
      where: { investigationId: seed.investigationId },
      data: {
        version: 2n,
        state: "concluded",
        conclusion: "findings",
        certificateId,
        activeTurnId: null,
        retainUntil: input.retainUntil,
      },
    });
    await transaction.reviewInvestigationCommandReceipt.updateMany({
      where: { investigationId: seed.investigationId },
      data: { retainUntil: input.retainUntil },
    });
  });
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
    data: {
      activeTurnId: null,
      certificateId: null,
      replayEvidenceCheckpointId: null,
    },
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
  await prisma.reviewInvestigationLease.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationTurn.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationCertificate.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationReplayEvidenceCheckpoint.deleteMany({
    where: { sourceInvestigationId: seed.investigationId },
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
    replayProofId: null,
    complete: true,
    truncated: false,
    failed: false,
  };
}
