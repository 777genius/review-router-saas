import { canonicalJson } from "../domain/canonicalization";
import {
  InvestigationReceiptKind,
  type InvestigationEvidenceReceipt,
} from "../domain/investigation-obligation";
import {
  InvestigationEvidenceRequirementKind,
  ObligationClosureDecisionKind,
  VersionedObligationClosurePolicy,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  type ObligationClosurePolicy,
} from "../domain/obligation-closure-policy";
import {
  InvestigationOperationKind,
  type InvestigationPageEvidence,
  type VerifiedInvestigationOperationEvidence,
} from "../domain/investigation-operation-evidence";
import type { ReviewInvestigation } from "../domain/review-investigation";
import type { InvestigationTurnObservation } from "../domain/investigation-turn-observation";
import type { InvestigationDigestPort } from "./ports/digest-port";
import { digestCanonical } from "./use-cases/investigation-use-case-support";
import type { VerifiedOperationEvidenceIndex } from "./verified-operation-evidence-index";

export type PreparedAttestedTurnClosures = Readonly<{
  closureClaims: readonly Readonly<{
    obligationId: string;
    receipt: InvestigationEvidenceReceipt;
  }>[];
  acceptedProviderClaims: InvestigationTurnObservation["closureClaims"];
}>;

export class AttestedTurnClosurePreparation {
  constructor(
    private readonly digest: InvestigationDigestPort,
    private readonly closurePolicy: ObligationClosurePolicy = new VersionedObligationClosurePolicy(),
  ) {}

  async prepare(input: {
    readonly investigation: ReviewInvestigation;
    readonly closureClaims: InvestigationTurnObservation["closureClaims"];
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
    readonly acceptedAttestationId: string;
    readonly acceptedAttestationHash: string;
  }): Promise<PreparedAttestedTurnClosures> {
    const adjudicated = await Promise.all(
      input.closureClaims.map(async (claim) => ({
        claim,
        receipt: await this.buildReceipt({
          claim,
          investigation: input.investigation,
          operationEvidence: input.operationEvidence,
          acceptedAttestationId: input.acceptedAttestationId,
          acceptedAttestationHash: input.acceptedAttestationHash,
        }),
      })),
    );
    const accepted = adjudicated.filter(
      (
        item,
      ): item is (typeof adjudicated)[number] & {
        receipt: InvestigationEvidenceReceipt;
      } => item.receipt !== null,
    );
    const closureClaims = Object.freeze(
      accepted.map(({ claim, receipt }) =>
        Object.freeze({ obligationId: claim.obligationId, receipt }),
      ),
    );
    const acceptedProviderClaims = Object.freeze(
      accepted.map(({ claim }) => claim),
    );
    await assertInventoryClosureCompleteness({
      closureClaims: acceptedProviderClaims,
      investigation: input.investigation,
      operationEvidence: input.operationEvidence,
      digest: this.digest,
    });
    return Object.freeze({ closureClaims, acceptedProviderClaims });
  }

  private async buildReceipt(input: {
    readonly claim: InvestigationTurnObservation["closureClaims"][number];
    readonly investigation: ReviewInvestigation;
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
    readonly acceptedAttestationId: string;
    readonly acceptedAttestationHash: string;
  }): Promise<InvestigationEvidenceReceipt | null> {
    const obligation = input.investigation.obligations.find(
      (item) => item.obligationId === input.claim.obligationId,
    );
    if (!obligation) throw new Error("investigation_obligation_missing");
    const operations = input.claim.operationReceiptIds.map((receiptId) => {
      const evidence = input.operationEvidence.get(receiptId);
      if (!evidence) {
        throw new Error("investigation_operation_receipt_missing");
      }
      return evidence;
    });
    await assertPageRequirementDigestBinding(
      obligation.canonicalRequirement,
      this.digest,
    );
    const decision = this.closurePolicy.decide({
      obligation,
      operations,
      revision: input.investigation.revision,
    });
    if (decision.kind === ObligationClosureDecisionKind.EvidenceMismatch) {
      return null;
    }
    const proof = decision.proof;
    return Object.freeze({
      receiptId: await digestCanonical(this.digest, {
        closurePolicyVersion: proof.closurePolicyVersion,
        operationReceiptIds: [...proof.operationReceiptIds],
        obligationId: obligation.obligationId,
      }),
      operationKey: await digestCanonical(this.digest, [
        ...proof.operationKeys,
      ]),
      kind: receiptKind(proof.receiptKind),
      canonicalSubject: proof.canonicalSubject,
      reviewRevisionHash: input.investigation.revision.reviewRevisionHash,
      gatewayPolicyVersion: input.investigation.contract.gatewayPolicyVersion,
      evidenceDigest: await digestCanonical(this.digest, [
        ...proof.evidenceDigests,
      ]),
      operationReceiptIds: Object.freeze([...proof.operationReceiptIds]),
      acceptedAttestationId: input.acceptedAttestationId,
      acceptedAttestationHash: input.acceptedAttestationHash,
      replayProofId: null,
      complete: true,
      truncated: false,
      failed: false,
    });
  }
}

