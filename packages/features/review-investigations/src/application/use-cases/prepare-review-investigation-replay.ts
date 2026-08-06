import type {
  ReviewInvestigationContract,
  ReviewInvestigationRevision,
  ReviewInvestigationScope,
} from "../../domain/coverage-contract";
import { canonicalJson } from "../../domain/canonicalization";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  evaluateReceiptReplayEligibility,
  isCommittedReplayableObligation,
} from "../../domain/review-investigation-replay-policy";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type {
  InvestigationReplayPreparationPort,
  PreparedInvestigationReceiptReplay,
} from "../ports/investigation-replay-preparation-port";
import type { InvestigationStorePort } from "../ports/investigation-store-port";
import { requireCurrentExecution } from "./investigation-use-case-support";

export enum PrepareReviewInvestigationReplayStatus {
  Prepared = "prepared",
  Missing = "missing",
}

export type PrepareReviewInvestigationReplayResult = Readonly<{
  status: PrepareReviewInvestigationReplayStatus;
  sourceInvestigationId: string | null;
  sourceCheckpointId: string | null;
  sourceCheckpointHash: string | null;
  obligations: readonly Readonly<{
    obligationId: string;
    replay: PreparedInvestigationReceiptReplay;
  }>[];
}>;

export class PrepareReviewInvestigationReplay {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly preparation: InvestigationReplayPreparationPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(command: {
    readonly targetScope: ReviewInvestigationScope;
    readonly targetRevision: ReviewInvestigationRevision;
    readonly targetExecutionId: string;
    readonly targetWorkSlotId: string;
    readonly stableReviewUnitKey: string;
    readonly providerVoteLaneId: string;
    readonly producerReleaseId: string;
    readonly targetContract: ReviewInvestigationContract;
  }): Promise<PrepareReviewInvestigationReplayResult> {
    await requireCurrentExecution({
      authority: this.authority,
      investigation: {
        scope: command.targetScope,
        revision: command.targetRevision,
        executionId: command.targetExecutionId,
        workSlotId: command.targetWorkSlotId,
        providerVoteLaneId: command.providerVoteLaneId,
      },
    });
    const candidates = await this.store.findReplayCandidates({
      scope: command.targetScope,
      targetReviewRevisionHash: command.targetRevision.reviewRevisionHash,
      stableReviewUnitKey: command.stableReviewUnitKey,
      providerVoteLaneId: command.providerVoteLaneId,
      producerReleaseId: command.producerReleaseId,
      limit: 8,
    });
    for (const candidate of candidates) {
      if (!this.replayable(candidate, command)) continue;
      const prepared = await this.prepareCandidate(candidate, command);
      if (prepared.length > 0) {
        return Object.freeze({
          status: PrepareReviewInvestigationReplayStatus.Prepared,
          sourceInvestigationId: candidate.investigationId,
          sourceCheckpointId: candidate.replayEvidenceCheckpoint!.checkpointId,
          sourceCheckpointHash:
            candidate.replayEvidenceCheckpoint!.checkpointHash,
          obligations: Object.freeze(prepared),
        });
      }
    }
    return Object.freeze({
      status: PrepareReviewInvestigationReplayStatus.Missing,
      sourceInvestigationId: null,
      sourceCheckpointId: null,
      sourceCheckpointHash: null,
      obligations: Object.freeze([]),
    });
  }

  private replayable(
    candidate: ReviewInvestigation,
    command: {
      readonly targetRevision: ReviewInvestigationRevision;
      readonly producerReleaseId: string;
      readonly targetContract: ReviewInvestigationContract;
    },
  ): boolean {
    const checkpoint = candidate.replayEvidenceCheckpoint;
    return (
      checkpoint !== null &&
      evaluateReceiptReplayEligibility(candidate, this.clock.now().getTime())
        .eligible &&
      checkpoint.producerReleaseId === command.producerReleaseId &&
      candidate.contract.producerReleaseId === command.producerReleaseId &&
      canonicalJson(candidate.contract) ===
        canonicalJson(command.targetContract) &&
      candidate.revision.reviewRevisionHash !==
        command.targetRevision.reviewRevisionHash
    );
  }

  private async prepareCandidate(
    candidate: ReviewInvestigation,
    command: {
      readonly targetExecutionId: string;
      readonly targetWorkSlotId: string;
      readonly targetRevision: ReviewInvestigationRevision;
    },
  ) {
    const prepared: Array<{
      obligationId: string;
      replay: PreparedInvestigationReceiptReplay;
    }> = [];
    const cache = new Map<string, PreparedInvestigationReceiptReplay | null>();
    for (const obligation of candidate.obligations) {
      const receipt = obligation.receipt;
      if (!isCommittedReplayableObligation(obligation) || receipt === null) {
        continue;
      }
      const key = [
        receipt.acceptedAttestationId,
        ...receipt.operationReceiptIds,
      ].join("\0");
      let replay = cache.get(key);
      if (replay === undefined) {
        replay = await this.preparation.prepare({
          sourceInvestigationId: candidate.investigationId,
          sourceCheckpointId: candidate.replayEvidenceCheckpoint!.checkpointId,
          sourceCheckpointHash:
            candidate.replayEvidenceCheckpoint!.checkpointHash,
          sourceCheckpointExpiresAt:
            candidate.replayEvidenceCheckpoint!.expiresAt,
          targetExecutionId: command.targetExecutionId,
          targetWorkSlotId: command.targetWorkSlotId,
          targetReviewRevisionHash: command.targetRevision.reviewRevisionHash,
          sourceReceipt: receipt,
        });
        cache.set(key, replay);
      }
      if (replay !== null) {
        prepared.push(
          Object.freeze({
            obligationId: obligation.obligationId,
            replay,
          }),
        );
      }
    }
    return prepared;
  }
}
