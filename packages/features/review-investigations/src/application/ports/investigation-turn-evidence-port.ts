import type { VerifiedInvestigationOperationEvidence } from "../../domain/investigation-operation-evidence";
import type { InvestigationTurnProviderKind } from "../../domain/review-investigation-types";

export type { VerifiedInvestigationOperationEvidence } from "../../domain/investigation-operation-evidence";

export type VerifiedInvestigationTurnEvidence = Readonly<{
  acceptedAttestationId: string;
  acceptedAttestationHash: string;
  terminalOutcomeHash: string;
  gatewayPolicyVersion: string;
  actualProviderKind: InvestigationTurnProviderKind;
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
