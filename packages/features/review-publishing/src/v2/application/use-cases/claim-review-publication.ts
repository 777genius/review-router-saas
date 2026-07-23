import {
  assertFiniteDate,
  assertHash,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import {
  ClaimReviewPublicationStatus,
  ReviewPublicationCapability,
  type ClaimReviewPublicationCommand,
  type ClaimReviewPublicationCommandPort,
  type ClaimReviewPublicationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationCapabilityGate,
  type ReviewPublicationClockPort,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationIdempotencyQueryPort,
} from "../ports/review-publication-ports";
import { assertCurrentReviewPublication } from "./assert-current-review-publication";

export async function claimReviewPublication(
  command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
  dependencies: {
    readonly capabilities: ReviewPublicationCapabilityGate;
    readonly clock: ReviewPublicationClockPort;
    readonly decisions: ReviewPublicationDecisionPorts;
    readonly attempts: ReviewPublicationAttemptQueryPort;
    readonly idempotency: ReviewPublicationIdempotencyQueryPort;
    readonly commands: ClaimReviewPublicationCommandPort;
  },
): Promise<ClaimReviewPublicationResult> {
  dependencies.capabilities.require(ReviewPublicationCapability.Claim);
  assertClaimCommand(command);
  const restored = await dependencies.idempotency.findClaimByRequest({
    publicationAttemptId: command.publicationAttemptId,
    acquireRequestIdHash: command.acquireRequestIdHash,
  });
  if (restored) {
    const sameRequest =
      restored.requestHash === command.requestHash &&
      restored.claim.claimId === command.claimId &&
      restored.claim.ownerIdHash === command.ownerIdHash &&
      restored.claim.acquireRequestIdHash === command.acquireRequestIdHash &&
      restored.claim.claimCapabilityId === command.claimCapabilityId &&
      restored.claim.capabilitySigningKeyId ===
        command.capabilitySigningKeyId &&
      restored.claim.expiresAt.getTime() === command.expiresAt.getTime() &&
      restored.claim.retainUntil.getTime() === command.retainUntil.getTime() &&
      restored.capability.reportUntil.getTime() ===
        command.reportUntil.getTime();
    if (!sameRequest) {
      return { status: ClaimReviewPublicationStatus.RequestConflict };
    }
    await assertCurrentReviewPublication({
      permit: restored.attempt.permit,
      capability: ReviewPublicationCapability.Claim,
      now: dependencies.clock.now(),
      decisions: dependencies.decisions,
    });
    return { status: ClaimReviewPublicationStatus.Restored, ...restored };
  }
  const current = await dependencies.attempts.findById(
    command.publicationAttemptId,
  );
  if (!current) {
    return { status: ClaimReviewPublicationStatus.Missing };
  }
  const now = dependencies.clock.now();
  await assertCurrentReviewPublication({
    permit: current.attempt.permit,
    capability: ReviewPublicationCapability.Claim,
    now,
    decisions: dependencies.decisions,
  });
  return dependencies.commands.claim({ ...command, acquiredAt: now });
}

export function assertClaimCommand(
  command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
): void {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(command.claimId, "publication_claim_id_invalid");
  assertHash(command.ownerIdHash, "publication_owner_hash_invalid");
  assertHash(
    command.acquireRequestIdHash,
    "publication_claim_request_id_invalid",
  );
  assertHash(command.requestHash, "publication_claim_request_hash_invalid");
  assertIdentifier(
    command.claimCapabilityId,
    "publication_claim_capability_invalid",
  );
  assertIdentifier(
    command.capabilitySigningKeyId,
    "publication_capability_key_invalid",
  );
  assertFiniteDate(command.expiresAt, "publication_claim_expiry_invalid");
  assertFiniteDate(
    command.reportUntil,
    "publication_claim_report_until_invalid",
  );
  assertFiniteDate(command.retainUntil, "publication_claim_retention_invalid");
  if (
    command.reportUntil < command.expiresAt ||
    command.retainUntil < command.reportUntil
  ) {
    throw new Error("publication_claim_window_invalid");
  }
}
