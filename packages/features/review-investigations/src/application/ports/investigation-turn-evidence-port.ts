import type { InvestigationReceiptKind } from "../../domain/investigation-obligation";

export type VerifiedInvestigationOperationEvidence = Readonly<{
  operationReceiptId: string;
  operationKey: string;
  kind: InvestigationReceiptKind;
  evidenceDigest: string;
}>;

export type VerifiedInvestigationTurnEvidence = Readonly<{
  acceptedAttestationId: string;
  acceptedAttestationHash: string;
  terminalOutcomeHash: string;
  gatewayPolicyVersion: string;
  operations: readonly VerifiedInvestigationOperationEvidence[];
}>;

export interface InvestigationTurnEvidencePort {
  verify(input: {
    readonly acceptedAttestationId: string;
    readonly acceptedAttestationHash: string;
    readonly sourceExecutionId: string;
    readonly sourceWorkSlotId: string;
    readonly sourceReviewRevisionHash: string;
    readonly attemptId: string;
    readonly sourceLeaseId: string;
    readonly sourceFencingToken: string;
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<VerifiedInvestigationTurnEvidence | null>;
}
