import { describe, expect, it } from "vitest";
import { AttestedTurnClosurePreparation } from "../application/attested-turn-closure-preparation";
import { AttestedTurnDiscoveryPreparation } from "../application/attested-turn-discovery-preparation";
import { createVerifiedOperationEvidenceIndex } from "../application/verified-operation-evidence-index";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import {
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationReceiptKind,
  InvestigationTextSearchMatchMode,
  ReviewInvestigationRuntimeProfile,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalInventoryObligationSubject,
  canonicalPageObligationSubjectV2,
  canonicalStandardTextSearchOperationInput,
  createInvestigationObligation,
  createReviewInvestigation,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  obligationIdentity,
  reviewInvestigationCoverageProfileV2,
  type InvestigationObligation,
  type InvestigationPageEvidence,
  type ReviewInvestigation,
} from "../index";

const hash = (character: string) => character.repeat(64);
const revisionHash = hash("4");
const digest = new NodeSha256InvestigationDigest();

describe("AttestedTurnClosurePreparation", () => {
  it("builds an immutable verified receipt and requires exact inventory coverage", async () => {
    const firstPathHash = hash("a");
    const secondPathHash = hash("b");
    const investigation = investigationFixture([
      inventoryObligation(),
      changedContentObligation(hash("2"), "src/a.ts", firstPathHash),
      changedContentObligation(hash("3"), "src/b.ts", secondPathHash),
    ]);
    const operation = await pageEvidence({
      operationReceiptId: hash("9"),
      operationKind: InvestigationOperationKind.CanonicalInventory,
      operationInputHash: hash("5"),
      pathHashes: [secondPathHash, firstPathHash],
    });
    const operationEvidence = createVerifiedOperationEvidenceIndex([operation]);

    const prepared = await new AttestedTurnClosurePreparation(digest).prepare({
      investigation,
      closureClaims: [
        {
          obligationId: hash("1"),
          operationReceiptIds: [operation.operationReceiptId],
        },
      ],
      operationEvidence,
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
    });

    expect(prepared.closureClaims).toHaveLength(1);
    expect(prepared.closureClaims[0]).toMatchObject({
      obligationId: hash("1"),
      receipt: {
        kind: InvestigationReceiptKind.Tree,
        canonicalSubject: canonicalInventoryObligationSubject(revisionHash),
        operationReceiptIds: [hash("9")],
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
      },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.closureClaims)).toBe(true);
    expect(Object.isFrozen(prepared.closureClaims[0]!.receipt)).toBe(true);

    const incompleteOperation = await pageEvidence({
      operationReceiptId: hash("7"),
      operationKind: InvestigationOperationKind.CanonicalInventory,
      operationInputHash: hash("5"),
      pathHashes: [firstPathHash],
    });
    await expect(
      new AttestedTurnClosurePreparation(digest).prepare({
        investigation,
        closureClaims: [
          {
            obligationId: hash("1"),
            operationReceiptIds: [incompleteOperation.operationReceiptId],
          },
        ],
        operationEvidence: createVerifiedOperationEvidenceIndex([
          incompleteOperation,
        ]),
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
      }),
    ).rejects.toThrow("investigation_inventory_seed_mismatch");
  });

  it("matches one inventory path to modified base and head obligations", async () => {
    const pathHash = hash("a");
    const investigation = investigationFixture([
      inventoryObligation(),
      changedContentObligation(
        hash("2"),
        "src/modified.ts",
        pathHash,
        InvestigationOperationRevision.MergeBase,
      ),
      changedContentObligation(
        hash("3"),
        "src/modified.ts",
        pathHash,
        InvestigationOperationRevision.Head,
      ),
    ]);
    const operation = await pageEvidence({
      operationReceiptId: hash("9"),
      operationKind: InvestigationOperationKind.CanonicalInventory,
      operationInputHash: hash("5"),
      pathHashes: [pathHash],
    });

    await expect(
      new AttestedTurnClosurePreparation(digest).prepare({
        investigation,
        closureClaims: [
          {
            obligationId: hash("1"),
            operationReceiptIds: [operation.operationReceiptId],
          },
        ],
        operationEvidence: createVerifiedOperationEvidenceIndex([operation]),
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
      }),
    ).resolves.toMatchObject({ closureClaims: [{ obligationId: hash("1") }] });
  });

  it("copies evidence, folds idempotent repeats, and rejects receipt collisions", async () => {
    const mutablePathHashes = [hash("a")];
    const operation = await pageEvidence({
      operationReceiptId: hash("9"),
      operationKind: InvestigationOperationKind.CanonicalInventory,
      operationInputHash: hash("5"),
      pathHashes: mutablePathHashes,
    });
    const repeated = Object.freeze({
      ...operation,
      sequence: 2,
      evidenceDigest: hash("8"),
    });
    const index = createVerifiedOperationEvidenceIndex([repeated, operation]);

    mutablePathHashes.push(hash("b"));

    expect(index.operationReceiptIds).toEqual([hash("9")]);
    expect(
      (index.get(hash("9")) as InvestigationPageEvidence).pagePathHashes,
    ).toEqual([hash("a")]);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.operationReceiptIds)).toBe(true);
    expect(index.get(hash("9"))?.sequence).toBe(1);
    expect(() =>
      createVerifiedOperationEvidenceIndex([operation, operation]),
    ).not.toThrow();
    expect(() =>
      createVerifiedOperationEvidenceIndex([
        operation,
        { ...operation, pageItemsHash: hash("a") },
      ]),
    ).toThrow("investigation_operation_receipt_collision");
  });
});

