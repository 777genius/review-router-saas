import {
  assertHash,
  assertIdentifier,
  assertReviewPublicationAttemptCandidate,
} from "../../domain/review-publication-attempt";
import {
  ReviewPublicationCapability,
  type RequestReviewPublicationCommand,
  type RequestReviewPublicationCommandPort,
  type RequestReviewPublicationResult,
  type ReviewPublicationCapabilityGate,
  type ReviewPublicationClockPort,
  type ReviewPublicationDecisionPorts,
} from "../ports/review-publication-ports";
import { assertCurrentReviewPublication } from "./assert-current-review-publication";

export async function requestReviewPublication(
  command: RequestReviewPublicationCommand,
  dependencies: {
    readonly capabilities: ReviewPublicationCapabilityGate;
    readonly clock: ReviewPublicationClockPort;
    readonly decisions: ReviewPublicationDecisionPorts;
    readonly commands: RequestReviewPublicationCommandPort;
  },
): Promise<RequestReviewPublicationResult> {
  dependencies.capabilities.require(ReviewPublicationCapability.Request);
  assertIdentifier(
    command.requestIdHash,
    "publication_request_id_hash_invalid",
  );
  assertHash(command.requestHash, "publication_request_hash_invalid");
  assertReviewPublicationAttemptCandidate(command);
  await assertCurrentReviewPublication({
    permit: command.permit,
    capability: ReviewPublicationCapability.Request,
    now: dependencies.clock.now(),
    decisions: dependencies.decisions,
  });
  return dependencies.commands.request(command);
}
