import {
  assertFiniteDate,
  assertHash,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import {
  BeginReviewPublicationOperationStatus,
  ReviewPublicationCapability,
  type BeginReviewPublicationOperationCommand,
  type BeginReviewPublicationOperationCommandPort,
  type BeginReviewPublicationOperationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationCapabilityGate,
  type ReviewPublicationClockPort,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationIdempotencyQueryPort,
} from "../ports/review-publication-ports";
import { assertCurrentReviewPublication } from "./assert-current-review-publication";

export async function beginReviewPublicationOperation(
  command: Omit<BeginReviewPublicationOperationCommand, "startedAt">,
  dependencies: {
    readonly capabilities: ReviewPublicationCapabilityGate;
    readonly clock: ReviewPublicationClockPort;
    readonly decisions: ReviewPublicationDecisionPorts;
    readonly attempts: ReviewPublicationAttemptQueryPort;
    readonly idempotency: ReviewPublicationIdempotencyQueryPort;
    readonly commands: BeginReviewPublicationOperationCommandPort;
  },
): Promise<BeginReviewPublicationOperationResult> {
  dependencies.capabilities.require(ReviewPublicationCapability.BeginOperation);
  assertBeginCommand(command);
  const restored = await dependencies.idempotency.findOperationBeginByRequest({
    publicationAttemptId: command.publicationAttemptId,
    publicationOperationId: command.publicationOperationId,
    claimId: command.claimId,
    acquireRequestIdHash: command.acquireRequestIdHash,
  });
  if (restored) {
    const sameRequest =
      restored.requestHash === command.requestHash &&
      restored.operationAttempt.operationAttemptId ===
        command.operationAttemptId &&
      restored.operationAttempt.claimId === command.claimId &&
      restored.operationAttempt.claimFencingToken ===
        command.claimFencingToken &&
      restored.operationAttempt.acquireRequestIdHash ===
        command.acquireRequestIdHash &&
      restored.operationAttempt.operationCapabilityId ===
        command.operationCapabilityId &&
      restored.operationAttempt.capabilitySigningKeyId ===
        command.capabilitySigningKeyId &&
      restored.operationAttempt.effectReportId === command.effectReportId &&
      restored.operationAttempt.effectReportUntil.getTime() ===
        command.effectReportUntil.getTime() &&
      restored.operationAttempt.retainUntil.getTime() ===
        command.retainUntil.getTime();
    if (!sameRequest) {
      return { status: BeginReviewPublicationOperationStatus.RequestConflict };
    }
    await assertCurrentReviewPublication({
      permit: restored.attempt.permit,
      capability: ReviewPublicationCapability.BeginOperation,
      now: dependencies.clock.now(),
      decisions: dependencies.decisions,
    });
    return {
      status: BeginReviewPublicationOperationStatus.Restored,
      ...restored,
    };
  }
  const current = await dependencies.attempts.findById(
    command.publicationAttemptId,
  );
  if (!current) {
    return { status: BeginReviewPublicationOperationStatus.Missing };
  }
  const now = dependencies.clock.now();
  await assertCurrentReviewPublication({
    permit: current.attempt.permit,
    capability: ReviewPublicationCapability.BeginOperation,
    now,
    decisions: dependencies.decisions,
  });
  return dependencies.commands.begin({ ...command, startedAt: now });
}

function assertBeginCommand(
  command: Omit<BeginReviewPublicationOperationCommand, "startedAt">,
): void {
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
    command.acquireRequestIdHash,
    "publication_begin_request_id_invalid",
  );
  assertHash(command.requestHash, "publication_begin_request_hash_invalid");
  assertIdentifier(
    command.operationAttemptId,
    "publication_operation_attempt_invalid",
  );
  assertIdentifier(
    command.operationCapabilityId,
    "publication_operation_capability_invalid",
  );
  assertIdentifier(
    command.capabilitySigningKeyId,
    "publication_capability_key_invalid",
  );
  assertIdentifier(
    command.effectReportId,
    "publication_effect_report_id_invalid",
  );
  assertFiniteDate(
    command.effectReportUntil,
    "publication_effect_report_until_invalid",
  );
  assertFiniteDate(
    command.retainUntil,
    "publication_operation_retention_invalid",
  );
  if (command.retainUntil < command.effectReportUntil) {
    throw new Error("publication_operation_window_invalid");
  }
}
