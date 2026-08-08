import {
  assertFiniteDate,
  assertIdentifier,
} from "../../domain/review-publication-attempt";
import type {
  ProveReviewPublicationNoEffectCommand,
  ProveReviewPublicationNoEffectCommandPort,
  ProveReviewPublicationNoEffectResult,
  ReviewPublicationClockPort,
  ReviewPublicationNoEffectProofHashPort,
} from "../ports/review-publication-ports";

export async function proveReviewPublicationNoEffect(
  command: Omit<
    ProveReviewPublicationNoEffectCommand,
    "noEffectProofHash" | "provenAt"
  >,
  dependencies: {
    readonly clock: ReviewPublicationClockPort;
    readonly commands: ProveReviewPublicationNoEffectCommandPort;
    readonly proofHashes: ReviewPublicationNoEffectProofHashPort;
  },
): Promise<ProveReviewPublicationNoEffectResult> {
  assertIdentifier(
    command.noEffectProofId,
    "publication_no_effect_proof_id_invalid",
  );
  assertIdentifier(
    command.noEffectReason,
    "publication_no_effect_reason_invalid",
  );
  assertFiniteDate(
    command.capability.effectReportUntil,
    "publication_effect_report_until_invalid",
  );
  return dependencies.commands.proveNoEffect({
    ...command,
    noEffectProofHash: dependencies.proofHashes.hash(command),
    provenAt: dependencies.clock.now(),
  });
}
