import {
  assertFiniteDate,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  ReviewPublicationClockPort,
  TerminalizeUnknownReviewPublicationCommand,
  TerminalizeUnknownReviewPublicationCommandPort,
  TerminalizeUnknownReviewPublicationResult,
} from "../ports/review-publication-ports";

export async function terminalizeUnknownReviewPublication(
  command: Omit<TerminalizeUnknownReviewPublicationCommand, "terminalizedAt">,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly commands: TerminalizeUnknownReviewPublicationCommandPort;
  },
): Promise<TerminalizeUnknownReviewPublicationResult> {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(
    command.publicationOperationId,
    "publication_operation_id_invalid",
  );
  if (command.claimId !== null) {
    assertIdentifier(command.claimId, "publication_claim_id_invalid");
  }
  if (
    (command.claimId === null) !== (command.claimFencingToken === null) ||
    (command.claimFencingToken !== null && command.claimFencingToken <= 0n)
  ) {
    throw new Error("publication_claim_fence_invalid");
  }
  assertIdentifier(command.tombstoneId, "publication_tombstone_id_invalid");
  const siblingOperationIds = new Set<string>();
  const siblingTombstoneIds = new Set([command.tombstoneId]);
  for (const sibling of command.siblingTombstones) {
    assertIdentifier(
      sibling.publicationOperationId,
      "publication_operation_id_invalid",
    );
    assertIdentifier(sibling.tombstoneId, "publication_tombstone_id_invalid");
    if (
      sibling.publicationOperationId === command.publicationOperationId ||
      siblingOperationIds.has(sibling.publicationOperationId) ||
      siblingTombstoneIds.has(sibling.tombstoneId)
    ) {
      throw new Error("publication_terminal_tombstone_plan_invalid");
    }
    siblingOperationIds.add(sibling.publicationOperationId);
    siblingTombstoneIds.add(sibling.tombstoneId);
  }
  assertIdentifier(command.finalReason, "publication_terminal_reason_invalid");
  assertIdentifier(command.lastErrorCode, "publication_last_error_invalid");
  assertIdentifier(
    command.terminalizedBy,
    "publication_terminal_actor_invalid",
  );
  assertFiniteDate(
    command.retainUntil,
    "publication_terminal_retention_invalid",
  );
  return dependencies.commands.terminalizeUnknown({
    ...command,
    terminalizedAt: dependencies.clock.now(),
  });
}
