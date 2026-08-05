import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
  InvestigationEvidenceRequirementKind,
  InvestigationPrivateMaterialExpiryDisposition,
  InvestigationPrivateMaterialExpiryReason,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationTextSearchMatchMode,
  ReviewInvestigationConclusion,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalFileObligationSubject,
  canonicalInventoryObligationSubjectV2,
  canonicalInvestigationEvidenceRequirement,
  canonicalPageObligationSubjectV2,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  reviewInvestigationCoverageProfileV2,
  type OpenReviewInvestigationCommand,
} from "../index";
import { HydrateInvestigationTurnObligations } from "../application/use-cases/hydrate-investigation-turn-obligations";
import { OpenReviewInvestigation } from "../application/use-cases/open-review-investigation";
import { PrepareInvestigationSearchQueryPrivateMaterial } from "../application/use-cases/prepare-investigation-search-query-private-material";
import { ReconcileExpiredInvestigationPrivateMaterial } from "../application/use-cases/reconcile-expired-investigation-private-material";
import { planInvestigationTurn } from "../domain/review-investigation";
import { AesGcmInvestigationPrivateMaterialCipher } from "../infrastructure/crypto/aes-gcm-investigation-private-material-cipher";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  CurrentInvestigationExecutionAuthority,
  FixedInvestigationClock,
} from "../testing/investigation-test-kit";

const query = "SensitiveService.call";
const queryHash = sha256(query);
const operationInputHash = sha256(
  canonicalStandardTextSearchOperationInput(queryHash),
);
const reviewRevisionHash = sha256("private-material-review-revision");
const sourcePath = "src/sensitive-service.ts";
const sourcePathHash = sha256(sourcePath);
const materialTtlMs = 5 * 60 * 1_000;
const key = Buffer.alloc(32, 17);

