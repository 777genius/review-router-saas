import { canonicalJson } from "../domain/canonicalization";
import type { PreparedOperationBackedDiscoveryClaim } from "../domain/coverage-policies";
import {
  InvestigationEvidenceRequirementKind,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
} from "../domain/obligation-closure-policy";
import {
  InvestigationOperationKind,
  type InvestigationPageEvidence,
  type VerifiedInvestigationOperationEvidence,
} from "../domain/investigation-operation-evidence";
import type { ReviewInvestigation } from "../domain/review-investigation";
import type { InvestigationTurnObservation } from "../domain/investigation-turn-observation";
import type { InvestigationDigestPort } from "./ports/digest-port";
import type { VerifiedOperationEvidenceIndex } from "./verified-operation-evidence-index";

export class AttestedTurnDiscoveryPreparation {
  constructor(private readonly digest: InvestigationDigestPort) {}

  async prepare(input: {
    readonly investigation: ReviewInvestigation;
    readonly closureClaims: InvestigationTurnObservation["closureClaims"];
    readonly providerClaims: InvestigationTurnObservation["operationBackedDiscoveryClaims"];
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): Promise<readonly PreparedOperationBackedDiscoveryClaim[]> {
    const providerDiscoveryClaims = await this.prepareProviderClaims({
      claims: input.providerClaims,
      operationEvidence: input.operationEvidence,
    });
    const requiredDiscoveryClaims = await this.prepareClosedSearchClaims({
      closureClaims: input.closureClaims,
      investigation: input.investigation,
      operationEvidence: input.operationEvidence,
    });
    return dedupePreparedDiscoveryClaims([
      ...requiredDiscoveryClaims,
      ...providerDiscoveryClaims,
    ]);
  }

  private async prepareProviderClaims(input: {
    readonly claims: InvestigationTurnObservation["operationBackedDiscoveryClaims"];
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): Promise<readonly PreparedOperationBackedDiscoveryClaim[]> {
    const claimedReceiptIds = new Set<string>();
    for (const claim of input.claims) {
      for (const receiptId of claim.operationReceiptIds) {
        if (claimedReceiptIds.has(receiptId)) {
          throw new Error(
            "investigation_operation_backed_discovery_receipt_reused",
          );
        }
        claimedReceiptIds.add(receiptId);
      }
    }
    return Object.freeze(
      await Promise.all(
        input.claims.map(async (claim) => {
          const operations = textSearchOperations(
            claim.operationReceiptIds,
            input.operationEvidence,
          );
          const queryHash = await this.digest.digestUtf8(claim.query);
          const expectedInitialOperationInputHash =
            await this.digest.digestUtf8(
              canonicalStandardTextSearchOperationInput(queryHash),
            );
          return this.preparedClaim({
            sourceObligationId: claim.sourceObligationId,
            queryHash,
            expectedInitialOperationInputHash,
            operations,
          });
        }),
      ),
    );
  }

  private async prepareClosedSearchClaims(input: {
    readonly closureClaims: InvestigationTurnObservation["closureClaims"];
    readonly investigation: ReviewInvestigation;
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): Promise<readonly PreparedOperationBackedDiscoveryClaim[]> {
    const prepared: PreparedOperationBackedDiscoveryClaim[] = [];
    for (const claim of input.closureClaims) {
      const obligation = input.investigation.obligations.find(
        (item) => item.obligationId === claim.obligationId,
      );
      if (!obligation) throw new Error("investigation_obligation_missing");
      const requirement = parseInvestigationEvidenceRequirement(
        obligation.canonicalRequirement,
      );
      if (
        requirement.kind !==
          InvestigationEvidenceRequirementKind.CompletePageChain ||
        requirement.requirementVersion !==
          obligationEvidenceRequirementVersionV2
      ) {
        continue;
      }
      prepared.push(
        await this.preparedClaim({
          sourceObligationId: obligation.obligationId,
          queryHash: requirement.queryHash,
          expectedInitialOperationInputHash:
            requirement.initialOperationInputHash,
          operations: textSearchOperations(
            claim.operationReceiptIds,
            input.operationEvidence,
          ),
        }),
      );
    }
    return Object.freeze(prepared);
  }

  private async preparedClaim(input: {
    readonly sourceObligationId: string;
    readonly queryHash: string;
    readonly expectedInitialOperationInputHash: string;
    readonly operations: readonly VerifiedInvestigationOperationEvidence[];
  }): Promise<PreparedOperationBackedDiscoveryClaim> {
    const pathHashes = uniqueAuthenticatedPathHashes(input.operations);
    return Object.freeze({
      sourceObligationId: input.sourceObligationId,
      queryHash: input.queryHash,
      expectedInitialOperationInputHash:
        input.expectedInitialOperationInputHash,
      authenticatedPathSetHash: await this.digest.digestUtf8(
        canonicalJson(pathHashes),
      ),
      operations: Object.freeze([...input.operations]),
    });
  }
}

function textSearchOperations(
  operationReceiptIds: readonly string[],
  operationEvidence: VerifiedOperationEvidenceIndex,
): readonly VerifiedInvestigationOperationEvidence[] {
  return Object.freeze(
    operationReceiptIds.map((receiptId) => {
      const operation = operationEvidence.get(receiptId);
      if (!operation) {
        throw new Error("investigation_operation_receipt_missing");
      }
      if (operation.operationKind !== InvestigationOperationKind.TextSearch) {
        throw new Error(
          "investigation_operation_backed_discovery_evidence_invalid",
        );
      }
      return operation;
    }),
  );
}

function uniqueAuthenticatedPathHashes(
  operations: readonly VerifiedInvestigationOperationEvidence[],
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        (operations as readonly InvestigationPageEvidence[]).flatMap(
          (operation) => [...operation.pagePathHashes],
        ),
      ),
    ].sort(),
  );
}

function dedupePreparedDiscoveryClaims(
  claims: readonly PreparedOperationBackedDiscoveryClaim[],
): readonly PreparedOperationBackedDiscoveryClaim[] {
  const result = new Map<string, PreparedOperationBackedDiscoveryClaim>();
  for (const claim of claims) {
    const key = canonicalJson({
      sourceObligationId: claim.sourceObligationId,
      queryHash: claim.queryHash,
      expectedInitialOperationInputHash:
        claim.expectedInitialOperationInputHash,
      authenticatedPathSetHash: claim.authenticatedPathSetHash,
      operationReceiptIds: claim.operations
        .map((operation) => operation.operationReceiptId)
        .sort(),
    });
    if (!result.has(key)) result.set(key, claim);
  }
  return Object.freeze([...result.values()]);
}
