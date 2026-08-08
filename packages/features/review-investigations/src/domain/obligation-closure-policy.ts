import {
  canonicalJson,
  ReviewInvestigationDomainError,
} from "./canonicalization";
import type { InvestigationObligation } from "./investigation-obligation";
import {
  InvestigationOperationKind,
  InvestigationOperationRevision,
  type InvestigationFileReadEvidence,
  type InvestigationGitFactEvidence,
  type InvestigationPageEvidence,
  type VerifiedInvestigationOperationEvidence,
} from "./investigation-operation-evidence";
import { InvestigationObligationKind } from "./review-investigation-types";

export const obligationEvidenceRequirementVersion = 1 as const;
export const obligationEvidenceRequirementVersionV2 = 2 as const;
export const relationSearchProofVersion = 1 as const;
export const obligationClosurePolicyVersion =
  "review-investigation-obligation-closure.v2" as const;
export const investigationDiscoveryQueryMaximumLength = 1_024;
export const investigationRelationPathMaximumCount = 512;

export enum InvestigationTextSearchMatchMode {
  FixedString = "fixed_string",
}

export enum InvestigationProbeKind {
  DeclarationIdentifier = "declaration_identifier",
  ImportExportIdentifier = "import_export_identifier",
  ModulePath = "module_path",
  StructuredKey = "structured_key",
  RuntimeContractIdentifier = "runtime_contract_identifier",
  SideEffectIdentifier = "side_effect_identifier",
  PreviousPath = "previous_path",
  BasenameFallback = "basename_fallback",
}

export enum InvestigationEvidenceRequirementKind {
  BinaryArtifactBoundary = "binary_artifact_boundary",
  CompleteInventory = "complete_inventory",
  CompleteChangedFile = "complete_changed_file",
  CompleteFile = "complete_file",
  CompletePageChain = "complete_page_chain",
  CompleteGitFact = "complete_git_fact",
  CompleteRelationContext = "complete_relation_context",
}

export enum InvestigationBinaryArtifactContentKind {
  Binary = "binary",
  Gitlink = "gitlink",
  LfsPointer = "lfs_pointer",
  Oversized = "oversized",
}

export type BinaryArtifactBoundaryRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary;
  path: string;
  pathHash: string;
  revision: InvestigationOperationRevision;
  contentKind: InvestigationBinaryArtifactContentKind;
  mode: string;
  objectOid: string;
  byteCount: number | null;
  status: "added" | "deleted" | "modified" | "type_changed" | "exact_rename";
}>;

export type LegacyCompleteInventoryRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompleteInventory;
  reviewRevisionHash: string;
}>;

export type CompleteInventoryRequirementV2 = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersionV2;
  kind: InvestigationEvidenceRequirementKind.CompleteInventory;
  reviewRevisionHash: string;
  treeOid: string;
  aggregateItemCount: number;
  aggregateHash: string;
  aggregatePathCount: number;
  aggregatePathSetHash: string;
}>;

export type CompleteInventoryRequirement =
  | LegacyCompleteInventoryRequirement
  | CompleteInventoryRequirementV2;

export type CompleteFileRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompleteFile;
  path: string;
  pathHash: string;
  revision: InvestigationOperationRevision;
}>;

export type LegacyCompleteChangedFileRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompleteChangedFile;
  path: string;
  pathHash: string;
  revision: InvestigationOperationRevision.Head;
  referenceSearch: Readonly<{
    query: string;
    operationInputHash: string;
  }>;
}>;

export type CompleteChangedFileRequirementV2 = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersionV2;
  kind: InvestigationEvidenceRequirementKind.CompleteChangedFile;
  path: string;
  pathHash: string;
  revision:
    | InvestigationOperationRevision.Head
    | InvestigationOperationRevision.MergeBase;
}>;

export type CompleteChangedFileRequirement =
  | LegacyCompleteChangedFileRequirement
  | CompleteChangedFileRequirementV2;

export type LegacyCompletePageChainRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompletePageChain;
  operationKind:
    | InvestigationOperationKind.DirectoryList
    | InvestigationOperationKind.TextSearch;
  initialOperationInputHash: string;
  query: string;
  sourcePath: string;
}>;

export type CompletePageChainRequirementV2 = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersionV2;
  kind: InvestigationEvidenceRequirementKind.CompletePageChain;
  operationKind: InvestigationOperationKind.TextSearch;
  initialOperationInputHash: string;
  matchMode: InvestigationTextSearchMatchMode.FixedString;
  queryHash: string;
  probeKind: InvestigationProbeKind;
  paths: readonly ["."];
  pageSize: 500;
  revision: InvestigationOperationRevision.Head;
  sourcePathHash: string;
  searchPolicyVersion: string;
}>;

export type SuppliedCompletePageChainRequirementV2 =
  CompletePageChainRequirementV2 &
    Readonly<{
      query: string;
    }>;

export type CompletePageChainRequirement =
  | LegacyCompletePageChainRequirement
  | CompletePageChainRequirementV2;

export type CompleteGitFactRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompleteGitFact;
  fact: "merge_base" | "changed_paths" | "diff_stat";
}>;

export type LegacyCompleteRelationContextRequirement = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersion;
  kind: InvestigationEvidenceRequirementKind.CompleteRelationContext;
  initialOperationInputHash: string;
  queryDigest: string;
  aggregateHash: string;
  requiredPathCount: number;
  requiredPathSetHash: string;
  query: string;
  sourcePath: string;
  revision: InvestigationOperationRevision;
}>;

