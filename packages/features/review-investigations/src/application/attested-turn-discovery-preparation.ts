import { canonicalJson } from "../domain/canonicalization";
import type { PreparedOperationBackedDiscoveryClaim } from "../domain/coverage-policies";
import { InvestigationObligationOrigin } from "../domain/investigation-obligation";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
} from "../domain/review-investigation-types";
import {
  InvestigationEvidenceRequirementKind,
  canonicalFileObligationSubject,
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

export type AttestedTurnDiscoveryPreparationResult = Readonly<{
  requiredClaims: readonly PreparedOperationBackedDiscoveryClaim[];
  advisoryClaims: readonly PreparedOperationBackedDiscoveryClaim[];
}>;

export class AttestedTurnDiscoveryPreparation {
  constructor(private readonly digest: InvestigationDigestPort) {}

  async prepare(input: {
    readonly investigation: ReviewInvestigation;
    readonly closureClaims: InvestigationTurnObservation["closureClaims"];
    readonly providerClaims: InvestigationTurnObservation["operationBackedDiscoveryClaims"];
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): Promise<AttestedTurnDiscoveryPreparationResult> {
    const requiredDiscoveryClaims = await this.prepareClosedSearchClaims({
      closureClaims: input.closureClaims,
      investigation: input.investigation,
      operationEvidence: input.operationEvidence,
    });
    const requiredClaims = dedupePreparedDiscoveryClaims(
      requiredDiscoveryClaims,
    );
    const requiredKeys = new Set(requiredClaims.map(preparedDiscoveryClaimKey));
    const advisoryClaims = dedupePreparedDiscoveryClaims(
      await this.prepareProviderClaims({
        claims: input.providerClaims,
        investigation: input.investigation,
        operationEvidence: input.operationEvidence,
      }),
    ).filter((claim) => !requiredKeys.has(preparedDiscoveryClaimKey(claim)));
    return Object.freeze({
      requiredClaims,
      advisoryClaims: Object.freeze(advisoryClaims),
    });
  }

  private async prepareProviderClaims(input: {
    readonly claims: InvestigationTurnObservation["operationBackedDiscoveryClaims"];
    readonly investigation: ReviewInvestigation;
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): Promise<readonly PreparedOperationBackedDiscoveryClaim[]> {
    const distinctClaims = dedupeProviderClaims(
      input.claims.filter((claim) =>
        isProviderDiscoverySource(
          input.investigation,
          claim.sourceObligationId,
        ),
      ),
    );
    const receiptUseCounts = new Map<string, number>();
    for (const claim of distinctClaims) {
      for (const receiptId of claim.operationReceiptIds) {
        receiptUseCounts.set(
          receiptId,
          (receiptUseCounts.get(receiptId) ?? 0) + 1,
        );
      }
    }
    const prepared = await Promise.all(
      distinctClaims.map(async (claim) => {
        if (
          new Set(claim.operationReceiptIds).size !==
            claim.operationReceiptIds.length ||
          claim.operationReceiptIds.some(
            (receiptId) => receiptUseCounts.get(receiptId) !== 1,
          )
        ) {
          return null;
        }
        const operations = tryTextSearchOperations(
          claim.operationReceiptIds,
          input.operationEvidence,
        );
        if (operations === null) return null;
        const queryHash = await this.digest.digestUtf8(claim.query);
        const expectedInitialOperationInputHash = await this.digest.digestUtf8(
          canonicalStandardTextSearchOperationInput(queryHash),
        );
        return this.preparedClaim({
          sourceObligationId: claim.sourceObligationId,
          queryHash,
          expectedInitialOperationInputHash,
          operations,
        });
      }),
    );
    return Object.freeze(
      prepared.filter(
        (claim): claim is PreparedOperationBackedDiscoveryClaim =>
          claim !== null,
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

function isProviderDiscoverySource(
  investigation: ReviewInvestigation,
  obligationId: string,
): boolean {
  if (
    investigation.activeTurn !== null &&
    !investigation.activeTurn.obligationIds.includes(obligationId)
  ) {
    return false;
  }
  const obligation = investigation.obligations.find(
    (candidate) => candidate.obligationId === obligationId,
  );
  if (
    !obligation ||
    obligation.kind !== InvestigationObligationKind.ChangedContent ||
    obligation.origin !== InvestigationObligationOrigin.CoverageContract ||
    obligation.state !== InvestigationObligationState.Open
  ) {
    return false;
  }
  const requirement = parseInvestigationEvidenceRequirement(
    obligation.canonicalRequirement,
  );
  return (
    requirement.kind ===
      InvestigationEvidenceRequirementKind.CompleteChangedFile &&
    requirement.requirementVersion === obligationEvidenceRequirementVersionV2 &&
    obligation.canonicalSubject === canonicalFileObligationSubject(requirement)
  );
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

function tryTextSearchOperations(
  operationReceiptIds: readonly string[],
  operationEvidence: VerifiedOperationEvidenceIndex,
): readonly VerifiedInvestigationOperationEvidence[] | null {
  const operations = operationReceiptIds.map((receiptId) =>
    operationEvidence.get(receiptId),
  );
  if (
    operations.some(
      (operation) =>
        operation?.operationKind !== InvestigationOperationKind.TextSearch,
    )
  ) {
    return null;
  }
  return Object.freeze(
    operations as readonly VerifiedInvestigationOperationEvidence[],
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
    const key = preparedDiscoveryClaimKey(claim);
    if (!result.has(key)) result.set(key, claim);
  }
  return Object.freeze([...result.values()]);
}

function preparedDiscoveryClaimKey(
  claim: PreparedOperationBackedDiscoveryClaim,
): string {
  return canonicalJson({
    sourceObligationId: claim.sourceObligationId,
    queryHash: claim.queryHash,
    expectedInitialOperationInputHash: claim.expectedInitialOperationInputHash,
    authenticatedPathSetHash: claim.authenticatedPathSetHash,
    operationReceiptIds: claim.operations
      .map((operation) => operation.operationReceiptId)
      .sort(),
  });
}

function dedupeProviderClaims(
  claims: InvestigationTurnObservation["operationBackedDiscoveryClaims"],
): InvestigationTurnObservation["operationBackedDiscoveryClaims"] {
  const result = new Map<string, (typeof claims)[number]>();
  for (const claim of claims) {
    const key = canonicalJson({
      sourceObligationId: claim.sourceObligationId,
      query: claim.query,
      operationReceiptIds: [...claim.operationReceiptIds].sort(),
    });
    if (!result.has(key)) result.set(key, claim);
  }
  return Object.freeze([...result.values()]);
}