describe("AttestedTurnDiscoveryPreparation", () => {
  it("always prepares closed typed searches and dedupes an equivalent provider claim", async () => {
    const query = "Service";
    const queryHash = await digest.digestUtf8(query);
    const operationInputHash = await digest.digestUtf8(
      canonicalStandardTextSearchOperationInput(queryHash),
    );
    const sourcePathHash = hash("a");
    const search = searchObligation({
      queryHash,
      operationInputHash,
      sourcePathHash,
    });
    const investigation = investigationFixture([inventoryObligation(), search]);
    const operation = await pageEvidence({
      operationReceiptId: hash("9"),
      operationKind: InvestigationOperationKind.TextSearch,
      operationInputHash,
      pathHashes: [hash("e")],
    });
    const operationEvidence = createVerifiedOperationEvidenceIndex([operation]);
    const preparation = new AttestedTurnDiscoveryPreparation(digest);
    const closureClaims = [
      {
        obligationId: search.obligationId,
        operationReceiptIds: [operation.operationReceiptId],
      },
    ] as const;

    const serverOwned = await preparation.prepare({
      investigation,
      closureClaims,
      providerClaims: [],
      operationEvidence,
    });
    const deduped = await preparation.prepare({
      investigation,
      closureClaims,
      providerClaims: [
        {
          sourceObligationId: search.obligationId,
          query,
          operationReceiptIds: [operation.operationReceiptId],
        },
      ],
      operationEvidence,
    });

    expect(serverOwned).toHaveLength(1);
    expect(deduped).toEqual(serverOwned);
    expect(serverOwned[0]).toMatchObject({
      sourceObligationId: search.obligationId,
      queryHash,
      expectedInitialOperationInputHash: operationInputHash,
      operations: [{ operationReceiptId: hash("9") }],
    });
    expect(serverOwned[0]).not.toHaveProperty("query");
    expect(Object.isFrozen(serverOwned)).toBe(true);
    expect(Object.isFrozen(serverOwned[0])).toBe(true);
    expect(Object.isFrozen(serverOwned[0]!.operations)).toBe(true);
  });

  it("preserves duplicate provider receipt rejection", async () => {
    const queryHash = await digest.digestUtf8("Service");
    const operationInputHash = await digest.digestUtf8(
      canonicalStandardTextSearchOperationInput(queryHash),
    );
    const search = searchObligation({
      queryHash,
      operationInputHash,
      sourcePathHash: hash("a"),
    });
    const investigation = investigationFixture([inventoryObligation(), search]);
    const operation = await pageEvidence({
      operationReceiptId: hash("9"),
      operationKind: InvestigationOperationKind.TextSearch,
      operationInputHash,
      pathHashes: [],
    });

    await expect(
      new AttestedTurnDiscoveryPreparation(digest).prepare({
        investigation,
        closureClaims: [],
        providerClaims: [
          {
            sourceObligationId: search.obligationId,
            query: "Service",
            operationReceiptIds: [operation.operationReceiptId],
          },
          {
            sourceObligationId: search.obligationId,
            query: "OtherService",
            operationReceiptIds: [operation.operationReceiptId],
          },
        ],
        operationEvidence: createVerifiedOperationEvidenceIndex([operation]),
      }),
    ).rejects.toThrow(
      "investigation_operation_backed_discovery_receipt_reused",
    );
  });
});

