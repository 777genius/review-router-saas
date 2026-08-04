import { describe, expect, it } from "vitest";
import {
  InvestigationBinaryArtifactContentKind,
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationTextSearchMatchMode,
  VersionedCoverageExpansionPolicy,
  VersionedCoverageSeedPolicy,
  canonicalBinaryArtifactBoundarySubject,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalInventoryObligationSubjectV2,
  canonicalPageObligationSubjectV2,
  createInvestigationObligation,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  obligationIdentity,
  reviewInvestigationCoverageProfileV2,
  type InvestigationPageEvidence,
  type ReviewInvestigationContract,
  type SeedInvestigationObligation,
} from "../index";

const hash = (character: string) => character.repeat(64);
const queryHash = hash("a");
const operationInputHash = hash("b");
const sourcePathHash = hash("c");
const pathSetHash = hash("d");

describe("versioned coverage policies", () => {
  it("accepts and orders the exact Action V2 seed schema", () => {
    const supplied = [probeSeed(), changedSeed(), inventorySeed()] as const;

    const seeds = new VersionedCoverageSeedPolicy().seed({
      contract: contract(),
      supplied,
    });

    expect(seeds.map((item) => item.kind)).toEqual([
      InvestigationObligationKind.ChangedContent,
      InvestigationObligationKind.DirectReferenceSearch,
      InvestigationObligationKind.InventoryWitness,
    ]);
    expect(
      seeds.find(
        (item) =>
          item.kind === InvestigationObligationKind.DirectReferenceSearch,
      ),
    ).toMatchObject({
      origin: InvestigationObligationOrigin.DeterministicExpansion,
    });
    expect(
      JSON.parse(
        seeds.find(
          (item) =>
            item.kind === InvestigationObligationKind.DirectReferenceSearch,
        )!.canonicalRequirement,
      ),
    ).not.toHaveProperty("query");
    expect(
      new VersionedCoverageSeedPolicy().seed({
        contract: contract(),
        supplied: [...supplied].reverse(),
      }),
    ).toEqual(seeds);
  });

  it("rejects a legacy changed-file seed under the V2 capability", () => {
    expect(() =>
      new VersionedCoverageSeedPolicy().seed({
        contract: contract(),
        supplied: [
          inventorySeed(),
          {
            ...changedSeed(),
            canonicalRequirement: canonicalInvestigationEvidenceRequirement({
              requirementVersion: obligationEvidenceRequirementVersion,
              kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
              path: "src/service.ts",
              pathHash: sourcePathHash,
              revision: InvestigationOperationRevision.Head,
              referenceSearch: {
                query: "service",
                operationInputHash,
              },
            }),
          },
          probeSeed(),
        ],
      }),
    ).toThrow("investigation_coverage_seed_invalid");
  });

  it("rejects unknown V2 requirement keys", () => {
    const probe = probeSeed();
    expect(() =>
      new VersionedCoverageSeedPolicy().seed({
        contract: contract(),
        supplied: [
          inventorySeed(),
          changedSeed(),
          {
            ...probe,
            canonicalRequirement: JSON.stringify({
              ...JSON.parse(probe.canonicalRequirement),
              unknownPolicyInput: true,
            }),
          },
        ],
      }),
    ).toThrow("investigation_evidence_requirement_invalid");
  });

  it("accepts independent modified base/head binary boundaries", () => {
    const seeds = new VersionedCoverageSeedPolicy().seed({
      contract: contract(),
      supplied: [
        inventorySeed(),
        changedSeed(InvestigationOperationRevision.MergeBase),
        changedSeed(InvestigationOperationRevision.Head),
        binaryBoundarySeed(InvestigationOperationRevision.MergeBase),
        binaryBoundarySeed(InvestigationOperationRevision.Head),
      ],
    });

    expect(
      seeds.filter(
        (seed) => seed.kind === InvestigationObligationKind.ChangedContent,
      ),
    ).toHaveLength(2);
    expect(
      seeds.filter(
        (seed) => seed.kind === InvestigationObligationKind.BinaryArtifact,
      ),
    ).toEqual([
      expect.objectContaining({
        origin: InvestigationObligationOrigin.CoverageContract,
      }),
      expect.objectContaining({
        origin: InvestigationObligationOrigin.CoverageContract,
      }),
    ]);
  });

  it("rejects a duplicate changed target at the same revision", () => {
    expect(() =>
      new VersionedCoverageSeedPolicy().seed({
        contract: contract(),
        supplied: [inventorySeed(), changedSeed(), changedSeed()],
      }),
    ).toThrow("investigation_coverage_seed_duplicate");
  });

  it("rejects a binary boundary without its matching changed target", () => {
    expect(() =>
      new VersionedCoverageSeedPolicy().seed({
        contract: contract(),
        supplied: [
          inventorySeed(),
          changedSeed(InvestigationOperationRevision.MergeBase),
          binaryBoundarySeed(),
        ],
      }),
    ).toThrow("investigation_coverage_seed_invalid");
  });

  it("derives a deterministic DirectCaller from an exploratory changed-content search", () => {
    const source = obligation(changedSeed(), hash("1"));
    const claim = discoveryClaim([searchEvidence({ pathHashes: [hash("e")] })]);
    const policy = new VersionedCoverageExpansionPolicy();

    const additions = policy.expand({
      contract: contract(),
      currentObligations: [source],
      discoveryClaims: [claim],
    });

    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({
      kind: InvestigationObligationKind.DirectCaller,
      origin: InvestigationObligationOrigin.DeterministicExpansion,
      riskPriority: source.riskPriority,
    });
    expect(JSON.parse(additions[0]!.canonicalRequirement)).toEqual({
      initialOperationInputHash: operationInputHash,
      kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
      queryHash,
      requirementVersion: obligationEvidenceRequirementVersionV2,
      requiredPathCount: 1,
      requiredPathHashes: [hash("e")],
      requiredPathSetHash: pathSetHash,
      revision: InvestigationOperationRevision.Head,
      searchPolicyVersion: contract().searchPolicyVersion,
      sourceObligationId: source.obligationId,
      sourcePathHash,
    });

    const existing = obligation(additions[0]!, hash("2"));
    expect(
      policy.expand({
        contract: contract(),
        currentObligations: [source, existing],
        discoveryClaims: [claim],
      }),
    ).toEqual([]);
  });

  it("dedupes and orders equivalent claims independently of receipt order", () => {
    const source = obligation(changedSeed(), hash("1"));
    const firstPage = searchEvidence({
      receipt: "3",
      complete: false,
      nextCursorHash: hash("9"),
      pathHashes: [hash("e")],
      aggregatePathCount: 1,
      aggregateItemCount: 1,
    });
    const secondPage = searchEvidence({
      receipt: "4",
      inputHash: hash("5"),
      cursorInputHash: hash("9"),
      pageOrdinal: 1,
      pathHashes: [hash("f")],
      aggregatePathCount: 2,
      aggregateItemCount: 2,
    });
    const claim = discoveryClaim([secondPage, firstPage]);
    const equivalent = discoveryClaim([
      { ...firstPage, operationReceiptId: hash("7") },
      { ...secondPage, operationReceiptId: hash("8") },
    ]);

    const additions = new VersionedCoverageExpansionPolicy().expand({
      contract: contract(),
      currentObligations: [source],
      discoveryClaims: [equivalent, claim],
    });

    expect(additions).toHaveLength(1);
    expect(
      JSON.parse(additions[0]!.canonicalRequirement).requiredPathHashes,
    ).toEqual([hash("e"), hash("f")]);
  });

  it.each([
    ["wrong query operation hash", [searchEvidence({ inputHash: hash("0") })]],
    [
      "incomplete chain",
      [
        searchEvidence({
          complete: false,
          nextCursorHash: hash("9"),
        }),
      ],
    ],
  ])("rejects %s", (_label, operations) => {
    expect(() =>
      new VersionedCoverageExpansionPolicy().expand({
        contract: contract(),
        currentObligations: [obligation(changedSeed(), hash("1"))],
        discoveryClaims: [discoveryClaim(operations)],
      }),
    ).toThrow("investigation_operation_backed_discovery_invalid");
  });

  it("does not derive relation work from a complete negative search", () => {
    expect(
      new VersionedCoverageExpansionPolicy().expand({
        contract: contract(),
        currentObligations: [obligation(changedSeed(), hash("1"))],
        discoveryClaims: [
          discoveryClaim([
            searchEvidence({ pathHashes: [], aggregatePathCount: 0 }),
          ]),
        ],
      }),
    ).toEqual([]);
  });
});

