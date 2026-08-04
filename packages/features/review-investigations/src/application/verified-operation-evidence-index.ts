import {
  InvestigationOperationKind,
  type VerifiedInvestigationOperationEvidence,
} from "../domain/investigation-operation-evidence";
import { canonicalJson } from "../domain/canonicalization";

export type VerifiedOperationEvidenceIndex = Readonly<{
  operationReceiptIds: readonly string[];
  get(
    operationReceiptId: string,
  ): VerifiedInvestigationOperationEvidence | undefined;
  has(operationReceiptId: string): boolean;
}>;

export function createVerifiedOperationEvidenceIndex(
  operations: readonly VerifiedInvestigationOperationEvidence[],
): VerifiedOperationEvidenceIndex {
  const byReceipt = new Map<string, VerifiedInvestigationOperationEvidence>();
  for (const operation of operations) {
    const existing = byReceipt.get(operation.operationReceiptId);
    if (existing) {
      if (
        canonicalReceiptEvidence(existing) !==
          canonicalReceiptEvidence(operation) ||
        (existing.sequence === operation.sequence &&
          existing.evidenceDigest !== operation.evidenceDigest)
      ) {
        throw new Error("investigation_operation_receipt_collision");
      }
      if (operation.sequence < existing.sequence) {
        byReceipt.set(operation.operationReceiptId, freezeOperation(operation));
      }
      continue;
    }
    byReceipt.set(operation.operationReceiptId, freezeOperation(operation));
  }
  return Object.freeze({
    operationReceiptIds: Object.freeze([...byReceipt.keys()]),
    get: (operationReceiptId: string) => byReceipt.get(operationReceiptId),
    has: (operationReceiptId: string) => byReceipt.has(operationReceiptId),
  });
}

function canonicalReceiptEvidence(
  operation: VerifiedInvestigationOperationEvidence,
): string {
  const {
    sequence: _sequence,
    evidenceDigest: _evidenceDigest,
    ...receipt
  } = operation;
  void _sequence;
  void _evidenceDigest;
  return canonicalJson(receipt);
}

function freezeOperation(
  operation: VerifiedInvestigationOperationEvidence,
): VerifiedInvestigationOperationEvidence {
  switch (operation.operationKind) {
    case InvestigationOperationKind.DirectoryList:
    case InvestigationOperationKind.TextSearch:
    case InvestigationOperationKind.CanonicalInventory:
      return Object.freeze({
        ...operation,
        pagePathHashes: Object.freeze([...operation.pagePathHashes]),
      });
    case InvestigationOperationKind.FileRead:
    case InvestigationOperationKind.GitFact:
      return Object.freeze({ ...operation });
  }
}
