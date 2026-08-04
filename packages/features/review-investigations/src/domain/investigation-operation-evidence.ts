export enum InvestigationOperationKind {
  FileRead = "file_read",
  DirectoryList = "directory_list",
  TextSearch = "text_search",
  CanonicalInventory = "canonical_inventory",
  GitFact = "git_fact",
}

export enum InvestigationOperationRevision {
  Head = "head",
  MergeBase = "merge_base",
}

export enum InvestigationFileContentKind {
  Text = "text",
  Binary = "binary",
}

type InvestigationOperationEvidenceBase = Readonly<{
  operationReceiptId: string;
  operationKey: string;
  sequence: number;
  evidenceDigest: string;
}>;

export type InvestigationFileReadEvidence = InvestigationOperationEvidenceBase &
  Readonly<{
    operationKind: InvestigationOperationKind.FileRead;
    operationInputHash: string;
    revision: InvestigationOperationRevision;
    treeOid: string;
    pathHash: string;
    blobOid: string;
    mode: string;
    startByte: number;
    byteCount: number;
    contentHash: string;
    contentKind: InvestigationFileContentKind | null;
    lineCount: number | null;
    eof: boolean;
    complete: boolean;
  }>;

export type InvestigationPageEvidence = InvestigationOperationEvidenceBase &
  Readonly<{
    operationKind:
      | InvestigationOperationKind.DirectoryList
      | InvestigationOperationKind.TextSearch
      | InvestigationOperationKind.CanonicalInventory;
    operationInputHash: string;
    treeOid: string;
    queryDigest: string;
    cursorInputHash: string | null;
    pageOrdinal: number;
    pageItemCount: number;
    pageItemsHash: string;
    pagePathHashes: readonly string[];
    aggregatePathCount: number;
    aggregatePathSetHash: string;
    aggregateItemCount: number;
    aggregateHash: string;
    complete: boolean;
    nextCursorHash: string | null;
  }>;

export type InvestigationGitFactEvidence = InvestigationOperationEvidenceBase &
  Readonly<{
    operationKind: InvestigationOperationKind.GitFact;
    fact: "merge_base" | "changed_paths" | "diff_stat";
    resultHash: string;
    itemCount: number;
    complete: true;
  }>;

export type VerifiedInvestigationOperationEvidence =
  | InvestigationFileReadEvidence
  | InvestigationPageEvidence
  | InvestigationGitFactEvidence;