export type CompleteRelationContextRequirementV2 = Readonly<{
  requirementVersion: typeof obligationEvidenceRequirementVersionV2;
  kind: InvestigationEvidenceRequirementKind.CompleteRelationContext;
  sourceObligationId: string;
  initialOperationInputHash: string;
  queryHash: string;
  requiredPathCount: number;
  requiredPathSetHash: string;
  requiredPathHashes: readonly string[];
  searchProofVersion?: typeof relationSearchProofVersion;
  /** @deprecated Session-keyed digest retained only as a search-proof marker. */
  requiredQueryDigest?: string;
  sourcePathHash: string;
  revision: InvestigationOperationRevision.Head;
  searchPolicyVersion: string;
}>;

export type CompleteRelationContextRequirement =
  | LegacyCompleteRelationContextRequirement
  | CompleteRelationContextRequirementV2;

export type SuppliedCompleteRelationContextRequirementV2 =
  CompleteRelationContextRequirementV2 &
    Readonly<{
      query: string;
    }>;

export type InvestigationEvidenceRequirement =
  | BinaryArtifactBoundaryRequirement
  | CompleteInventoryRequirement
  | CompleteChangedFileRequirement
  | CompleteFileRequirement
  | CompletePageChainRequirement
  | CompleteGitFactRequirement
  | CompleteRelationContextRequirement;

export type SuppliedInvestigationEvidenceRequirement =
  | Exclude<
      InvestigationEvidenceRequirement,
      CompletePageChainRequirementV2 | CompleteRelationContextRequirementV2
    >
  | SuppliedCompletePageChainRequirementV2
  | SuppliedCompleteRelationContextRequirementV2;

export type ObligationClosureProof = Readonly<{
  closurePolicyVersion: typeof obligationClosurePolicyVersion;
  canonicalSubject: string;
  receiptKind: "blob" | "tree" | "search" | "git_fact" | "relation";
  operationReceiptIds: readonly string[];
  operationKeys: readonly string[];
  evidenceDigests: readonly string[];
}>;

export enum ObligationClosureDecisionKind {
  Accepted = "accepted",
  EvidenceMismatch = "evidence_mismatch",
}

export type ObligationClosureDecision =
  | Readonly<{
      kind: ObligationClosureDecisionKind.Accepted;
      proof: ObligationClosureProof;
    }>
  | Readonly<{
      kind: ObligationClosureDecisionKind.EvidenceMismatch;
    }>;

export interface ObligationClosurePolicy {
  decide(input: {
    readonly obligation: InvestigationObligation;
    readonly operations: readonly VerifiedInvestigationOperationEvidence[];
    readonly revision: Readonly<{
      reviewRevisionHash: string;
    }>;
  }): ObligationClosureDecision;
  prove(input: {
    readonly obligation: InvestigationObligation;
    readonly operations: readonly VerifiedInvestigationOperationEvidence[];
    readonly revision: Readonly<{
      reviewRevisionHash: string;
    }>;
  }): ObligationClosureProof;
}

export class VersionedObligationClosurePolicy implements ObligationClosurePolicy {
  decide(input: {
    readonly obligation: InvestigationObligation;
    readonly operations: readonly VerifiedInvestigationOperationEvidence[];
    readonly revision: Readonly<{ reviewRevisionHash: string }>;
  }): ObligationClosureDecision {
    try {
      return Object.freeze({
        kind: ObligationClosureDecisionKind.Accepted,
        proof: this.prove(input),
      });
    } catch (error) {
      if (
        error instanceof ReviewInvestigationDomainError &&
        error.code === "investigation_obligation_evidence_mismatch"
      ) {
        return Object.freeze({
          kind: ObligationClosureDecisionKind.EvidenceMismatch,
        });
      }
      throw error;
    }
  }

  prove(input: {
    readonly obligation: InvestigationObligation;
    readonly operations: readonly VerifiedInvestigationOperationEvidence[];
    readonly revision: Readonly<{ reviewRevisionHash: string }>;
  }): ObligationClosureProof {
    if (input.operations.length === 0) {
      throw invalidClosure();
    }
    const requirement = parseInvestigationEvidenceRequirement(
      input.obligation.canonicalRequirement,
    );
    const canonicalSubject = proveRequirement({
      obligation: input.obligation,
      operations: input.operations,
      revision: input.revision,
      requirement,
    });
    if (canonicalSubject !== input.obligation.canonicalSubject) {
      throw invalidClosure();
    }
    return Object.freeze({
      closurePolicyVersion: obligationClosurePolicyVersion,
      canonicalSubject,
      receiptKind: receiptKind(requirement),
      operationReceiptIds: Object.freeze(
        input.operations.map((item) => item.operationReceiptId).sort(),
      ),
      operationKeys: Object.freeze(
        input.operations.map((item) => item.operationKey).sort(),
      ),
      evidenceDigests: Object.freeze(
        input.operations.map((item) => item.evidenceDigest).sort(),
      ),
    });
  }
}

export function canonicalInvestigationEvidenceRequirement(
  requirement:
    | InvestigationEvidenceRequirement
    | SuppliedInvestigationEvidenceRequirement,
): string {
  return canonicalJson(requirement);
}

export function toPersistedInvestigationEvidenceRequirement(
  requirement: SuppliedInvestigationEvidenceRequirement,
): InvestigationEvidenceRequirement {
  if (
    requirement.requirementVersion !== obligationEvidenceRequirementVersionV2 ||
    (requirement.kind !==
      InvestigationEvidenceRequirementKind.CompletePageChain &&
      requirement.kind !==
        InvestigationEvidenceRequirementKind.CompleteRelationContext)
  ) {
    return requirement;
  }
  const { query: _privateQuery, ...persisted } = requirement;
  void _privateQuery;
  return Object.freeze(persisted);
}