function contract(): ReviewInvestigationContract {
  return {
    ...reviewInvestigationCoverageProfileV2,
    producerReleaseId: "release-1",
  };
}

function inventorySeed(): SeedInvestigationObligation {
  const requirement = {
    requirementVersion: obligationEvidenceRequirementVersionV2,
    kind: InvestigationEvidenceRequirementKind.CompleteInventory,
    reviewRevisionHash: hash("f"),
    treeOid: "1".repeat(40),
    aggregateItemCount: 1,
    aggregateHash: hash("e"),
    aggregatePathCount: 1,
    aggregatePathSetHash: hash("f"),
  } as const;
  return {
    kind: InvestigationObligationKind.InventoryWitness,
    canonicalSubject: canonicalInventoryObligationSubjectV2(requirement),
    canonicalRequirement:
      canonicalInvestigationEvidenceRequirement(requirement),
    riskPriority: 1_000_000,
  };
}

function changedSeed(
  revision = InvestigationOperationRevision.Head,
): SeedInvestigationObligation {
  return {
    kind: InvestigationObligationKind.ChangedContent,
    canonicalSubject: canonicalFileObligationSubject({
      pathHash: sourcePathHash,
      revision,
    }),
    canonicalRequirement: canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
      path: "src/service.ts",
      pathHash: sourcePathHash,
      revision,
    }),
    riskPriority: 800_000,
  };
}

