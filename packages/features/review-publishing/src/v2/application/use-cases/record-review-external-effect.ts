import {
  assertFiniteDate,
  assertHash,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  RecordReviewExternalEffectCommand,
  RecordReviewExternalEffectCommandPort,
  RecordReviewExternalEffectResult,
  ReviewPublicationClockPort,
} from "../ports/review-publication-ports";

export async function recordReviewExternalEffect(
  command: Omit<RecordReviewExternalEffectCommand, "observedAt">,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly commands: RecordReviewExternalEffectCommandPort;
  },
): Promise<RecordReviewExternalEffectResult> {
  assertIdentifier(command.effectId, "publication_effect_id_invalid");
  assertHash(
    command.reportRequestHash,
    "publication_effect_request_hash_invalid",
  );
  assertIdentifier(
    command.externalObjectId,
    "publication_external_object_invalid",
  );
  assertFiniteDate(
    command.capability.effectReportUntil,
    "publication_effect_report_until_invalid",
  );
  return dependencies.commands.record({
    ...command,
    observedAt: dependencies.clock.now(),
  });
}
