import { AcceptReviewObservation } from "../application/use-cases/accept-review-observation";
import { LookupReviewEvidence } from "../application/use-cases/lookup-review-evidence";
import { ProjectInvestigationShadowEvidence } from "../application/use-cases/project-investigation-shadow-evidence";
import { PruneInvestigationShadowEvidence } from "../application/use-cases/prune-investigation-shadow-evidence";
import { PruneReviewEvidence } from "../application/use-cases/prune-review-evidence";
import type { ClockPort } from "../application/ports/clock-port";
import type { AcceptedContextAttestationVerificationPort } from "../application/ports/context-attestation-verification-port";
import type { AcceptedInvestigationCertificateVerificationPort } from "../application/ports/investigation-certificate-verification-port";
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
import type {
  InvestigationShadowEvidenceCommandPort,
  InvestigationShadowEvidencePrunerPort,
  InvestigationShadowEvidenceQueryPort,
} from "../application/ports/investigation-shadow-evidence-ports";
import { NodeSha256DigestAdapter } from "../infrastructure/node/node-sha256-digest-adapter";
export { PrismaReviewObservationStore } from "../infrastructure/prisma/prisma-review-observation-store";
export { PrismaInvestigationShadowEvidenceStore } from "../infrastructure/prisma/prisma-investigation-shadow-evidence-store";

export type ReviewEvidenceCompositionDependencies = Readonly<{
  attempts: ReviewExecutionAttemptFactsPort;
  writeSafety: CurrentEvidenceWriteSafetyDecisionPort;
  reusePolicy: CurrentReviewReusePolicyPort;
  observationCommands: ReviewObservationCommandPort;
  observationQueries: ReviewObservationQueryPort;
  pruner: ReviewEvidencePrunerPort;
  identities: ReviewObservationIdentityPort;
  contextAttestations: AcceptedContextAttestationVerificationPort;
  investigationCertificates: AcceptedInvestigationCertificateVerificationPort;
  investigationCertificateAcceptanceEnabled: boolean;
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
      contextAttestations: dependencies.contextAttestations,
      investigationCertificates: dependencies.investigationCertificates,
      investigationCertificateAcceptanceEnabled:
        dependencies.investigationCertificateAcceptanceEnabled,
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

export type InvestigationShadowEvidenceCompositionDependencies = Readonly<{
  commands: InvestigationShadowEvidenceCommandPort;
  queries: InvestigationShadowEvidenceQueryPort;
  pruner: InvestigationShadowEvidencePrunerPort;
  digest: Sha256DigestPort;
  clock: ClockPort;
}>;

export function createInvestigationShadowEvidenceUseCases(
  dependencies: InvestigationShadowEvidenceCompositionDependencies,
): Readonly<{
  projectInvestigationShadowEvidence: ProjectInvestigationShadowEvidence;
  pruneInvestigationShadowEvidence: PruneInvestigationShadowEvidence;
  investigationShadowEvidenceQueries: InvestigationShadowEvidenceQueryPort;
}> {
  return Object.freeze({
    projectInvestigationShadowEvidence: new ProjectInvestigationShadowEvidence({
      records: dependencies.commands,
      digest: dependencies.digest,
    }),
    pruneInvestigationShadowEvidence: new PruneInvestigationShadowEvidence({
      records: dependencies.pruner,
      clock: dependencies.clock,
    }),
    investigationShadowEvidenceQueries: dependencies.queries,
  });
}

export { NodeSha256DigestAdapter };