function investigationFixture(
  obligations: readonly InvestigationObligation[],
): ReviewInvestigation {
  return createReviewInvestigation({
    investigationId: "investigation-1",
    naturalIdentityHash: hash("0"),
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 1,
      trustDomain: "trusted_managed",
      authorizationScopeHash: hash("9"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: revisionHash,
    },
    executionId: "execution-1",
    workSlotId: "work-slot-1",
    stableReviewUnitKey: "review-unit-1",
    providerVoteLaneId: "provider-lane-1",
    providerStrategyId: "codex-primary",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      ...reviewInvestigationCoverageProfileV2,
      producerReleaseId: "release-1",
    },
    policy: {
      policyId: "policy-1",
      maxObligations: 32,
      maxExpansionDepth: 4,
      maxSemanticTurns: 8,
      maxOperationalAttempts: 4,
      maxCriticCycles: 2,
      maxFindings: 32,
      maxProposalsPerTurn: 16,
      maxReceiptsPerTurn: 32,
    },
    obligations,
    dossierDigest: hash("d"),
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
}

function inventoryObligation(): InvestigationObligation {
  return obligation({
    obligationId: hash("1"),
    kind: InvestigationObligationKind.InventoryWitness,
    canonicalSubject: canonicalInventoryObligationSubject(revisionHash),
    canonicalRequirement: canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteInventory,
      reviewRevisionHash: revisionHash,
    }),
    origin: InvestigationObligationOrigin.CoverageContract,
  });
}

function changedContentObligation(
  obligationId: string,
  path: string,
  pathHash: string,
  revision: InvestigationOperationRevision = InvestigationOperationRevision.Head,
): InvestigationObligation {
  return obligation({
    obligationId,
    kind: InvestigationObligationKind.ChangedContent,
    canonicalSubject: canonicalFileObligationSubject({
      pathHash,
      revision,
    }),
    canonicalRequirement: canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
      path,
      pathHash,
      revision,
    }),
    origin: InvestigationObligationOrigin.CoverageContract,
  });
}

function searchObligation(input: {
  queryHash: string;
  operationInputHash: string;
  sourcePathHash: string;
}): InvestigationObligation {
  return obligation({
    obligationId: hash("6"),
    kind: InvestigationObligationKind.DirectReferenceSearch,
    canonicalSubject: canonicalPageObligationSubjectV2({
      obligationKind: InvestigationObligationKind.DirectReferenceSearch,
      initialOperationInputHash: input.operationInputHash,
      probeKind: InvestigationProbeKind.DeclarationIdentifier,
      queryHash: input.queryHash,
    }),
    canonicalRequirement: canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompletePageChain,
      operationKind: InvestigationOperationKind.TextSearch,
      initialOperationInputHash: input.operationInputHash,
      matchMode: InvestigationTextSearchMatchMode.FixedString,
      queryHash: input.queryHash,
      probeKind: InvestigationProbeKind.DeclarationIdentifier,
      paths: ["."],
      pageSize: 500,
      revision: InvestigationOperationRevision.Head,
      sourcePathHash: input.sourcePathHash,
      searchPolicyVersion:
        reviewInvestigationCoverageProfileV2.searchPolicyVersion,
    }),
    origin: InvestigationObligationOrigin.DeterministicExpansion,
  });
}

function obligation(input: {
  obligationId: string;
  kind: InvestigationObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  origin: InvestigationObligationOrigin;
}): InvestigationObligation {
  return createInvestigationObligation({
    obligationId: input.obligationId,
    identity: obligationIdentity({
      coverageContractVersion:
        reviewInvestigationCoverageProfileV2.coverageContractVersion,
      stableReviewUnitKey: "review-unit-1",
      kind: input.kind,
      canonicalSubject: input.canonicalSubject,
      canonicalRequirement: input.canonicalRequirement,
    }),
    riskPriority: 800_000,
    origin: input.origin,
  });
}

async function pageEvidence(input: {
  operationReceiptId: string;
  operationKind:
    | InvestigationOperationKind.CanonicalInventory
    | InvestigationOperationKind.TextSearch;
  operationInputHash: string;
  pathHashes: readonly string[];
}): Promise<InvestigationPageEvidence> {
  const sortedPathHashes = [...input.pathHashes].sort();
  return Object.freeze({
    operationReceiptId: input.operationReceiptId,
    operationKey: hash("7"),
    sequence: 1,
    operationKind: input.operationKind,
    operationInputHash: input.operationInputHash,
    evidenceDigest: hash("6"),
    treeOid: "3".repeat(40),
    queryDigest: hash("4"),
    cursorInputHash: null,
    pageOrdinal: 0,
    pageItemCount: input.pathHashes.length,
    pageItemsHash: hash("3"),
    pagePathHashes: input.pathHashes,
    aggregatePathCount: new Set(input.pathHashes).size,
    aggregatePathSetHash: await digest.digestUtf8(
      JSON.stringify(sortedPathHashes),
    ),
    aggregateItemCount: input.pathHashes.length,
    aggregateHash: hash("2"),
    complete: true,
    nextCursorHash: null,
  });
}
