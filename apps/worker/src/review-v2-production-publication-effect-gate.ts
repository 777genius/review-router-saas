import {
  ProviderExecutionProfile,
  ReviewProviderKind as EvidenceProviderKind,
  type ReviewObservationQueryPort,
} from "@reviewrouter/features-review-evidence";
import {
  reviewProjectionObservationAuthorityFromJson,
  ReviewProjectionAuthoritySource,
  type ReviewExecutionQueryPort,
} from "@reviewrouter/features-review-executions";
import {
  ReviewInvestigationConclusion,
  type InvestigationStorePort,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutDecision,
  InvestigationRolloutProvider,
  type ResolveInvestigationRollout,
} from "@reviewrouter/features-review-investigation-operations";
import type { ReviewPublicationPermitIdentity } from "@reviewrouter/features-review-publishing/v2";
import type { ReviewRunAuthorizationQueryPort } from "@reviewrouter/features-review-run-control";
import {
  ReviewV2PublicationEffectGateDecision,
  type ReviewV2PublicationEffectGatePort,
} from "./review-v2-publication-ports";

export type ProductionReviewInvestigationPublicationEffectGateDependencies =
  Readonly<{
    executions: Pick<ReviewExecutionQueryPort, "findExecution">;
    observations: Pick<ReviewObservationQueryPort, "findById">;
    investigations: Pick<InvestigationStorePort, "findByCertificateId">;
    authorizations: Pick<
      ReviewRunAuthorizationQueryPort,
      "findReviewRunAuthorizationById"
    >;
    rollout: Pick<ResolveInvestigationRollout, "execute">;
  }>;

export function createProductionReviewInvestigationPublicationEffectGate(
  dependencies: ProductionReviewInvestigationPublicationEffectGateDependencies,
): ReviewV2PublicationEffectGatePort {
  return new ProductionReviewInvestigationPublicationEffectGate(dependencies);
}

class ProductionReviewInvestigationPublicationEffectGate implements ReviewV2PublicationEffectGatePort {
  constructor(
    private readonly dependencies: ProductionReviewInvestigationPublicationEffectGateDependencies,
  ) {}

  async authorize(
    input: Parameters<ReviewV2PublicationEffectGatePort["authorize"]>[0],
  ): Promise<ReviewV2PublicationEffectGateDecision> {
    try {
      const snapshot = await this.dependencies.executions.findExecution(
        input.permit.executionId,
      );
      if (
        !snapshot ||
        !publicationExecutionMatchesPermit(snapshot, input.permit) ||
        !snapshot.artifact ||
        snapshot.artifact.projectionHash !== input.permit.projectionHash
      ) {
        return ReviewV2PublicationEffectGateDecision.Unavailable;
      }
      const authority = reviewProjectionObservationAuthorityFromJson(
        snapshot.artifact.projectionEnvelopeJson,
      );
      const attachedObservationIds = new Set(
        snapshot.observationRefs.map((reference) => reference.observationId),
      );
      if (
        authority.observationIds.some(
          (observationId) => !attachedObservationIds.has(observationId),
        )
      ) {
        return ReviewV2PublicationEffectGateDecision.Unavailable;
      }
      const inspectLegacyCleanAttachments =
        authority.source ===
          ReviewProjectionAuthoritySource.LegacyOccurrenceLineage &&
        authority.observationIds.length === 0;
      const observationIds = inspectLegacyCleanAttachments
        ? [...attachedObservationIds]
        : authority.observationIds;
      const observations = await Promise.all(
        observationIds.map((observationId) =>
          this.dependencies.observations.findById(observationId),
        ),
      );
      if (observations.some((observation) => observation === null)) {
        return ReviewV2PublicationEffectGateDecision.Unavailable;
      }
      const availableObservations = observations.filter(
        (observation): observation is NonNullable<typeof observation> =>
          observation !== null,
      );
      const investigationObservations: typeof availableObservations = [];
      for (const observation of availableObservations) {
        const hasCertificateId =
          observation.investigationCertificateId !== null;
        const hasCertificateHash =
          observation.investigationCertificateHash !== null;
        const isInvestigation =
          observation.executionProfile ===
          ProviderExecutionProfile.InvestigationGatewayV1;
        if (
          hasCertificateId !== hasCertificateHash ||
          isInvestigation !== hasCertificateId
        ) {
          return ReviewV2PublicationEffectGateDecision.Unavailable;
        }
        if (inspectLegacyCleanAttachments) {
          if (isInvestigation) {
            return ReviewV2PublicationEffectGateDecision.Unavailable;
          }
          continue;
        }
        if (isInvestigation) investigationObservations.push(observation);
      }
      if (investigationObservations.length === 0) {
        return ReviewV2PublicationEffectGateDecision.Allowed;
      }
      const authorization =
        await this.dependencies.authorizations.findReviewRunAuthorizationById(
          input.permit.authorizationId,
        );
      if (
        !authorization ||
        !authorizationMatchesPermit(authorization, input.permit)
      ) {
        return ReviewV2PublicationEffectGateDecision.Unavailable;
      }
      for (const observation of investigationObservations) {
        if (!observation.investigationCertificateId) {
          return ReviewV2PublicationEffectGateDecision.Unavailable;
        }
        const investigation =
          await this.dependencies.investigations.findByCertificateId(
            observation.investigationCertificateId,
          );
        if (
          !investigation?.certificate ||
          investigation.certificate.certificateId !==
            observation.investigationCertificateId ||
          investigation.certificate.certificateHash !==
            observation.investigationCertificateHash ||
          !investigationMatchesObservation(investigation, observation) ||
          investigation.scope.trustDomain !== authorization.trustDomain ||
          observation.producerReleaseId !== authorization.producerReleaseId
        ) {
          return ReviewV2PublicationEffectGateDecision.Unavailable;
        }
        const provider = supportedInvestigationProvider(
          observation.providerKind,
        );
        if (provider === null) {
          return ReviewV2PublicationEffectGateDecision.Disabled;
        }
        const target = {
          workspaceId: authorization.workspaceId,
          repositoryConnectionId: authorization.repositoryConnectionId,
          scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
          provider,
          trustDomain: authorization.trustDomain,
          producerReleaseId: authorization.producerReleaseId,
        } as const;
        const production = await this.dependencies.rollout.execute({
          capability: InvestigationRolloutCapability.ProductionEffects,
          target,
        });
        if (production !== InvestigationRolloutDecision.Allowed) {
          return rolloutEffectDecision(production);
        }
        if (
          investigation.certificate.conclusion ===
          ReviewInvestigationConclusion.VerifiedClean
        ) {
          const verifiedClean = await this.dependencies.rollout.execute({
            capability: InvestigationRolloutCapability.VerifiedClean,
            target,
          });
          if (verifiedClean !== InvestigationRolloutDecision.Allowed) {
            return rolloutEffectDecision(verifiedClean);
          }
        }
      }
      return ReviewV2PublicationEffectGateDecision.Allowed;
    } catch {
      return ReviewV2PublicationEffectGateDecision.Unavailable;
    }
  }
}

