import { canonicalInvestigationScope } from "../domain/coverage-contract";
import {
  replayEvidenceCheckpointCanonicalValue,
  type ReplayEvidenceCheckpoint,
  type ReplayEvidenceCheckpointCandidate,
} from "../domain/replay-evidence-checkpoint";
import { isCommittedReplayableObligation } from "../domain/review-investigation-replay-policy";
import type { ReviewInvestigation } from "../domain/review-investigation";
import type {
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
} from "../domain/review-investigation-types";
import type { InvestigationDigestPort } from "./ports/digest-port";
import { digestCanonical } from "./use-cases/investigation-use-case-support";

export async function issueReplayEvidenceCheckpoint(input: {
  readonly source: ReviewInvestigation;
  readonly sourceState: ReviewInvestigationState;
  readonly sourceConclusion: ReviewInvestigationConclusion | null;
  readonly sourceVersion: number;
  readonly issuedAt: Date;
  readonly ttlMs: number;
  readonly digest: InvestigationDigestPort;
}): Promise<ReplayEvidenceCheckpoint | null> {
  const receipts = input.source.obligations
    .filter(isCommittedReplayableObligation)
    .map((obligation) => ({
      obligationId: obligation.obligationId,
      receiptId: obligation.receipt.receiptId,
      evidenceDigest: obligation.receipt.evidenceDigest,
      acceptedAttestationId: obligation.receipt.acceptedAttestationId,
      acceptedAttestationHash: obligation.receipt.acceptedAttestationHash,
    }))
    .sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  if (receipts.length === 0) return null;
  const candidate: ReplayEvidenceCheckpointCandidate = {
    checkpointId: `replay-checkpoint-${input.source.investigationId.slice(-32)}`,
    sourceInvestigationId: input.source.investigationId,
    sourceInvestigationVersion: input.sourceVersion,
    sourceDossierDigest: input.source.dossierDigest,
    scopeHash: await input.digest.digestUtf8(
      canonicalInvestigationScope(input.source.scope),
    ),
    reviewRevisionHash: input.source.revision.reviewRevisionHash,
    stableReviewUnitKey: input.source.stableReviewUnitKey,
    providerVoteLaneId: input.source.providerVoteLaneId,
    contractHash: await digestCanonical(input.digest, input.source.contract),
    policyHash: await digestCanonical(input.digest, input.source.policy),
    producerReleaseId: input.source.contract.producerReleaseId,
    producerReleaseHash: await digestCanonical(input.digest, {
      producerReleaseId: input.source.contract.producerReleaseId,
    }),
    runtimeProfileHash: await digestCanonical(input.digest, {
      runtimeProfile: input.source.runtimeProfile,
      runtimeProfileVersion: input.source.contract.runtimeProfileVersion,
    }),
    receiptSetHash: await digestCanonical(input.digest, receipts),
    contextAttestationSetHash: await digestCanonical(
      input.digest,
      receipts.map((receipt) => ({
        id: receipt.acceptedAttestationId,
        hash: receipt.acceptedAttestationHash,
      })),
    ),
    sourceState: input.sourceState,
    sourceConclusion: input.sourceConclusion,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: new Date(input.issuedAt.getTime() + input.ttlMs).toISOString(),
  };
  return Object.freeze({
    ...candidate,
    checkpointHash: await digestCanonical(
      input.digest,
      replayEvidenceCheckpointCanonicalValue(candidate),
    ),
  });
}