export function hydrateInvestigationEvidenceRequirement(
  requirement: InvestigationEvidenceRequirement,
  query: string,
): SuppliedInvestigationEvidenceRequirement {
  if (
    requirement.requirementVersion !== obligationEvidenceRequirementVersionV2 ||
    (requirement.kind !==
      InvestigationEvidenceRequirementKind.CompletePageChain &&
      requirement.kind !==
        InvestigationEvidenceRequirementKind.CompleteRelationContext)
  ) {
    throw invalidRequirement();
  }
  return Object.freeze({
    ...requirement,
    query: boundedCanonicalQuery(query),
  });
}

export function canonicalStandardTextSearchOperationInput(
  queryHash: string,
): string {
  return canonicalJson({
    caseSensitive: true,
    cursor: null,
    pageSize: 500,
    paths: ["."],
    query: queryHash,
    revision: InvestigationOperationRevision.Head,
  });
}

export function canonicalInventoryObligationSubject(
  reviewRevisionHash: string,
): string {
  return canonicalJson({
    kind: InvestigationOperationKind.CanonicalInventory,
    reviewRevisionHash,
    subjectVersion: 1,
  });
}

export function canonicalInventoryObligationSubjectV2(
  input: Omit<CompleteInventoryRequirementV2, "kind" | "requirementVersion">,
): string {
  return canonicalJson({
    aggregateHash: input.aggregateHash,
    aggregateItemCount: input.aggregateItemCount,
    aggregatePathCount: input.aggregatePathCount,
    aggregatePathSetHash: input.aggregatePathSetHash,
    kind: InvestigationOperationKind.CanonicalInventory,
    reviewRevisionHash: input.reviewRevisionHash,
    subjectVersion: 2,
    treeOid: input.treeOid,
  });
}

export function canonicalFileObligationSubject(input: {
  readonly pathHash: string;
  readonly revision: InvestigationOperationRevision;
}): string {
  return canonicalJson({
    kind: InvestigationOperationKind.FileRead,
    pathHash: input.pathHash,
    revision: input.revision,
    subjectVersion: 1,
  });
}

export function canonicalBinaryArtifactBoundarySubject(input: {
  readonly contentKind: InvestigationBinaryArtifactContentKind;
  readonly objectOid: string;
  readonly pathHash: string;
  readonly revision: InvestigationOperationRevision;
}): string {
  return canonicalJson({
    contentKind: input.contentKind,
    kind: InvestigationObligationKind.BinaryArtifact,
    objectOid: input.objectOid,
    pathHash: input.pathHash,
    revision: input.revision,
    subjectVersion: 1,
  });
}

export function canonicalPageObligationSubject(input: {
  readonly obligationKind: InvestigationObligationKind;
  readonly operationKind:
    | InvestigationOperationKind.DirectoryList
    | InvestigationOperationKind.TextSearch;
  readonly initialOperationInputHash: string;
}): string {
  return canonicalJson({
    initialOperationInputHash: input.initialOperationInputHash,
    kind: input.operationKind,
    obligationKind: input.obligationKind,
    subjectVersion: 1,
  });
}

export function canonicalPageObligationSubjectV2(input: {
  readonly obligationKind: InvestigationObligationKind;
  readonly initialOperationInputHash: string;
  readonly probeKind: InvestigationProbeKind;
  readonly queryHash: string;
}): string {
  return canonicalJson({
    initialOperationInputHash: input.initialOperationInputHash,
    kind: InvestigationOperationKind.TextSearch,
    matchMode: InvestigationTextSearchMatchMode.FixedString,
    obligationKind: input.obligationKind,
    probeKind: input.probeKind,
    queryHash: input.queryHash,
    subjectVersion: 1,
  });
}

export function canonicalGitFactObligationSubject(
  fact: CompleteGitFactRequirement["fact"],
): string {
  return canonicalJson({
    fact,
    kind: InvestigationOperationKind.GitFact,
    subjectVersion: 1,
  });
}

export function canonicalRelationObligationSubject(input: {
  readonly obligationKind: InvestigationObligationKind;
  readonly queryDigest: string;
  readonly aggregateHash: string;
}): string {
  return canonicalJson({
    aggregateHash: input.aggregateHash,
    kind: "relation_context",
    obligationKind: input.obligationKind,
    queryDigest: input.queryDigest,
    subjectVersion: 1,
  });
}

export function canonicalRelationObligationSubjectV2(input: {
  readonly obligationKind: InvestigationObligationKind;
  readonly sourceObligationId: string;
  readonly initialOperationInputHash: string;
  readonly queryHash: string;
  readonly requiredPathSetHash: string;
}): string {
  return canonicalJson({
    initialOperationInputHash: input.initialOperationInputHash,
    kind: "relation_context",
    obligationKind: input.obligationKind,
    queryHash: input.queryHash,
    requiredPathSetHash: input.requiredPathSetHash,
    sourceObligationId: input.sourceObligationId,
    subjectVersion: 2,
  });
}

export function parseInvestigationEvidenceRequirement(
  value: string,
): InvestigationEvidenceRequirement {
  return parseRequirement(value, false) as InvestigationEvidenceRequirement;
}

export function parseSuppliedInvestigationEvidenceRequirement(
  value: string,
): SuppliedInvestigationEvidenceRequirement {
  return parseRequirement(
    value,
    true,
  ) as SuppliedInvestigationEvidenceRequirement;
}

