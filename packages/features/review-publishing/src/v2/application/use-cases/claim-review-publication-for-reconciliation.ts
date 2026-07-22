import { ReviewPublicationOperationState } from "../../domain/review-publication-attempt";
import {
  ClaimReviewPublicationStatus,
  ReviewPublicationCapability,
  type ClaimReviewPublicationCommand,
  type ClaimReviewPublicationCommandPort,
  type ClaimReviewPublicationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationCapabilityGate,
  type ReviewPublicationClockPort,
  type ReviewPublicationIdempotencyQueryPort,
} from "../ports/review-publication-ports";
import { assertClaimCommand } from "./claim-review-publication";

/**
 * Claims only an operation that may already have reached SCM. This deliberately
 * skips current-revision admission so a replacement worker can reconcile a stale
 * or paused operation; BeginOperation remains independently gated.
 */
export async function claimReviewPublicationForReconciliation(
  command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
  dependencies: {
    readonly capabilities: ReviewPublicationCapabilityGate;
    readonly clock: ReviewPublicationClockPort;
    readonly attempts: ReviewPublicationAttemptQueryPort;
    readonly idempotency: ReviewPublicationIdempotencyQueryPort;
    readonly commands: ClaimReviewPublicationCommandPort;
  },
): Promise<ClaimReviewPublicationResult> {
  dependencies.capabilities.require(
    ReviewPublicationCapability.ClaimReconciliation,
  );
  assertClaimCommand(command);
  const restored = await dependencies.idempotency.findClaimByRequest({
    publicationAttemptId: command.publicationAttemptId,
    acquireRequestIdHash: command.acquireRequestIdHash,
  });
  if (restored) {
    return sameClaimRequest(restored, command)
      ? { status: ClaimReviewPublicationStatus.Restored, ...restored }
      : { status: ClaimReviewPublicationStatus.RequestConflict };
  }

  const current = await dependencies.attempts.findById(
    command.publicationAttemptId,
  );
  if (!current) {
    return { status: ClaimReviewPublicationStatus.Missing };
  }
  const mayHaveExternalEffect =
    current.effects.length > 0 ||
    current.operationAttempts.length > 0 ||
    current.attempt.operations.some(
      (operation) =>
        operation.state === ReviewPublicationOperationState.InFlight ||
        operation.state === ReviewPublicationOperationState.EffectObserved ||
        operation.state === ReviewPublicationOperationState.Reconciling,
    );
  if (!mayHaveExternalEffect) {
    return { status: ClaimReviewPublicationStatus.Terminal };
  }
  return dependencies.commands.claim({
    ...command,
    acquiredAt: dependencies.clock.now(),
  });
}

function sameClaimRequest(
  restored: NonNullable<
    Awaited<
      ReturnType<ReviewPublicationIdempotencyQueryPort["findClaimByRequest"]>
    >
  >,
  command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
): boolean {
  return (
    restored.requestHash === command.requestHash &&
    restored.claim.claimId === command.claimId &&
    restored.claim.ownerIdHash === command.ownerIdHash &&
    restored.claim.acquireRequestIdHash === command.acquireRequestIdHash &&
    restored.claim.claimCapabilityId === command.claimCapabilityId &&
    restored.claim.capabilitySigningKeyId === command.capabilitySigningKeyId &&
    restored.claim.expiresAt.getTime() === command.expiresAt.getTime() &&
    restored.claim.retainUntil.getTime() === command.retainUntil.getTime() &&
    restored.capability.reportUntil.getTime() === command.reportUntil.getTime()
  );
}
