import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  type ReviewObservationQueryPort,
} from "@reviewrouter/features-review-evidence";
import {
  ReviewInvestigationConclusion,
  type InvestigationStorePort,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
} from "@reviewrouter/features-review-investigation-operations";
import {
  reviewProjectionObservationAuthority,
  ReviewProjectionAuthoritySource,
  type ReviewExecutionObservationRef,
  type ReviewProjectionObservationAuthority,
} from "@reviewrouter/features-review-executions";
import type { ReviewRunAuthorization } from "@reviewrouter/features-review-run-control";
import { ReviewActionV2ProtocolErrorCode } from "@reviewrouter/protocol-review-action-v2";
import type { ReviewInvestigationRolloutGuardPort } from "./review-investigation-rollout-guard.js";

export interface ReviewInvestigationFinalizationRolloutGuardPort {
  assertAllowed(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly observationRefs: readonly ReviewExecutionObservationRef[];
    readonly projectionEnvelope: unknown;
  }): Promise<void>;
}

export class ProductionReviewInvestigationFinalizationRolloutGuard implements ReviewInvestigationFinalizationRolloutGuardPort {
  constructor(
    private readonly dependencies: Readonly<{
      observations: Pick<ReviewObservationQueryPort, "findById">;
      investigations: Pick<InvestigationStorePort, "findByCertificateId">;
      rollout: ReviewInvestigationRolloutGuardPort;
    }>,
  ) {}

  async assertAllowed(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly observationRefs: readonly ReviewExecutionObservationRef[];
    readonly projectionEnvelope: unknown;
  }): Promise<void> {
    let authority: ReviewProjectionObservationAuthority;
    try {
      authority = reviewProjectionObservationAuthority(
        input.projectionEnvelope,
      );
    } catch {
      throw unavailable();
    }
    const attachedObservationIds = new Set(
      input.observationRefs.map((reference) => reference.observationId),
    );
    const inspectLegacyCleanAttachments =
      authority.source ===
        ReviewProjectionAuthoritySource.LegacyOccurrenceLineage &&
      authority.observationIds.length === 0;
    const observationIds = inspectLegacyCleanAttachments
      ? [...attachedObservationIds]
      : authority.observationIds;
    for (const observationId of observationIds) {
      if (!attachedObservationIds.has(observationId)) throw unavailable();
      const observation = await this.loadObservation(observationId);
      const hasCertificateId = observation.investigationCertificateId !== null;
      const hasCertificateHash =
        observation.investigationCertificateHash !== null;
      const isInvestigation =
        observation.executionProfile ===
        ProviderExecutionProfile.InvestigationGatewayV1;
      if (
        hasCertificateId !== hasCertificateHash ||
        isInvestigation !== hasCertificateId
      ) {
        throw unavailable();
      }
      if (inspectLegacyCleanAttachments) {
        if (isInvestigation) throw unavailable();
        continue;
      }
      if (!isInvestigation) continue;

      const certificateId = observation.investigationCertificateId;
      if (certificateId === null) throw unavailable();
      const investigation = await this.loadInvestigation(certificateId);
      if (
        !investigation.certificate ||
        investigation.certificate.certificateId !== certificateId ||
        investigation.certificate.certificateHash !==
          observation.investigationCertificateHash ||
        !matchesAuthorization(investigation, observation, input.authorization)
      ) {
        throw unavailable();
      }

      const provider = rolloutProvider(observation.providerKind);
      if (provider === InvestigationRolloutProvider.Unknown)
        throw unavailable();
      const target = {
        workspaceId: input.authorization.workspaceId,
        repositoryConnectionId: input.authorization.repositoryConnectionId,
        scmRepositoryIdentityId: input.authorization.scmRepositoryIdentityId,
        provider,
        trustDomain: input.authorization.trustDomain,
        producerReleaseId: input.authorization.producerReleaseId,
      } as const;
      await this.dependencies.rollout.assertAllowed({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      });
      if (
        investigation.certificate.conclusion ===
        ReviewInvestigationConclusion.VerifiedClean
      ) {
        await this.dependencies.rollout.assertAllowed({
          capability: InvestigationRolloutCapability.VerifiedClean,
          target,
        });
      }
    }
  }

  private async loadObservation(observationId: string) {
    try {
      const observation =
        await this.dependencies.observations.findById(observationId);
      if (observation) return observation;
    } catch {
      // The public failure remains sanitized and fail-closed.
    }
    throw unavailable();
  }

  private async loadInvestigation(certificateId: string) {
    try {
      const investigation =
        await this.dependencies.investigations.findByCertificateId(
          certificateId,
        );
      if (investigation) return investigation;
    } catch {
      // The public failure remains sanitized and fail-closed.
    }
    throw unavailable();
  }
}

function matchesAuthorization(
  investigation: NonNullable<
    Awaited<ReturnType<InvestigationStorePort["findByCertificateId"]>>
  >,
  observation: NonNullable<
    Awaited<ReturnType<ReviewObservationQueryPort["findById"]>>
  >,
  authorization: ReviewRunAuthorization,
): boolean {
  return (
    investigation.scope.workspaceId === authorization.workspaceId &&
    investigation.scope.repositoryConnectionId ===
      authorization.repositoryConnectionId &&
    investigation.scope.scmRepositoryIdentityId ===
      authorization.scmRepositoryIdentityId &&
    investigation.scope.pullRequestNumber === authorization.pullRequestNumber &&
    investigation.scope.trustDomain === authorization.trustDomain &&
    investigation.scope.workspaceId === observation.scope.workspaceId &&
    investigation.scope.repositoryConnectionId ===
      observation.scope.repositoryConnectionId &&
    investigation.scope.scmRepositoryIdentityId ===
      observation.scope.scmRepositoryIdentityId &&
    investigation.scope.pullRequestNumber ===
      observation.scope.pullRequestNumber &&
    investigation.scope.authorizationScopeHash ===
      observation.scope.authorizationScopeHash &&
    investigation.revision.baseSha === authorization.baseSha &&
    investigation.revision.mergeBaseSha === authorization.mergeBaseSha &&
    investigation.revision.headSha === authorization.headSha &&
    investigation.revision.reviewRevisionHash ===
      authorization.reviewRevisionHash &&
    investigation.revision.baseSha === observation.sourceRevision.baseSha &&
    investigation.revision.mergeBaseSha ===
      observation.sourceRevision.mergeBaseSha &&
    investigation.revision.headSha === observation.sourceRevision.headSha &&
    investigation.revision.reviewRevisionHash ===
      observation.sourceRevision.reviewRevisionHash &&
    investigation.certificate?.producerReleaseId ===
      authorization.producerReleaseId &&
    investigation.certificate.producerReleaseId ===
      observation.producerReleaseId &&
    observation.trustDomain === authorization.trustDomain
  );
}

function rolloutProvider(
  provider: ReviewProviderKind,
): InvestigationRolloutProvider {
  switch (provider) {
    case ReviewProviderKind.Codex:
      return InvestigationRolloutProvider.Codex;
    case ReviewProviderKind.ClaudeCode:
      return InvestigationRolloutProvider.Claude;
    case ReviewProviderKind.OpenRouter:
    case ReviewProviderKind.Unknown:
      return InvestigationRolloutProvider.Unknown;
  }
}

function unavailable(): ReviewActionV2RouteFailure {
  return new ReviewActionV2RouteFailure(
    503,
    ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
    ["investigation_rollout_unavailable"],
  );
}