describe("investigation search-query private material lifecycle", () => {
  it("persists no plaintext and hydrates the transient turn requirement after restart", async () => {
    const clock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    const cipher = configuredCipher();
    const digest = new NodeSha256InvestigationDigest();
    const store = new InMemoryInvestigationStore();
    const opened = await openInvestigation({ store, cipher, digest, clock });
    const aggregate = await store.findById(opened.investigationId);
    expect(aggregate).not.toBeNull();
    const searchObligation = aggregate!.obligations.find((obligation) =>
      obligation.canonicalSubject.includes(operationInputHash),
    );
    expect(searchObligation).toBeDefined();
    expect(
      JSON.parse(searchObligation!.canonicalRequirement),
    ).not.toHaveProperty("query");

    const snapshot = store.exportSnapshot();
    expect(JSON.stringify(opened)).not.toContain(query);
    expect(JSON.stringify(aggregate)).not.toContain(query);
    expect(snapshot).not.toContain(query);

    const restarted = InMemoryInvestigationStore.fromSnapshot(snapshot);
    const restored = await restarted.findById(opened.investigationId);
    const hydrated = await new HydrateInvestigationTurnObligations(
      restarted,
      cipher,
      digest,
      clock,
    ).execute({
      investigation: restored!,
      obligationIds: [searchObligation!.obligationId],
    });
    expect(JSON.parse(hydrated[0]!.canonicalRequirement)).toMatchObject({
      query,
      queryHash,
    });
    expect(restarted.exportSnapshot()).not.toContain(query);

    const idempotentRetry = await new OpenReviewInvestigation(
      store,
      new CurrentInvestigationExecutionAuthority(),
      digest,
      clock,
    ).execute(command("open-private-material"));
    expect(idempotentRetry).toEqual(opened);
  });

  it("rejects a v2 snapshot containing a legacy plaintext search requirement", async () => {
    const clock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    const store = new InMemoryInvestigationStore();
    await openInvestigation({
      store,
      cipher: configuredCipher(),
      digest: new NodeSha256InvestigationDigest(),
      clock,
    });
    const snapshot = JSON.parse(store.exportSnapshot()) as Snapshot;
    const investigation = snapshot.investigations[0]![1];
    const searchObligation = investigation.obligations.find((obligation) =>
      obligation.canonicalRequirement.includes(queryHash),
    )!;
    searchObligation.canonicalRequirement =
      canonicalInvestigationEvidenceRequirement({
        requirementVersion: obligationEvidenceRequirementVersion,
        kind: InvestigationEvidenceRequirementKind.CompletePageChain,
        operationKind: InvestigationOperationKind.TextSearch,
        initialOperationInputHash: operationInputHash,
        query,
        sourcePath,
      });

    expect(() =>
      InMemoryInvestigationStore.fromSnapshot(JSON.stringify(snapshot)),
    ).toThrow("investigation_persisted_search_query_forbidden");
  });

  it("fails closed for missing, expired, and tampered material", async () => {
    const clock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    const cipher = configuredCipher();
    const digest = new NodeSha256InvestigationDigest();
    const store = new InMemoryInvestigationStore();
    const opened = await openInvestigation({ store, cipher, digest, clock });
    const aggregate = (await store.findById(opened.investigationId))!;
    const searchObligation = aggregate.obligations.find((obligation) =>
      obligation.canonicalSubject.includes(operationInputHash),
    )!;
    const snapshot = JSON.parse(store.exportSnapshot()) as Snapshot;

    const missingStore = InMemoryInvestigationStore.fromSnapshot(
      JSON.stringify({ ...snapshot, privateMaterials: [] }),
    );
    await expect(
      hydrate(missingStore, cipher, digest, clock, aggregate, searchObligation),
    ).rejects.toThrow("investigation_private_material_unavailable");

    clock.advance(materialTtlMs);
    await expect(
      hydrate(store, cipher, digest, clock, aggregate, searchObligation),
    ).rejects.toThrow("investigation_private_material_unavailable");

    const tamperedSnapshot = structuredClone(snapshot);
    const material = tamperedSnapshot.privateMaterials[0]![1];
    const ciphertext = Buffer.from(material.ciphertextBase64Url, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 1;
    material.ciphertextBase64Url = ciphertext.toString("base64url");
    const tamperedStore = InMemoryInvestigationStore.fromSnapshot(
      JSON.stringify(tamperedSnapshot),
    );
    const freshClock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    await expect(
      hydrate(
        tamperedStore,
        cipher,
        digest,
        freshClock,
        aggregate,
        searchObligation,
      ),
    ).rejects.toThrow("investigation_private_material_invalid");
  });

  it("does not create an aggregate or command when private material is unavailable", async () => {
    const store = new InMemoryInvestigationStore();
    const digest = new NodeSha256InvestigationDigest();
    const clock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    const open = new OpenReviewInvestigation(
      store,
      new CurrentInvestigationExecutionAuthority(),
      digest,
      clock,
    );

    await expect(
      open.execute(command("missing-private-material")),
    ).rejects.toThrow("investigation_private_material_required");
    const snapshot = JSON.parse(store.exportSnapshot()) as Snapshot;
    expect(snapshot.investigations).toEqual([]);
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.privateMaterials).toEqual([]);
  });

  it("defers an active lease and deterministically terminalizes when regeneration is unavailable", async () => {
    const clock = new FixedInvestigationClock(
      new Date("2026-08-04T10:00:00.000Z"),
    );
    const digest = new NodeSha256InvestigationDigest();
    const store = new InMemoryInvestigationStore();
    const opened = await openInvestigation({
      store,
      cipher: configuredCipher(),
      digest,
      clock,
    });
    const aggregate = (await store.findById(opened.investigationId))!;
    const searchObligation = aggregate.obligations.find((obligation) =>
      obligation.canonicalSubject.includes(operationInputHash),
    )!;
    const leased = planInvestigationTurn({
      investigation: aggregate,
      turn: {
        turnId: "turn-private-material-expiry",
        purpose: ReviewInvestigationTurnPurpose.Discovery,
        leasedAtVersion: aggregate.version + 1,
        dossierDigest: aggregate.dossierDigest,
        obligationIds: [searchObligation.obligationId],
        semanticTurnOrdinal: 1,
        criticCycleOrdinal: 0,
        leasedAt: "2026-08-04T10:04:00.000Z",
        expiresAt: "2026-08-04T10:06:00.000Z",
      },
    });
    const reconcile = new ReconcileExpiredInvestigationPrivateMaterial(digest);
    const input = {
      investigation: leased,
      privateMaterialIds: ["private-material-expiry-test"],
      obligationIds: [searchObligation.obligationId],
      expiredAt: "2026-08-04T10:05:00.000Z",
    } as const;

    await expect(reconcile.execute(input)).resolves.toMatchObject({
      disposition:
        InvestigationPrivateMaterialExpiryDisposition.DeferredActiveTurn,
      investigation: { version: leased.version },
      command: null,
    });

    const afterLease = await reconcile.execute({
      ...input,
      expiredAt: leased.activeTurn!.expiresAt,
    });
    const retry = await reconcile.execute({
      ...input,
      expiredAt: leased.activeTurn!.expiresAt,
    });
    expect(afterLease).toEqual(retry);
    expect(afterLease).toMatchObject({
      disposition: InvestigationPrivateMaterialExpiryDisposition.Inconclusive,
      affectedObligationIds: [searchObligation.obligationId],
      expiredTurnId: leased.activeTurn!.turnId,
      investigation: {
        version: leased.version + 1,
        state: ReviewInvestigationState.Inconclusive,
        conclusion: ReviewInvestigationConclusion.Inconclusive,
        activeTurn: null,
      },
      command: {
        commandId: expect.stringMatching(
          /^private-material-expiry-[a-f0-9]{64}$/u,
        ),
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(afterLease.investigation.dossierDigest).not.toBe(
      leased.dossierDigest,
    );
    expect(
      afterLease.investigation.obligations.find(
        (obligation) =>
          obligation.obligationId === searchObligation.obligationId,
      ),
    ).toMatchObject({
      state: InvestigationObligationState.Unresolvable,
      receipt: null,
      unresolvableReason:
        InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
    });
  });
});

async function openInvestigation(input: {
  readonly store: InMemoryInvestigationStore;
  readonly cipher: AesGcmInvestigationPrivateMaterialCipher;
  readonly digest: NodeSha256InvestigationDigest;
  readonly clock: FixedInvestigationClock;
}) {
  const preparer = new PrepareInvestigationSearchQueryPrivateMaterial(
    input.cipher,
    input.digest,
    materialTtlMs,
  );
  return new OpenReviewInvestigation(
    input.store,
    new CurrentInvestigationExecutionAuthority(),
    input.digest,
    input.clock,
    undefined,
    preparer,
  ).execute(command("open-private-material"));
}

function command(commandId: string): OpenReviewInvestigationCommand {
  const inventoryRequirement = {
    requirementVersion: obligationEvidenceRequirementVersionV2,
    kind: InvestigationEvidenceRequirementKind.CompleteInventory,
    reviewRevisionHash,
    treeOid: "3".repeat(40),
    aggregateItemCount: 1,
    aggregateHash: sha256("private-material-inventory"),
    aggregatePathCount: 1,
    aggregatePathSetHash: sha256("private-material-inventory-paths"),
  } as const;
  return {
    commandId,
    scope: {
      workspaceId: "workspace-private-material",
      repositoryConnectionId: "repository-private-material",
      scmRepositoryIdentityId: "scm-private-material",
      pullRequestNumber: 42,
      trustDomain: "trusted-local",
      authorizationScopeHash: sha256("private-material-authorization"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash,
    },
    executionId: "execution-private-material",
    workSlotId: "slot-private-material",
    stableReviewUnitKey: "stable-private-material",
    providerVoteLaneId: "lane-private-material",
    providerStrategyId: "strategy-private-material",
    investigationManifestCanonicalJson: "{}",
    investigationManifestHash: sha256("{}"),
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      ...reviewInvestigationCoverageProfileV2,
      producerReleaseId: "producer-private-material",
    },
    policy: {
      policyId: "private-material-policy-v1",
      maxObligations: 100,
      maxExpansionDepth: 5,
      maxSemanticTurns: 5,
      maxOperationalAttempts: 3,
      maxCriticCycles: 2,
      maxFindings: 20,
      maxProposalsPerTurn: 20,
      maxReceiptsPerTurn: 50,
    },
    seedObligations: [
      {
        kind: InvestigationObligationKind.InventoryWitness,
        canonicalSubject:
          canonicalInventoryObligationSubjectV2(inventoryRequirement),
        canonicalRequirement:
          canonicalInvestigationEvidenceRequirement(inventoryRequirement),
        riskPriority: 100,
      },
      {
        kind: InvestigationObligationKind.ChangedContent,
        canonicalSubject: canonicalFileObligationSubject({
          pathHash: sourcePathHash,
          revision: InvestigationOperationRevision.Head,
        }),
        canonicalRequirement: canonicalInvestigationEvidenceRequirement({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
          path: sourcePath,
          pathHash: sourcePathHash,
          revision: InvestigationOperationRevision.Head,
        }),
        riskPriority: 90,
      },
      {
        kind: InvestigationObligationKind.DirectReferenceSearch,
        canonicalSubject: canonicalPageObligationSubjectV2({
          obligationKind: InvestigationObligationKind.DirectReferenceSearch,
          initialOperationInputHash: operationInputHash,
          probeKind: InvestigationProbeKind.DeclarationIdentifier,
          queryHash,
        }),
        canonicalRequirement: canonicalInvestigationEvidenceRequirement({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompletePageChain,
          operationKind: InvestigationOperationKind.TextSearch,
          initialOperationInputHash: operationInputHash,
          matchMode: InvestigationTextSearchMatchMode.FixedString,
          query,
          queryHash,
          probeKind: InvestigationProbeKind.DeclarationIdentifier,
          paths: ["."],
          pageSize: 500,
          revision: InvestigationOperationRevision.Head,
          sourcePathHash,
          searchPolicyVersion:
            reviewInvestigationCoverageProfileV2.searchPolicyVersion,
        }),
        riskPriority: 80,
      },
    ],
    initialReceipts: [],
  };
}

function configuredCipher(): AesGcmInvestigationPrivateMaterialCipher {
  return new AesGcmInvestigationPrivateMaterialCipher(
    "key-current",
    new Map([["key-current", key]]),
  );
}

function hydrate(
  store: InMemoryInvestigationStore,
  cipher: AesGcmInvestigationPrivateMaterialCipher,
  digest: NodeSha256InvestigationDigest,
  clock: FixedInvestigationClock,
  investigation: NonNullable<
    Awaited<ReturnType<InMemoryInvestigationStore["findById"]>>
  >,
  obligation: (typeof investigation.obligations)[number],
) {
  return new HydrateInvestigationTurnObligations(
    store,
    cipher,
    digest,
    clock,
  ).execute({
    investigation,
    obligationIds: [obligation.obligationId],
  });
}

type Snapshot = {
  investigations: Array<
    [
      string,
      {
        obligations: Array<{ canonicalRequirement: string }>;
        [key: string]: unknown;
      },
    ]
  >;
  commands: unknown[];
  privateMaterials: Array<
    [string, { ciphertextBase64Url: string; [key: string]: unknown }]
  >;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
