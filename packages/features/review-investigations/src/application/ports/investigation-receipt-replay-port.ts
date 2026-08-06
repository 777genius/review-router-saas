import type {
  InvestigationEvidenceReceipt,
  InvestigationObligation,
} from "../../domain/investigation-obligation";
import type { ReviewInvestigationRevision } from "../../domain/coverage-contract";

export enum InvestigationReceiptReplayVerdict {
  Matched = "matched",
  Mismatched = "mismatched",
  Unavailable = "unavailable",
}

export type InvestigationReceiptReplayResult =
  | Readonly<{
      verdict: InvestigationReceiptReplayVerdict.Matched;
      targetReceipt: InvestigationEvidenceReceipt;
    }>
  | Readonly<{
      verdict:
        | InvestigationReceiptReplayVerdict.Mismatched
        | InvestigationReceiptReplayVerdict.Unavailable;
      targetReceipt: null;
    }>;

export interface InvestigationReceiptReplayPort {
  replay(input: {
    readonly sourceInvestigationId: string;
    readonly sourceCheckpointHash: string;
    readonly sourceReceiptId: string;
    readonly sourceEvidenceDigest: string;
    readonly sourceObligationId: string;
    readonly replayProofId: string;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly targetProviderVoteLaneId: string;
    readonly producerReleaseId: string;
    readonly obligation: InvestigationObligation;
    readonly sourceReceipt: InvestigationEvidenceReceipt;
    readonly targetRevision: ReviewInvestigationRevision;
    readonly gatewayPolicyVersion: string;
  }): Promise<InvestigationReceiptReplayResult>;
}
