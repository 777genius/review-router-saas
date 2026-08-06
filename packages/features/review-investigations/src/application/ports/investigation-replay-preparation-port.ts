import type { InvestigationEvidenceReceipt } from "../../domain/investigation-obligation";

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
    readonly sourceCheckpointId: string;
    readonly sourceCheckpointHash: string;
    readonly sourceCheckpointExpiresAt: string;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly targetReviewRevisionHash: string;
    readonly sourceReceipt: InvestigationEvidenceReceipt;
  }): Promise<PreparedInvestigationReceiptReplay | null>;
}
