import type { InvestigationEvidenceReceipt } from "../../domain/investigation-obligation";
import type { InvestigationTurnProviderKind } from "../../domain/review-investigation-types";

export type PreparedInvestigationReceiptReplay = Readonly<{
  contextAttestationId: string;
  contextAttestationHash: string;
  sourceOperationReceiptIdsHash: string;
  replayCapability: string;
  replayPlanCanonicalJson: string;
  replayPlanHash: string;
}>;

export interface InvestigationReplayPreparationPort {
  prepare(input: {
    readonly sourceInvestigationId: string;
    readonly sourceCertificateId: string;
    readonly sourceCertificateHash: string;
    readonly sourceCertificateExpiresAt: string;
    readonly sourceTerminalProviderKind: InvestigationTurnProviderKind | null;
    readonly sourceTerminalActualModel: string | null;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly targetReviewRevisionHash: string;
    readonly sourceReceipt: InvestigationEvidenceReceipt;
  }): Promise<PreparedInvestigationReceiptReplay | null>;
}
