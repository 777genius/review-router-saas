import {
  assertFiniteDate,
  assertHash,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  AdjudicateReviewPublicationOutcomeCommand,
  AdjudicateReviewPublicationOutcomeCommandPort,
  AdjudicateReviewPublicationOutcomeResult,
  ReviewPublicationAdjudicationEvidencePort,
  ReviewPublicationClockPort,
} from "../ports/review-publication-ports";
import {
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationAdjudicationRejectedError,
} from "../ports/review-publication-ports";

export async function adjudicateReviewPublicationOutcome(
  command: Omit<
    AdjudicateReviewPublicationOutcomeCommand,
    "correctedAt" | "provenReceipts"
  >,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly evidence: ReviewPublicationAdjudicationEvidencePort;
    readonly commands: AdjudicateReviewPublicationOutcomeCommandPort;
  },
): Promise<AdjudicateReviewPublicationOutcomeResult> {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(command.correctionId, "publication_correction_id_invalid");
  if (
    !Number.isSafeInteger(command.correctionOrdinal) ||
    command.correctionOrdinal <= 0
  ) {
    throw new Error("publication_correction_ordinal_invalid");
  }
  assertHash(command.evidenceHash, "publication_correction_evidence_invalid");
  assertIdentifier(command.correctedBy, "publication_correction_actor_invalid");
  assertFiniteDate(
    command.retainUntil,
    "publication_correction_retention_invalid",
  );
  const evidence = await dependencies.evidence.resolve({
    publicationAttemptId: command.publicationAttemptId,
    correctedOutcome: command.correctedOutcome,
    evidenceHash: command.evidenceHash,
  });
  if (
    evidence.status !== ReviewPublicationAdjudicationEvidenceStatus.Proven ||
    evidence.evidenceHash !== command.evidenceHash
  ) {
    throw new ReviewPublicationAdjudicationRejectedError(
      evidence.status === ReviewPublicationAdjudicationEvidenceStatus.Proven
        ? "publication_adjudication_evidence_mismatch"
        : evidence.reason,
    );
  }
  return dependencies.commands.adjudicate({
    ...command,
    provenReceipts: evidence.provenReceipts,
    correctedAt: dependencies.clock.now(),
  });
}
