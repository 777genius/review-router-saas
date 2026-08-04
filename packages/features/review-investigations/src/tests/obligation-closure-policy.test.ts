import { describe, expect, it } from "vitest";
import {
  InvestigationBinaryArtifactContentKind,
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  VersionedObligationClosurePolicy,
  canonicalBinaryArtifactBoundarySubject,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalPageObligationSubject,
  canonicalRelationObligationSubject,
  canonicalRelationObligationSubjectV2,
  createInvestigationObligation,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  obligationIdentity,
  type InvestigationFileReadEvidence,
  type InvestigationPageEvidence,
  parseInvestigationEvidenceRequirement,
} from "../index";

const hash = (character: string) => character.repeat(64);

describe("VersionedObligationClosurePolicy", () => {
  const policy = new VersionedObligationClosurePolicy();

  it("accepts canonical requirements containing maximum-size protocol text", () => {
    const query = '"'.repeat(4_096);
    const sourcePath = `src/${'"'.repeat(1_992)}.ts`;
    const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
      initialOperationInputHash: hash("a"),
      queryDigest: hash("4"),
      aggregateHash: hash("6"),
      requiredPathCount: 1,
      requiredPathSetHash: hash("8"),
      query,
      sourcePath,
      revision: InvestigationOperationRevision.Head,
    });

    expect(canonicalRequirement.length).toBeGreaterThan(512);
    expect(() =>
      obligationIdentity({
        coverageContractVersion: "review-investigation-coverage.v1",
        stableReviewUnitKey: "unit-long-protocol-text",
        kind: InvestigationObligationKind.DirectCaller,
        canonicalSubject: canonicalRelationObligationSubject({
          obligationKind: InvestigationObligationKind.DirectCaller,
          queryDigest: hash("4"),
          aggregateHash: hash("6"),
        }),
        canonicalRequirement,
      }),
    ).not.toThrow();
  });

  it("proves complete byte coverage for the exact path and revision", () => {
    const obligation = fileObligation(hash("a"));

    expect(
      policy.prove({
        obligation,
        operations: [
          fileEvidence({ receipt: "1", startByte: 0, byteCount: 10 }),
          fileEvidence({
            receipt: "2",
            startByte: 10,
            byteCount: 5,
            eof: true,
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toMatchObject({
      canonicalSubject: obligation.canonicalSubject,
      receiptKind: "blob",
      operationReceiptIds: [hash("1"), hash("2")],
    });
  });

  it("keeps a canonical binary boundary unresolvable by ordinary file evidence", () => {
    const pathHash = hash("a");
    const contentKind = InvestigationBinaryArtifactContentKind.Binary;
    const objectOid = "2".repeat(40);
    const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary,
      path: "assets/image.png",
      pathHash,
      revision: InvestigationOperationRevision.Head,
      contentKind,
      mode: "100644",
      objectOid,
      byteCount: 128,
      status: "modified",
    });
    const obligation = createInvestigationObligation({
      obligationId: hash("d"),
      identity: obligationIdentity({
        coverageContractVersion: "review-investigation-coverage.v1",
        stableReviewUnitKey: "unit-binary",
        kind: InvestigationObligationKind.BinaryArtifact,
        canonicalSubject: canonicalBinaryArtifactBoundarySubject({
          contentKind,
          objectOid,
          pathHash,
          revision: InvestigationOperationRevision.Head,
        }),
        canonicalRequirement,
      }),
      riskPriority: 100,
      origin: InvestigationObligationOrigin.CoverageContract,
    });

    expect(() =>
      policy.prove({
        obligation,
        operations: [
          fileEvidence({
            receipt: "1",
            startByte: 0,
            byteCount: 128,
            eof: true,
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it("rejects a binary boundary whose lifecycle status contradicts its revision", () => {
    const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary,
      path: "assets/removed.png",
      pathHash: hash("a"),
      revision: InvestigationOperationRevision.Head,
      contentKind: InvestigationBinaryArtifactContentKind.Binary,
      mode: "100644",
      objectOid: "2".repeat(40),
      byteCount: 128,
      status: "deleted",
    });

    expect(() =>
      parseInvestigationEvidenceRequirement(canonicalRequirement),
    ).toThrow("investigation_evidence_requirement_invalid");
  });

  it("proves removed changed content from merge-base and rejects an absent-head substitution", () => {
    const pathHash = hash("b");
    const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
      path: "src/removed.ts",
      pathHash,
      revision: InvestigationOperationRevision.MergeBase,
    });
    const obligation = createInvestigationObligation({
      obligationId: hash("d"),
      identity: obligationIdentity({
        coverageContractVersion: "review-investigation-coverage.v1",
        stableReviewUnitKey: "unit-removed",
        kind: InvestigationObligationKind.ChangedContent,
        canonicalSubject: canonicalFileObligationSubject({
          pathHash,
          revision: InvestigationOperationRevision.MergeBase,
        }),
        canonicalRequirement,
      }),
      riskPriority: 100,
      origin: InvestigationObligationOrigin.CoverageContract,
    });

    expect(
      policy.prove({
        obligation,
        operations: [
          fileEvidence({
            receipt: "1",
            startByte: 0,
            byteCount: 10,
            eof: true,
            pathHash,
            revision: InvestigationOperationRevision.MergeBase,
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toMatchObject({ receiptKind: "blob" });

    expect(() =>
      policy.prove({
        obligation,
        operations: [
          fileEvidence({
            receipt: "2",
            startByte: 0,
            byteCount: 10,
            eof: true,
            pathHash,
            revision: InvestigationOperationRevision.Head,
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it.each([
    ["unrelated file", { pathHash: hash("b") }],
    ["wrong revision", { revision: InvestigationOperationRevision.MergeBase }],
  ])("rejects %s evidence", (_label, override) => {
    expect(() =>
      policy.prove({
        obligation: fileObligation(hash("a")),
        operations: [
          fileEvidence({
            receipt: "1",
            startByte: 0,
            byteCount: 15,
            eof: true,
            ...override,
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it("rejects a wrong search query identity", () => {
    const obligation = searchObligation(hash("a"));
    expect(() =>
      policy.prove({
        obligation,
        operations: [pageEvidence({ inputHash: hash("b"), complete: true })],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it("rejects incomplete page chains", () => {
    const obligation = searchObligation(hash("a"));
    expect(() =>
      policy.prove({
        obligation,
        operations: [
          pageEvidence({
            inputHash: hash("a"),
            complete: false,
            nextCursorHash: hash("9"),
          }),
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it("rejects evidence from another obligation even when its operation succeeded", () => {
    const obligation = searchObligation(hash("a"));
    const other = searchObligation(hash("b"));
    const evidence = [pageEvidence({ inputHash: hash("a"), complete: true })];

    expect(
      policy.prove({
        obligation,
        operations: evidence,
        revision: { reviewRevisionHash: hash("f") },
      }).canonicalSubject,
    ).toBe(obligation.canonicalSubject);
    expect(() =>
      policy.prove({
        obligation: other,
        operations: evidence,
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });

  it("closes relation context only when every authenticated search path is read", () => {
    const obligation = relationObligation();
    const related = fileEvidence({
      receipt: "2",
      startByte: 0,
      byteCount: 15,
      eof: true,
      pathHash: hash("7"),
    });

    expect(
      policy.prove({
        obligation,
        operations: [related],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toMatchObject({ receiptKind: "relation" });

    expect(() =>
      policy.prove({
        obligation,
        operations: [{ ...related, pathHash: hash("9") }],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");

    expect(() =>
      policy.prove({
        obligation,
        operations: [
          related,
          { ...related, operationReceiptId: hash("3"), pathHash: hash("9") },
        ],
        revision: { reviewRevisionHash: hash("f") },
      }),
    ).toThrow("investigation_obligation_evidence_mismatch");
  });
});

function fileObligation(pathHash: string) {
  const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
    requirementVersion: obligationEvidenceRequirementVersion,
    kind: InvestigationEvidenceRequirementKind.CompleteFile,
    path: "src/service.ts",
    pathHash,
    revision: InvestigationOperationRevision.Head,
  });
  const identity = obligationIdentity({
    coverageContractVersion: "review-investigation-coverage.v1",
    stableReviewUnitKey: "unit-1",
    kind: InvestigationObligationKind.ChangedContent,
    canonicalSubject: canonicalFileObligationSubject({
      pathHash,
      revision: InvestigationOperationRevision.Head,
    }),
    canonicalRequirement,
  });
  return createInvestigationObligation({
    obligationId: hash("c"),
    identity,
    riskPriority: 100,
    origin: InvestigationObligationOrigin.CoverageContract,
  });
}

function searchObligation(inputHash: string) {
  const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
    requirementVersion: obligationEvidenceRequirementVersion,
    kind: InvestigationEvidenceRequirementKind.CompletePageChain,
    operationKind: InvestigationOperationKind.TextSearch,
    initialOperationInputHash: inputHash,
    query: "service",
    sourcePath: "src/service.ts",
  });
  const identity = obligationIdentity({
    coverageContractVersion: "review-investigation-coverage.v1",
    stableReviewUnitKey: "unit-1",
    kind: InvestigationObligationKind.DirectReferenceSearch,
    canonicalSubject: canonicalPageObligationSubject({
      obligationKind: InvestigationObligationKind.DirectReferenceSearch,
      operationKind: InvestigationOperationKind.TextSearch,
      initialOperationInputHash: inputHash,
    }),
    canonicalRequirement,
  });
  return createInvestigationObligation({
    obligationId: inputHash,
    identity,
    riskPriority: 100,
    origin: InvestigationObligationOrigin.DeterministicExpansion,
  });
}

function relationObligation() {
  const canonicalRequirement = canonicalInvestigationEvidenceRequirement({
    requirementVersion: obligationEvidenceRequirementVersionV2,
    kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
    sourceObligationId: hash("c"),
    initialOperationInputHash: hash("a"),
    queryHash: hash("4"),
    requiredPathCount: 1,
    requiredPathSetHash: hash("8"),
    requiredPathHashes: [hash("7")],
    sourcePathHash: hash("9"),
    revision: InvestigationOperationRevision.Head,
    searchPolicyVersion: "review-investigation-fixed-string-search.v1",
  });
  const identity = obligationIdentity({
    coverageContractVersion: "review-investigation-coverage.v1",
    stableReviewUnitKey: "unit-1",
    kind: InvestigationObligationKind.DirectCaller,
    canonicalSubject: canonicalRelationObligationSubjectV2({
      obligationKind: InvestigationObligationKind.DirectCaller,
      sourceObligationId: hash("c"),
      initialOperationInputHash: hash("a"),
      queryHash: hash("4"),
      requiredPathSetHash: hash("8"),
    }),
    canonicalRequirement,
  });
  return createInvestigationObligation({
    obligationId: hash("e"),
    identity,
    riskPriority: 100,
    origin: InvestigationObligationOrigin.DeterministicExpansion,
  });
}

function fileEvidence(
  input: Readonly<{
    receipt: string;
    startByte: number;
    byteCount: number;
    eof?: boolean;
    pathHash?: string;
    revision?: InvestigationOperationRevision;
  }>,
): InvestigationFileReadEvidence {
  return Object.freeze({
    operationReceiptId: hash(input.receipt),
    operationKey: hash("7"),
    sequence: Number(input.receipt),
    evidenceDigest: hash("6"),
    operationKind: InvestigationOperationKind.FileRead,
    operationInputHash: hash("5"),
    revision: input.revision ?? InvestigationOperationRevision.Head,
    treeOid: "1".repeat(40),
    pathHash: input.pathHash ?? hash("a"),
    blobOid: "2".repeat(40),
    mode: "100644",
    startByte: input.startByte,
    byteCount: input.byteCount,
    contentHash: hash("4"),
    contentKind: null,
    lineCount: null,
    eof: input.eof ?? false,
    complete: input.eof ?? false,
  });
}

function pageEvidence(input: {
  inputHash: string;
  complete: boolean;
  nextCursorHash?: string | null;
}): InvestigationPageEvidence {
  return Object.freeze({
    operationReceiptId: hash("1"),
    operationKey: hash("2"),
    sequence: 1,
    evidenceDigest: hash("3"),
    operationKind: InvestigationOperationKind.TextSearch,
    operationInputHash: input.inputHash,
    treeOid: "1".repeat(40),
    queryDigest: hash("4"),
    cursorInputHash: null,
    pageOrdinal: 0,
    pageItemCount: 2,
    pageItemsHash: hash("5"),
    pagePathHashes: [hash("7")],
    aggregatePathCount: 1,
    aggregatePathSetHash: hash("8"),
    aggregateItemCount: 2,
    aggregateHash: hash("6"),
    complete: input.complete,
    nextCursorHash: input.nextCursorHash ?? null,
  });
}