function parseRequirement(
  value: string,
  supplied: boolean,
): InvestigationEvidenceRequirement | SuppliedInvestigationEvidenceRequirement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidRequirement();
  }
  const root = exactRecord(parsed);
  if (
    root.requirementVersion !== obligationEvidenceRequirementVersion &&
    root.requirementVersion !== obligationEvidenceRequirementVersionV2
  ) {
    throw invalidRequirement();
  }
  let requirement: InvestigationEvidenceRequirement;
  switch (root.kind) {
    case InvestigationEvidenceRequirementKind.BinaryArtifactBoundary: {
      exactKeys(root, [
        "byteCount",
        "contentKind",
        "kind",
        "mode",
        "objectOid",
        "path",
        "pathHash",
        "requirementVersion",
        "revision",
        "status",
      ]);
      const boundaryRevision = revision(root.revision);
      const status = binaryArtifactStatus(root.status);
      if (
        (status === "added" &&
          boundaryRevision !== InvestigationOperationRevision.Head) ||
        (status === "deleted" &&
          boundaryRevision !== InvestigationOperationRevision.MergeBase)
      ) {
        throw invalidRequirement();
      }
      requirement = Object.freeze({
        requirementVersion: obligationEvidenceRequirementVersion,
        kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary,
        path: boundedText(root.path, "path", 2_000),
        pathHash: sha256(root.pathHash),
        revision: boundaryRevision,
        contentKind: enumValue(
          root.contentKind,
          InvestigationBinaryArtifactContentKind,
        ),
        mode: fileMode(root.mode),
        objectOid: gitObjectOid(root.objectOid),
        byteCount: optionalNonNegativeInteger(root.byteCount),
        status,
      });
      break;
    }
    case InvestigationEvidenceRequirementKind.CompleteInventory:
      if (root.requirementVersion === obligationEvidenceRequirementVersionV2) {
        exactKeys(root, [
          "aggregateHash",
          "aggregateItemCount",
          "aggregatePathCount",
          "aggregatePathSetHash",
          "kind",
          "requirementVersion",
          "reviewRevisionHash",
          "treeOid",
        ]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompleteInventory,
          reviewRevisionHash: sha256(root.reviewRevisionHash),
          treeOid: gitObjectOid(root.treeOid),
          aggregateItemCount: nonNegativeInteger(
            root.aggregateItemCount,
            250_000,
          ),
          aggregateHash: sha256(root.aggregateHash),
          aggregatePathCount: nonNegativeInteger(
            root.aggregatePathCount,
            500_000,
          ),
          aggregatePathSetHash: sha256(root.aggregatePathSetHash),
        });
      } else {
        exactKeys(root, ["kind", "requirementVersion", "reviewRevisionHash"]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompleteInventory,
          reviewRevisionHash: sha256(root.reviewRevisionHash),
        });
      }
      break;
    case InvestigationEvidenceRequirementKind.CompleteFile:
      exactKeys(root, [
        "kind",
        "path",
        "pathHash",
        "requirementVersion",
        "revision",
      ]);
      requirement = Object.freeze({
        requirementVersion: obligationEvidenceRequirementVersion,
        kind: InvestigationEvidenceRequirementKind.CompleteFile,
        path: boundedText(root.path, "path", 2_000),
        pathHash: sha256(root.pathHash),
        revision: revision(root.revision),
      });
      break;
    case InvestigationEvidenceRequirementKind.CompleteChangedFile: {
      const parsedRevision = revision(root.revision);
      if (
        root.requirementVersion !== obligationEvidenceRequirementVersionV2 &&
        parsedRevision !== InvestigationOperationRevision.Head
      ) {
        throw invalidRequirement();
      }
      if (root.requirementVersion === obligationEvidenceRequirementVersionV2) {
        exactKeys(root, [
          "kind",
          "path",
          "pathHash",
          "requirementVersion",
          "revision",
        ]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
          path: boundedText(root.path, "path", 2_000),
          pathHash: sha256(root.pathHash),
          revision: parsedRevision,
        });
      } else {
        exactKeys(root, [
          "kind",
          "path",
          "pathHash",
          "referenceSearch",
          "requirementVersion",
          "revision",
        ]);
        const referenceSearch = exactRecord(root.referenceSearch);
        exactKeys(referenceSearch, ["operationInputHash", "query"]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
          path: boundedText(root.path, "path", 2_000),
          pathHash: sha256(root.pathHash),
          revision: InvestigationOperationRevision.Head,
          referenceSearch: Object.freeze({
            query: boundedText(referenceSearch.query, "query", 4_096),
            operationInputHash: sha256(referenceSearch.operationInputHash),
          }),
        });
      }
      break;
    }
    case InvestigationEvidenceRequirementKind.CompletePageChain:
      if (root.requirementVersion === obligationEvidenceRequirementVersionV2) {
        exactKeys(root, [
          "initialOperationInputHash",
          "kind",
          "matchMode",
          "operationKind",
          "pageSize",
          "paths",
          "probeKind",
          ...(supplied ? ["query"] : []),
          "queryHash",
          "requirementVersion",
          "revision",
          "searchPolicyVersion",
          "sourcePathHash",
        ]);
        if (
          root.operationKind !== InvestigationOperationKind.TextSearch ||
          root.matchMode !== InvestigationTextSearchMatchMode.FixedString ||
          root.pageSize !== 500 ||
          root.revision !== InvestigationOperationRevision.Head
        ) {
          throw invalidRequirement();
        }
        const persisted = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompletePageChain,
          operationKind: InvestigationOperationKind.TextSearch,
          initialOperationInputHash: sha256(root.initialOperationInputHash),
          matchMode: InvestigationTextSearchMatchMode.FixedString,
          queryHash: sha256(root.queryHash),
          probeKind: enumValue(root.probeKind, InvestigationProbeKind),
          paths: rootPathTuple(root.paths),
          pageSize: 500,
          revision: InvestigationOperationRevision.Head,
          sourcePathHash: sha256(root.sourcePathHash),
          searchPolicyVersion: boundedIdentifier(root.searchPolicyVersion),
        });
        requirement = supplied
          ? Object.freeze({
              ...persisted,
              query: boundedCanonicalQuery(root.query),
            })
          : persisted;
      } else {
        exactKeys(root, [
          "initialOperationInputHash",
          "kind",
          "operationKind",
          "query",
          "requirementVersion",
          "sourcePath",
        ]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompletePageChain,
          operationKind: pageOperationKind(root.operationKind),
          initialOperationInputHash: sha256(root.initialOperationInputHash),
          query: boundedText(root.query, "query", 4_096),
          sourcePath: boundedText(root.sourcePath, "source_path", 2_000),
        });
      }
      break;
    case InvestigationEvidenceRequirementKind.CompleteGitFact:
      exactKeys(root, ["fact", "kind", "requirementVersion"]);
      requirement = Object.freeze({
        requirementVersion: obligationEvidenceRequirementVersion,
        kind: InvestigationEvidenceRequirementKind.CompleteGitFact,
        fact: gitFact(root.fact),
      });
      break;
    case InvestigationEvidenceRequirementKind.CompleteRelationContext:
      if (root.requirementVersion === obligationEvidenceRequirementVersionV2) {
        exactKeys(root, [
          "initialOperationInputHash",
          "kind",
          "queryHash",
          ...(supplied ? ["query"] : []),
          "requirementVersion",
          "requiredPathCount",
          "requiredPathHashes",
          "requiredPathSetHash",
          ...(Object.hasOwn(root, "requiredQueryDigest")
            ? ["requiredQueryDigest"]
            : []),
          ...(Object.hasOwn(root, "searchProofVersion")
            ? ["searchProofVersion"]
            : []),
          "revision",
          "searchPolicyVersion",
          "sourceObligationId",
          "sourcePathHash",
        ]);
        const requiredPathHashes = digestSet(root.requiredPathHashes, 512);
        const requiredPathCount = positiveInteger(root.requiredPathCount, 512);
        if (requiredPathHashes.length !== requiredPathCount) {
          throw invalidRequirement();
        }
        if (root.revision !== InvestigationOperationRevision.Head) {
          throw invalidRequirement();
        }
        if (
          Object.hasOwn(root, "searchProofVersion") &&
          root.searchProofVersion !== relationSearchProofVersion
        ) {
          throw invalidRequirement();
        }
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersionV2,
          kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
          sourceObligationId: sha256(root.sourceObligationId),
          initialOperationInputHash: sha256(root.initialOperationInputHash),
          queryHash: sha256(root.queryHash),
          ...(supplied ? { query: boundedCanonicalQuery(root.query) } : {}),
          requiredPathCount,
          requiredPathSetHash: sha256(root.requiredPathSetHash),
          requiredPathHashes,
          ...(Object.hasOwn(root, "requiredQueryDigest")
            ? { requiredQueryDigest: sha256(root.requiredQueryDigest) }
            : {}),
          ...(Object.hasOwn(root, "searchProofVersion")
            ? { searchProofVersion: relationSearchProofVersion }
            : {}),
          sourcePathHash: sha256(root.sourcePathHash),
          revision: InvestigationOperationRevision.Head,
          searchPolicyVersion: boundedIdentifier(root.searchPolicyVersion),
        });
      } else {
        exactKeys(root, [
          "aggregateHash",
          "initialOperationInputHash",
          "kind",
          "query",
          "queryDigest",
          "requirementVersion",
          "requiredPathCount",
          "requiredPathSetHash",
          "revision",
          "sourcePath",
        ]);
        requirement = Object.freeze({
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
          initialOperationInputHash: sha256(root.initialOperationInputHash),
          queryDigest: sha256(root.queryDigest),
          aggregateHash: sha256(root.aggregateHash),
          requiredPathCount: positiveInteger(root.requiredPathCount, 100_000),
          requiredPathSetHash: sha256(root.requiredPathSetHash),
          query: boundedText(root.query, "query", 4_096),
          sourcePath: boundedText(root.sourcePath, "source_path", 2_000),
          revision: revision(root.revision),
        });
      }
      break;
    default:
      throw invalidRequirement();
  }
  if (canonicalJson(requirement) !== value) throw invalidRequirement();
  return requirement;
}

