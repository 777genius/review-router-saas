import type {
  ClockPort,
  IdentifierFactoryPort,
  ReviewRunAuthorizationTokenPort,
  Sha256DigestPort,
} from "../application/ports/platform-ports";
import type {
  ProducerReleaseCommandPort,
  ProducerReleaseQueryPort,
  ReviewOperationalSloProfileCommandPort,
  ReviewOperationalSloProfileQueryPort,
  ReviewProtocolLimitsProfileCommandPort,
  ReviewProtocolLimitsProfileQueryPort,
} from "../application/ports/producer-release-ports";
import type {
  ReviewMutationAuthorityCommandPort,
  ReviewMutationAuthorityQueryPort,
} from "../application/ports/review-mutation-authority-ports";
import type {
  ReviewMutationAuthorityInitializationPolicyPort,
  ReviewMutationAuthorityProofFactsQueryPorts,
} from "../application/ports/review-mutation-authority-proof-ports";
import type {
  ReviewRunAuthorizationAdmissionCommandPort,
  ReviewRunAuthorizationCommandPort,
  ReviewRunAuthorizationQueryPort,
} from "../application/ports/review-run-authorization-ports";
import type {
  ReviewSafetyControlInspectionPort,
  ReviewSafetyEmergencyControlCommandPort,
  ReviewSafetyEmergencyControlQueryPort,
  ReviewSafetyPolicyCommandPort,
  ReviewSafetyPolicyQueryPort,
} from "../application/ports/review-safety-policy-ports";
import type {
  ScmRepositoryIdentityCommandPort,
  ScmRepositoryIdentityQueryPort,
} from "../application/ports/scm-repository-identity-ports";
import { ManageProducerReleases } from "../application/use-cases/manage-producer-releases";
import { ManageReviewMutationAuthority } from "../application/use-cases/manage-review-mutation-authority";
import { ReviewMutationAuthorityProofCollector } from "../application/services/review-mutation-authority-proof-collector";
import { ManageReviewRunAuthorizations } from "../application/use-cases/manage-review-run-authorizations";
import { ManageReviewSafetyControls } from "../application/use-cases/manage-review-safety-controls";
import { ManageScmRepositoryIdentities } from "../application/use-cases/manage-scm-repository-identities";
import { ResolveReviewSafetyPolicy } from "../application/use-cases/resolve-review-safety-policy";
import type { ReviewProtocolLimits } from "../domain/producer-release";
import {
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
  ReviewMutationAuthorityInitializationMode,
} from "../domain/review-run-control-types";

export type ReviewRunControlCompositionDependencies = {
  readonly clock: ClockPort;
  readonly identifiers: IdentifierFactoryPort;
  readonly digest: Sha256DigestPort;
  readonly tokens: ReviewRunAuthorizationTokenPort;
  readonly protocolLimitsQueries: ReviewProtocolLimitsProfileQueryPort;
  readonly protocolLimitsCommands: ReviewProtocolLimitsProfileCommandPort;
  readonly operationalSloQueries: ReviewOperationalSloProfileQueryPort;
  readonly operationalSloCommands: ReviewOperationalSloProfileCommandPort;
  readonly releaseQueries: ProducerReleaseQueryPort;
  readonly releaseCommands: ProducerReleaseCommandPort;
  readonly identityQueries: ScmRepositoryIdentityQueryPort;
  readonly identityCommands: ScmRepositoryIdentityCommandPort;
  readonly authorityQueries: ReviewMutationAuthorityQueryPort;
  readonly authorityCommands: ReviewMutationAuthorityCommandPort;
  readonly mutationAuthorityProofFacts?: ReviewMutationAuthorityProofFactsQueryPorts;
  readonly mutationAuthorityProofTtlMs?: number;
  readonly mutationAuthorityInitializationPolicy?: ReviewMutationAuthorityInitializationPolicyPort;
  readonly policyQueries: ReviewSafetyPolicyQueryPort;
  readonly policyCommands: ReviewSafetyPolicyCommandPort;
  readonly emergencyQueries: ReviewSafetyEmergencyControlQueryPort;
  readonly emergencyCommands: ReviewSafetyEmergencyControlCommandPort;
  readonly safetyInspections: ReviewSafetyControlInspectionPort;
  readonly authorizationQueries: ReviewRunAuthorizationQueryPort;
  readonly authorizationCommands: ReviewRunAuthorizationCommandPort &
    ReviewRunAuthorizationAdmissionCommandPort;
  readonly absoluteProtocolMaxima: ReviewProtocolLimits;
};

