import {
  assertHash,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  CompleteReviewPublicationOperationCommand,
  CompleteReviewPublicationOperationCommandPort,
  CompleteReviewPublicationOperationResult,
  ReviewPublicationClockPort,
} from "../ports/review-publication-ports";

export async function completeReviewPublicationOperation(
  command: Omit<CompleteReviewPublicationOperationCommand, "completedAt">,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly commands: CompleteReviewPublicationOperationCommandPort;
  },
): Promise<CompleteReviewPublicationOperationResult> {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(
    command.publicationOperationId,
    "publication_operation_id_invalid",
  );
  assertIdentifier(command.claimId, "publication_claim_id_invalid");
  if (command.claimFencingToken <= 0n) {
    throw new Error("publication_claim_fence_invalid");
  }
  assertHash(
    command.completionRequestIdHash,
    "publication_completion_request_id_invalid",
  );
  assertHash(
    command.requestHash,
    "publication_completion_request_hash_invalid",
  );
  assertIdentifier(command.receiptId, "publication_receipt_id_invalid");
  assertIdentifier(command.canonicalEffectId, "publication_effect_id_invalid");
  assertHash(command.receiptHash, "publication_receipt_hash_invalid");
  return dependencies.commands.complete({
    ...command,
    completedAt: dependencies.clock.now(),
  });
}
