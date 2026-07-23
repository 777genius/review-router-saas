import {
  assertFiniteDate,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  RenewReviewPublicationClaimCommand,
  RenewReviewPublicationClaimCommandPort,
  RenewReviewPublicationClaimResult,
  ReviewPublicationClockPort,
} from "../ports/review-publication-ports";

export async function renewReviewPublicationClaim(
  command: Omit<RenewReviewPublicationClaimCommand, "requestedAt">,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly commands: RenewReviewPublicationClaimCommandPort;
  },
): Promise<RenewReviewPublicationClaimResult> {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(command.claimId, "publication_claim_id_invalid");
  assertIdentifier(command.ownerIdHash, "publication_claim_owner_invalid");
  if (command.claimFencingToken <= 0n) {
    throw new Error("publication_claim_fence_invalid");
  }
  for (const value of [command.extendByMs, command.minimumRemainingMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("publication_claim_renewal_window_invalid");
    }
  }
  const requestedAt = dependencies.clock.now();
  assertFiniteDate(requestedAt, "publication_claim_renewed_at_invalid");
  return dependencies.commands.renewClaim({ ...command, requestedAt });
}