export function composeReviewRunControl(
  dependencies: ReviewRunControlCompositionDependencies,
) {
  const safetyResolver = new ResolveReviewSafetyPolicy({
    clock: dependencies.clock,
    digest: dependencies.digest,
    policyQueries: dependencies.policyQueries,
    emergencyQueries: dependencies.emergencyQueries,
  });
  const mutationAuthorityProofs = new ReviewMutationAuthorityProofCollector({
    digest: dependencies.digest,
    facts:
      dependencies.mutationAuthorityProofFacts ??
      unavailableMutationAuthorityProofFacts,
    ...(dependencies.mutationAuthorityProofTtlMs === undefined
      ? {}
      : { proofTtlMs: dependencies.mutationAuthorityProofTtlMs }),
  });
  return {
    producerReleases: new ManageProducerReleases({
      clock: dependencies.clock,
      digest: dependencies.digest,
      protocolLimitsQueries: dependencies.protocolLimitsQueries,
      protocolLimitsCommands: dependencies.protocolLimitsCommands,
      operationalSloQueries: dependencies.operationalSloQueries,
      operationalSloCommands: dependencies.operationalSloCommands,
      releaseQueries: dependencies.releaseQueries,
      releaseCommands: dependencies.releaseCommands,
      absoluteProtocolMaxima: dependencies.absoluteProtocolMaxima,
    }),
    repositoryIdentities: new ManageScmRepositoryIdentities({
      clock: dependencies.clock,
      identifiers: dependencies.identifiers,
      identityQueries: dependencies.identityQueries,
      identityCommands: dependencies.identityCommands,
      authorityQueries: dependencies.authorityQueries,
    }),
    mutationAuthority: new ManageReviewMutationAuthority({
      clock: dependencies.clock,
      queries: dependencies.authorityQueries,
      commands: dependencies.authorityCommands,
      proofs: mutationAuthorityProofs,
      initializationPolicy:
        dependencies.mutationAuthorityInitializationPolicy ??
        v1InitializationPolicy,
    }),
    safetyControls: new ManageReviewSafetyControls({
      clock: dependencies.clock,
      identifiers: dependencies.identifiers,
      inspections: dependencies.safetyInspections,
      policyCommands: dependencies.policyCommands,
      emergencyCommands: dependencies.emergencyCommands,
    }),
    safetyResolver,
    authorizations: new ManageReviewRunAuthorizations({
      clock: dependencies.clock,
      identifiers: dependencies.identifiers,
      digest: dependencies.digest,
      identities: dependencies.identityQueries,
      authorities: dependencies.authorityQueries,
      releases: dependencies.releaseQueries,
      limits: dependencies.protocolLimitsQueries,
      slos: dependencies.operationalSloQueries,
      safetyDecisions: safetyResolver,
      authorizationQueries: dependencies.authorizationQueries,
      authorizationCommands: dependencies.authorizationCommands,
      tokens: dependencies.tokens,
    }),
  } as const;
}

export type ReviewRunControlComposition = ReturnType<
  typeof composeReviewRunControl
>;

const unavailableMutationAuthorityProofFacts: ReviewMutationAuthorityProofFactsQueryPorts =
  {
    inspectDirectV2InitializationFacts: unavailableProofFacts,
    inspectAbortDrainFacts: unavailableProofFacts,
    inspectActivationFacts: unavailableProofFacts,
    inspectResumeFacts: unavailableProofFacts,
  };

async function unavailableProofFacts(): Promise<never> {
  throw new ReviewRunControlDomainError(
    ReviewRunControlErrorCode.ProofRequired,
    "mutation_authority_proof_facts_unavailable",
  );
}

const v1InitializationPolicy: ReviewMutationAuthorityInitializationPolicyPort =
  {
    async selectInitializationMode() {
      return ReviewMutationAuthorityInitializationMode.V1;
    },
  };