function binaryBoundarySeed(
  revision = InvestigationOperationRevision.Head,
): SeedInvestigationObligation {
  const contentKind = InvestigationBinaryArtifactContentKind.Binary;
  const objectOid = "1".repeat(40);
  return {
    kind: InvestigationObligationKind.BinaryArtifact,
    canonicalSubject: canonicalBinaryArtifactBoundarySubject({
      contentKind,
      objectOid,
      pathHash: sourcePathHash,
      revision,
    }),
    canonicalRequirement: canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary,
      path: "src/service.ts",
      pathHash: sourcePathHash,
      revision,
      contentKind,
      mode: "100644",
      objectOid,
      byteCount: 64,
      status: "modified",
    }),
    riskPriority: 800_000,
  };
}

function probeSeed(): SeedInvestigationObligation {
  return {
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
      query: "service",
      queryHash,
      probeKind: InvestigationProbeKind.DeclarationIdentifier,
      paths: ["."],
      pageSize: 500,
      revision: InvestigationOperationRevision.Head,
      sourcePathHash,
      searchPolicyVersion: contract().searchPolicyVersion,
    }),
    riskPriority: 700_000,
  };
}

function obligation(seed: SeedInvestigationObligation, obligationId: string) {
  const identity = obligationIdentity({
    coverageContractVersion: contract().coverageContractVersion,
    stableReviewUnitKey: "unit-1",
    kind: seed.kind,
    canonicalSubject: seed.canonicalSubject,
    canonicalRequirement: seed.canonicalRequirement,
  });
  return createInvestigationObligation({
    obligationId,
    identity,
    riskPriority: seed.riskPriority,
    origin:
      seed.kind === InvestigationObligationKind.ChangedContent
        ? InvestigationObligationOrigin.CoverageContract
        : InvestigationObligationOrigin.DeterministicExpansion,
  });
}

function discoveryClaim(
  operations: readonly InvestigationPageEvidence[],
  authenticatedPathSetHash = pathSetHash,
) {
  return Object.freeze({
    sourceObligationId: hash("1"),
    query: "service",
    queryHash,
    expectedInitialOperationInputHash: operationInputHash,
    authenticatedPathSetHash,
    operations: Object.freeze(operations),
  });
}

function searchEvidence(
  input: Readonly<{
    receipt?: string;
    inputHash?: string;
    complete?: boolean;
    nextCursorHash?: string | null;
    cursorInputHash?: string | null;
    pageOrdinal?: number;
    pathHashes?: readonly string[];
    aggregatePathCount?: number;
    aggregateItemCount?: number;
  }> = {},
): InvestigationPageEvidence {
  const pathHashes = input.pathHashes ?? [hash("e")];
  return Object.freeze({
    operationReceiptId: hash(input.receipt ?? "3"),
    operationKey: hash("4"),
    sequence: (input.pageOrdinal ?? 0) + 1,
    evidenceDigest: hash("5"),
    operationKind: InvestigationOperationKind.TextSearch,
    operationInputHash: input.inputHash ?? operationInputHash,
    treeOid: "1".repeat(40),
    queryDigest: hash("6"),
    cursorInputHash: input.cursorInputHash ?? null,
    pageOrdinal: input.pageOrdinal ?? 0,
    pageItemCount: 1,
    pageItemsHash: hash("7"),
    pagePathHashes: Object.freeze([...pathHashes]),
    aggregatePathCount: input.aggregatePathCount ?? pathHashes.length,
    aggregatePathSetHash: pathSetHash,
    aggregateItemCount: input.aggregateItemCount ?? 1,
    aggregateHash: hash("8"),
    complete: input.complete ?? true,
    nextCursorHash: input.nextCursorHash ?? null,
  });
}