function proveRequirement(input: {
  readonly obligation: InvestigationObligation;
  readonly operations: readonly VerifiedInvestigationOperationEvidence[];
  readonly revision: Readonly<{ reviewRevisionHash: string }>;
  readonly requirement: InvestigationEvidenceRequirement;
}): string {
  switch (input.requirement.kind) {
    case InvestigationEvidenceRequirementKind.BinaryArtifactBoundary:
      throw invalidClosure();
    case InvestigationEvidenceRequirementKind.CompleteInventory: {
      if (
        input.obligation.kind !==
          InvestigationObligationKind.InventoryWitness ||
        input.requirement.reviewRevisionHash !==
          input.revision.reviewRevisionHash
      ) {
        throw invalidClosure();
      }
      const first = provePageChain(
        input.operations,
        InvestigationOperationKind.CanonicalInventory,
        null,
      );
      if (
        input.requirement.requirementVersion ===
        obligationEvidenceRequirementVersionV2
      ) {
        const terminal = [...input.operations]
          .filter(isPageEvidence)
          .sort((left, right) => left.pageOrdinal - right.pageOrdinal)
          .at(-1);
        if (
          !terminal ||
          first.treeOid !== input.requirement.treeOid ||
          terminal.aggregateItemCount !==
            input.requirement.aggregateItemCount ||
          terminal.aggregateHash !== input.requirement.aggregateHash ||
          terminal.aggregatePathCount !==
            input.requirement.aggregatePathCount ||
          terminal.aggregatePathSetHash !==
            input.requirement.aggregatePathSetHash
        ) {
          throw invalidClosure();
        }
        return canonicalInventoryObligationSubjectV2(input.requirement);
      }
      return canonicalInventoryObligationSubject(
        input.revision.reviewRevisionHash,
      );
    }
    case InvestigationEvidenceRequirementKind.CompleteFile: {
      const file = proveFileCoverage(input.operations, input.requirement);
      return canonicalFileObligationSubject({
        pathHash: file.pathHash,
        revision: file.revision,
      });
    }
    case InvestigationEvidenceRequirementKind.CompleteChangedFile: {
      if (
        input.obligation.kind !== InvestigationObligationKind.ChangedContent
      ) {
        throw invalidClosure();
      }
      const file = proveFileCoverage(input.operations, {
        requirementVersion: obligationEvidenceRequirementVersion,
        kind: InvestigationEvidenceRequirementKind.CompleteFile,
        path: input.requirement.path,
        pathHash: input.requirement.pathHash,
        revision: input.requirement.revision,
      });
      return canonicalFileObligationSubject({
        pathHash: file.pathHash,
        revision: file.revision,
      });
    }
    case InvestigationEvidenceRequirementKind.CompletePageChain: {
      const first = provePageChain(
        input.operations,
        input.requirement.operationKind,
        input.requirement.initialOperationInputHash,
      );
      if (
        input.requirement.requirementVersion ===
        obligationEvidenceRequirementVersionV2
      ) {
        return canonicalPageObligationSubjectV2({
          obligationKind: input.obligation.kind,
          initialOperationInputHash: first.operationInputHash,
          probeKind: input.requirement.probeKind,
          queryHash: input.requirement.queryHash,
        });
      }
      return canonicalPageObligationSubject({
        obligationKind: input.obligation.kind,
        operationKind: input.requirement.operationKind,
        initialOperationInputHash: first.operationInputHash,
      });
    }
    case InvestigationEvidenceRequirementKind.CompleteGitFact: {
      const operation = onlyGitFact(input.operations);
      if (
        operation.fact !== input.requirement.fact ||
        operation.complete !== true
      ) {
        throw invalidClosure();
      }
      return canonicalGitFactObligationSubject(operation.fact);
    }
    case InvestigationEvidenceRequirementKind.CompleteRelationContext: {
      if (
        input.requirement.requirementVersion ===
        obligationEvidenceRequirementVersionV2
      ) {
        return proveRelationContextV2(
          input.obligation,
          input.operations,
          input.requirement,
        );
      }
      const search = input.operations.filter(isPageEvidence);
      const files = input.operations.filter(isFileEvidence);
      if (search.length + files.length !== input.operations.length) {
        throw invalidClosure();
      }
      const first = provePageChain(
        search,
        InvestigationOperationKind.TextSearch,
        input.requirement.initialOperationInputHash,
      );
      const terminal = search.find((item) => item.complete);
      if (
        !terminal ||
        first.queryDigest !== input.requirement.queryDigest ||
        terminal.aggregateHash !== input.requirement.aggregateHash ||
        terminal.aggregatePathCount !== input.requirement.requiredPathCount ||
        terminal.aggregatePathSetHash !== input.requirement.requiredPathSetHash
      ) {
        throw invalidClosure();
      }
      const requiredPathHashes = new Set(
        search.flatMap((page) => page.pagePathHashes),
      );
      if (requiredPathHashes.size !== input.requirement.requiredPathCount) {
        throw invalidClosure();
      }
      const completeRelatedFiles = new Set<string>();
      for (const group of groupFileEvidence(files).values()) {
        const file = proveFileCoverage(group, {
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompleteFile,
          path: "authenticated_relation_target",
          pathHash: group[0]!.pathHash,
          revision: input.requirement.revision,
        });
        if (!requiredPathHashes.has(file.pathHash)) throw invalidClosure();
        completeRelatedFiles.add(file.pathHash);
      }
      if (
        completeRelatedFiles.size !== requiredPathHashes.size ||
        [...requiredPathHashes].some(
          (pathHash) => !completeRelatedFiles.has(pathHash),
        )
      ) {
        throw invalidClosure();
      }
      return canonicalRelationObligationSubject({
        obligationKind: input.obligation.kind,
        queryDigest: first.queryDigest,
        aggregateHash: terminal.aggregateHash,
      });
    }
  }
}