function publicationExecutionMatchesPermit(
  snapshot: NonNullable<
    Awaited<ReturnType<ReviewExecutionQueryPort["findExecution"]>>
  >,
  permit: ReviewPublicationPermitIdentity,
): boolean {
  const execution = snapshot.execution;
  return (
    execution.executionId === permit.executionId &&
    execution.generation === permit.generation &&
    execution.authorizationId === permit.authorizationId &&
    execution.producerReleaseId === permit.producerReleaseId &&
    execution.workspaceId === permit.workspaceId &&
    execution.repositoryConnectionId === permit.repositoryConnectionId &&
    execution.scmRepositoryIdentityId === permit.scmRepositoryIdentityId &&
    execution.pullRequestNumber === permit.pullRequestNumber &&
    execution.revision.headSha === permit.reviewedHeadSha &&
    execution.revision.reviewRevisionHash === permit.reviewRevisionHash
  );
}

function authorizationMatchesPermit(
  authorization: NonNullable<
    Awaited<
      ReturnType<
        ReviewRunAuthorizationQueryPort["findReviewRunAuthorizationById"]
      >
    >
  >,
  permit: ReviewPublicationPermitIdentity,
): boolean {
  return (
    authorization.authorizationId === permit.authorizationId &&
    authorization.workspaceId === permit.workspaceId &&
    authorization.repositoryConnectionId === permit.repositoryConnectionId &&
    authorization.scmRepositoryIdentityId === permit.scmRepositoryIdentityId &&
    authorization.pullRequestNumber === permit.pullRequestNumber &&
    authorization.producerReleaseId === permit.producerReleaseId
  );
}

function investigationMatchesObservation(
  investigation: NonNullable<
    Awaited<ReturnType<InvestigationStorePort["findByCertificateId"]>>
  >,
  observation: NonNullable<
    Awaited<ReturnType<ReviewObservationQueryPort["findById"]>>
  >,
): boolean {
  return (
    investigation.scope.workspaceId === observation.scope.workspaceId &&
    investigation.scope.repositoryConnectionId ===
      observation.scope.repositoryConnectionId &&
    investigation.scope.scmRepositoryIdentityId ===
      observation.scope.scmRepositoryIdentityId &&
    investigation.scope.pullRequestNumber ===
      observation.scope.pullRequestNumber &&
    investigation.scope.authorizationScopeHash ===
      observation.scope.authorizationScopeHash &&
    investigation.scope.trustDomain === observation.trustDomain &&
    investigation.revision.baseSha === observation.sourceRevision.baseSha &&
    investigation.revision.mergeBaseSha ===
      observation.sourceRevision.mergeBaseSha &&
    investigation.revision.headSha === observation.sourceRevision.headSha &&
    investigation.revision.reviewRevisionHash ===
      observation.sourceRevision.reviewRevisionHash &&
    investigation.certificate?.producerReleaseId ===
      observation.producerReleaseId &&
    investigation.certificate.reviewRevisionHash ===
      observation.sourceRevision.reviewRevisionHash
  );
}

function rolloutEffectDecision(
  decision: InvestigationRolloutDecision,
): ReviewV2PublicationEffectGateDecision {
  return decision === InvestigationRolloutDecision.Unavailable
    ? ReviewV2PublicationEffectGateDecision.Unavailable
    : ReviewV2PublicationEffectGateDecision.Disabled;
}

function supportedInvestigationProvider(
  provider: EvidenceProviderKind,
): InvestigationRolloutProvider | null {
  switch (provider) {
    case EvidenceProviderKind.Codex:
      return InvestigationRolloutProvider.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return InvestigationRolloutProvider.Claude;
    case EvidenceProviderKind.OpenRouter:
    case EvidenceProviderKind.Unknown:
      return null;
  }
}
