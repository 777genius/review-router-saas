import { AcceptReviewObservation } from "../application/use-cases/accept-review-observation";
import { LookupReviewEvidence } from "../application/use-cases/lookup-review-evidence";
import { PruneReviewEvidence } from "../application/use-cases/prune-review-evidence";
import type { ClockPort } from "../application/ports/clock-port";
import type { ReviewExecutionAttemptFactsPort } from "../application/ports/review-execution-attempt-facts-port";
import type {
  CurrentEvidenceWriteSafetyDecisionPort,
  CurrentReviewReusePolicyPort,
} from "../application/ports/review-evidence-safety-port";
import type {
  ReviewEvidencePrunerPort,
  ReviewObservationCommandPort,
  ReviewObservationIdentityPort,
  ReviewObservationQueryPort,
} from "../application/ports/review-observation-ports";
import type { Sha256DigestPort } from "../application/ports/sha256-digest-port";
import { NodeSha256DigestAdapter } from "../infrastructure/node/node-sha256-digest-adapter";
export { PrismaReviewObservationStore } from "../infrastructure/prisma/prisma-review-observation-store";

export type ReviewEvidenceCompositionDependencies = Readonly<{
  attempts: ReviewExecutionAttemptFactsPort;
  writeSafety: CurrentEvidenceWriteSafetyDecisionPort;
  reusePolicy: CurrentReviewReusePolicyPort;
  observationCommands: ReviewObservationCommandPort;
  observationQueries: ReviewObservationQueryPort;
  pruner: ReviewEvidencePrunerPort;
  identities: ReviewObservationIdentityPort;
  digest: Sha256DigestPort;
  clock: ClockPort;
  reuseTtlMs: number;
  retainTtlMs: number;
}>;

export function createReviewEvidenceUseCases(
  dependencies: ReviewEvidenceCompositionDependencies,
): Readonly<{
  acceptReviewObservation: AcceptReviewObservation;
  lookupReviewEvidence: LookupReviewEvidence;
  pruneReviewEvidence: PruneReviewEvidence;
}> {
  return Object.freeze({
    acceptReviewObservation: new AcceptReviewObservation({
      attempts: dependencies.attempts,
      safety: dependencies.writeSafety,
      observations: dependencies.observationCommands,
      identities: dependencies.identities,
      digest: dependencies.digest,
      clock: dependencies.clock,
      reuseTtlMs: dependencies.reuseTtlMs,
      retainTtlMs: dependencies.retainTtlMs,
    }),
    lookupReviewEvidence: new LookupReviewEvidence({
      observations: dependencies.observationQueries,
      policy: dependencies.reusePolicy,
      digest: dependencies.digest,
      nowMs: () => dependencies.clock.nowMs(),
    }),
    pruneReviewEvidence: new PruneReviewEvidence({
      pruner: dependencies.pruner,
      clock: dependencies.clock,
    }),
  });
}

export { NodeSha256DigestAdapter };