function proveRelationContextV2(
  obligation: InvestigationObligation,
  operations: readonly VerifiedInvestigationOperationEvidence[],
  requirement: CompleteRelationContextRequirementV2,
): string {
  const searches = operations.filter(isPageEvidence);
  const files = operations.filter(isFileEvidence);
  if (
    files.length === 0 ||
    searches.length + files.length !== operations.length ||
    ((requirement.searchProofVersion === relationSearchProofVersion ||
      requirement.requiredQueryDigest !== undefined) &&
      searches.length === 0)
  ) {
    throw invalidClosure();
  }
  let searchTreeOid: string | null = null;
  if (searches.length > 0) {
    const firstSearch = provePageChain(
      searches,
      InvestigationOperationKind.TextSearch,
      requirement.initialOperationInputHash,
    );
    searchTreeOid = firstSearch.treeOid;
    const terminal = [...searches]
      .sort((left, right) => left.pageOrdinal - right.pageOrdinal)
      .at(-1)!;
    const observedPathHashes = new Set(
      searches.flatMap((page) => page.pagePathHashes),
    );
    if (
      terminal.aggregatePathCount !== requirement.requiredPathCount ||
      terminal.aggregatePathSetHash !== requirement.requiredPathSetHash ||
      observedPathHashes.size !== requirement.requiredPathHashes.length ||
      requirement.requiredPathHashes.some(
        (pathHash) => !observedPathHashes.has(pathHash),
      )
    ) {
      throw invalidClosure();
    }
  }
  const requiredPathHashes = new Set(requirement.requiredPathHashes);
  const completeRelatedFiles = new Set<string>();
  let treeOid: string | null = null;
  for (const group of groupFileEvidence(files).values()) {
    const file = proveFileCoverage(group, {
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteFile,
      path: "authenticated_relation_target",
      pathHash: group[0]!.pathHash,
      revision: requirement.revision,
    });
    if (
      !requiredPathHashes.has(file.pathHash) ||
      completeRelatedFiles.has(file.pathHash) ||
      (treeOid !== null && treeOid !== file.treeOid)
    ) {
      throw invalidClosure();
    }
    treeOid = file.treeOid;
    completeRelatedFiles.add(file.pathHash);
  }
  if (
    completeRelatedFiles.size !== requiredPathHashes.size ||
    [...requiredPathHashes].some(
      (pathHash) => !completeRelatedFiles.has(pathHash),
    ) ||
    (searchTreeOid !== null && treeOid !== searchTreeOid)
  ) {
    throw invalidClosure();
  }
  return canonicalRelationObligationSubjectV2({
    obligationKind: obligation.kind,
    sourceObligationId: requirement.sourceObligationId,
    initialOperationInputHash: requirement.initialOperationInputHash,
    queryHash: requirement.queryHash,
    requiredPathSetHash: requirement.requiredPathSetHash,
  });
}