async function assertInventoryClosureCompleteness(input: {
  readonly closureClaims: InvestigationTurnObservation["closureClaims"];
  readonly investigation: ReviewInvestigation;
  readonly operationEvidence: VerifiedOperationEvidenceIndex;
  readonly digest: InvestigationDigestPort;
}): Promise<void> {
  const inventoryClaims = input.closureClaims.filter((claim) => {
    const obligation = input.investigation.obligations.find(
      (item) => item.obligationId === claim.obligationId,
    );
    if (!obligation) throw new Error("investigation_obligation_missing");
    const requirement = parseInvestigationEvidenceRequirement(
      obligation.canonicalRequirement,
    );
    return (
      requirement.kind ===
      InvestigationEvidenceRequirementKind.CompleteInventory
    );
  });
  if (inventoryClaims.length === 0) return;
  if (inventoryClaims.length !== 1) {
    throw new Error("investigation_inventory_closure_invalid");
  }
  const authenticatedPathHashes = uniqueAuthenticatedPathHashes(
    inventoryClaims[0]!.operationReceiptIds.map((receiptId) => {
      const operation = input.operationEvidence.get(receiptId);
      if (
        !operation ||
        operation.operationKind !==
          InvestigationOperationKind.CanonicalInventory
      ) {
        throw new Error("investigation_inventory_closure_invalid");
      }
      return operation;
    }),
  );
  const expectedPathHashes = [
    ...new Set(
      input.investigation.obligations
        .filter(
          (obligation) =>
            parseInvestigationEvidenceRequirement(
              obligation.canonicalRequirement,
            ).kind === InvestigationEvidenceRequirementKind.CompleteChangedFile,
        )
        .map((obligation) => {
          const requirement = parseInvestigationEvidenceRequirement(
            obligation.canonicalRequirement,
          );
          if (
            requirement.kind !==
            InvestigationEvidenceRequirementKind.CompleteChangedFile
          ) {
            throw new Error("investigation_inventory_closure_invalid");
          }
          return requirement.pathHash;
        }),
    ),
  ].sort();
  if (
    authenticatedPathHashes.length !== expectedPathHashes.length ||
    authenticatedPathHashes.some(
      (pathHash, index) => pathHash !== expectedPathHashes[index],
    )
  ) {
    throw new Error("investigation_inventory_seed_mismatch");
  }
  const terminal = inventoryClaims[0]!.operationReceiptIds
    .map((receiptId) => input.operationEvidence.get(receiptId)!)
    .find(
      (operation) =>
        operation.operationKind ===
          InvestigationOperationKind.CanonicalInventory && operation.complete,
    ) as InvestigationPageEvidence | undefined;
  if (
    !terminal ||
    terminal.aggregatePathCount !== expectedPathHashes.length ||
    terminal.aggregatePathSetHash !==
      (await input.digest.digestUtf8(canonicalJson(expectedPathHashes)))
  ) {
    throw new Error("investigation_inventory_seed_mismatch");
  }
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

async function assertPageRequirementDigestBinding(
  canonicalRequirement: string,
  digest: InvestigationDigestPort,
): Promise<void> {
  const requirement =
    parseInvestigationEvidenceRequirement(canonicalRequirement);
  if (
    requirement.kind !==
      InvestigationEvidenceRequirementKind.CompletePageChain ||
    requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
  ) {
    return;
  }
  const operationInputHash = await digest.digestUtf8(
    canonicalStandardTextSearchOperationInput(requirement.queryHash),
  );
  if (operationInputHash !== requirement.initialOperationInputHash) {
    throw new Error("investigation_text_search_requirement_digest_mismatch");
  }
}

function receiptKind(
  value: "blob" | "tree" | "search" | "git_fact" | "relation",
): InvestigationReceiptKind {
  switch (value) {
    case "blob":
      return InvestigationReceiptKind.Blob;
    case "tree":
      return InvestigationReceiptKind.Tree;
    case "search":
      return InvestigationReceiptKind.Search;
    case "git_fact":
      return InvestigationReceiptKind.GitFact;
    case "relation":
      return InvestigationReceiptKind.Relation;
  }
}