function proveFileCoverage(
  operations: readonly VerifiedInvestigationOperationEvidence[],
  requirement: CompleteFileRequirement,
): InvestigationFileReadEvidence {
  if (operations.length === 0 || !operations.every(isFileEvidence)) {
    throw invalidClosure();
  }
  const files = [...operations].sort(
    (left, right) =>
      left.startByte - right.startByte || left.sequence - right.sequence,
  );
  const first = files[0]!;
  if (
    first.pathHash !== requirement.pathHash ||
    first.revision !== requirement.revision ||
    files.some(
      (item) =>
        item.pathHash !== first.pathHash ||
        item.revision !== first.revision ||
        item.treeOid !== first.treeOid ||
        item.blobOid !== first.blobOid ||
        item.mode !== first.mode,
    ) ||
    first.startByte !== 0
  ) {
    throw invalidClosure();
  }
  let coveredUntil = 0;
  let eofAt: number | null = null;
  for (const file of files) {
    if (
      file.startByte > coveredUntil ||
      (eofAt !== null && file.startByte >= eofAt)
    ) {
      throw invalidClosure();
    }
    coveredUntil = Math.max(coveredUntil, file.startByte + file.byteCount);
    if (file.eof) {
      if (!file.complete) throw invalidClosure();
      const currentEof = file.startByte + file.byteCount;
      if (eofAt !== null && eofAt !== currentEof) throw invalidClosure();
      eofAt = currentEof;
    } else if (file.complete) {
      throw invalidClosure();
    }
  }
  if (eofAt === null || coveredUntil !== eofAt) throw invalidClosure();
  return first;
}

function provePageChain(
  operations: readonly VerifiedInvestigationOperationEvidence[],
  operationKind: InvestigationPageEvidence["operationKind"],
  initialOperationInputHash: string | null,
): InvestigationPageEvidence {
  if (operations.length === 0 || !operations.every(isPageEvidence)) {
    throw invalidClosure();
  }
  const pages = [...operations].sort(
    (left, right) => left.pageOrdinal - right.pageOrdinal,
  );
  const first = pages[0]!;
  if (
    first.operationKind !== operationKind ||
    first.pageOrdinal !== 0 ||
    (initialOperationInputHash !== null &&
      first.operationInputHash !== initialOperationInputHash) ||
    pages.some(
      (page) =>
        page.operationKind !== first.operationKind ||
        page.treeOid !== first.treeOid ||
        page.queryDigest !== first.queryDigest,
    )
  ) {
    throw invalidClosure();
  }
  let aggregateItemCount = 0;
  const aggregatePathHashes = new Set<string>();
  let expectedCursorInputHash: string | null = null;
  for (const [index, page] of pages.entries()) {
    aggregateItemCount += page.pageItemCount;
    if (
      page.pageOrdinal !== index ||
      page.cursorInputHash !== expectedCursorInputHash ||
      page.aggregateItemCount !== aggregateItemCount ||
      (index === pages.length - 1
        ? !page.complete || page.nextCursorHash !== null
        : page.complete || page.nextCursorHash === null)
    ) {
      throw invalidClosure();
    }
    for (const pathHash of page.pagePathHashes) {
      if (aggregatePathHashes.has(pathHash)) throw invalidClosure();
      aggregatePathHashes.add(pathHash);
    }
    if (page.aggregatePathCount !== aggregatePathHashes.size) {
      throw invalidClosure();
    }
    expectedCursorInputHash = page.nextCursorHash;
  }
  return first;
}

function groupFileEvidence(
  files: readonly InvestigationFileReadEvidence[],
): ReadonlyMap<string, readonly InvestigationFileReadEvidence[]> {
  const groups = new Map<string, InvestigationFileReadEvidence[]>();
  for (const file of files) {
    const key = [file.revision, file.treeOid, file.pathHash, file.blobOid].join(
      ":",
    );
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  return groups;
}

function onlyGitFact(
  operations: readonly VerifiedInvestigationOperationEvidence[],
): InvestigationGitFactEvidence {
  if (operations.length !== 1 || !isGitFactEvidence(operations[0]!)) {
    throw invalidClosure();
  }
  return operations[0];
}

function receiptKind(
  requirement: InvestigationEvidenceRequirement,
): ObligationClosureProof["receiptKind"] {
  switch (requirement.kind) {
    case InvestigationEvidenceRequirementKind.BinaryArtifactBoundary:
      throw invalidClosure();
    case InvestigationEvidenceRequirementKind.CompleteInventory:
    case InvestigationEvidenceRequirementKind.CompletePageChain:
      return requirement.kind ===
        InvestigationEvidenceRequirementKind.CompletePageChain &&
        requirement.operationKind === InvestigationOperationKind.TextSearch
        ? "search"
        : "tree";
    case InvestigationEvidenceRequirementKind.CompleteFile:
    case InvestigationEvidenceRequirementKind.CompleteChangedFile:
      return "blob";
    case InvestigationEvidenceRequirementKind.CompleteGitFact:
      return "git_fact";
    case InvestigationEvidenceRequirementKind.CompleteRelationContext:
      return "relation";
  }
}

function isFileEvidence(
  value: VerifiedInvestigationOperationEvidence,
): value is InvestigationFileReadEvidence {
  return value.operationKind === InvestigationOperationKind.FileRead;
}

function isPageEvidence(
  value: VerifiedInvestigationOperationEvidence,
): value is InvestigationPageEvidence {
  switch (value.operationKind) {
    case InvestigationOperationKind.DirectoryList:
    case InvestigationOperationKind.TextSearch:
    case InvestigationOperationKind.CanonicalInventory:
      return true;
    case InvestigationOperationKind.FileRead:
    case InvestigationOperationKind.GitFact:
      return false;
  }
}

function isGitFactEvidence(
  value: VerifiedInvestigationOperationEvidence,
): value is InvestigationGitFactEvidence {
  return value.operationKind === InvestigationOperationKind.GitFact;
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequirement();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    keys.length !== sorted.length ||
    keys.some((key, index) => key !== sorted[index])
  ) {
    throw invalidRequirement();
  }
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidRequirement();
  }
  return value;
}

function fileMode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !["100644", "100755", "120000", "160000"].includes(value)
  ) {
    throw invalidRequirement();
  }
  return value;
}

function gitObjectOid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) ||
    /^0+$/u.test(value)
  ) {
    throw invalidRequirement();
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidRequirement();
  }
  return Number(value);
}

function binaryArtifactStatus(
  value: unknown,
): BinaryArtifactBoundaryRequirement["status"] {
  switch (value) {
    case "added":
    case "deleted":
    case "modified":
    case "type_changed":
    case "exact_rename":
      return value;
    default:
      throw invalidRequirement();
  }
}

function boundedText(value: unknown, _field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw invalidRequirement();
  }
  return value;
}

function boundedCanonicalQuery(value: unknown): string {
  const query = boundedText(
    value,
    "query",
    investigationDiscoveryQueryMaximumLength,
  );
  if (
    query.trim() !== query ||
    /[\r\n]/u.test(query) ||
    [...query].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw invalidRequirement();
  }
  return query;
}

function boundedIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw invalidRequirement();
  }
  return value;
}

function rootPathTuple(value: unknown): readonly ["."] {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== ".") {
    throw invalidRequirement();
  }
  return Object.freeze(["."] as const);
}

function digestSet(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw invalidRequirement();
  }
  const digests = value.map(sha256);
  if (
    new Set(digests).size !== digests.length ||
    digests.some((digest, index) => index > 0 && digests[index - 1]! >= digest)
  ) {
    throw invalidRequirement();
  }
  return Object.freeze(digests);
}

function enumValue<T extends Record<string, string>>(
  value: unknown,
  values: T,
): T[keyof T] {
  if (typeof value !== "string" || !Object.values(values).includes(value)) {
    throw invalidRequirement();
  }
  return value as T[keyof T];
}

function positiveInteger(value: unknown, maximum = 256): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) <= 0 ||
    Number(value) > maximum
  ) {
    throw invalidRequirement();
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw invalidRequirement();
  }
  return value;
}

function revision(value: unknown): InvestigationOperationRevision {
  switch (value) {
    case InvestigationOperationRevision.Head:
      return InvestigationOperationRevision.Head;
    case InvestigationOperationRevision.MergeBase:
      return InvestigationOperationRevision.MergeBase;
    default:
      throw invalidRequirement();
  }
}

function pageOperationKind(
  value: unknown,
): CompletePageChainRequirement["operationKind"] {
  if (
    value !== InvestigationOperationKind.DirectoryList &&
    value !== InvestigationOperationKind.TextSearch
  ) {
    throw invalidRequirement();
  }
  return value;
}

function gitFact(value: unknown): CompleteGitFactRequirement["fact"] {
  if (!["merge_base", "changed_paths", "diff_stat"].includes(String(value))) {
    throw invalidRequirement();
  }
  return value as CompleteGitFactRequirement["fact"];
}

function invalidRequirement(): ReviewInvestigationDomainError {
  return new ReviewInvestigationDomainError(
    "investigation_evidence_requirement_invalid",
  );
}

function invalidClosure(): ReviewInvestigationDomainError {
  return new ReviewInvestigationDomainError(
    "investigation_obligation_evidence_mismatch",
  );
}
