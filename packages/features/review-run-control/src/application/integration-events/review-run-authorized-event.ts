import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";

export const reviewRunAuthorizedEventType = "review.run.authorized";
export const reviewRunAuthorizedEventVersion = 1;

export type ReviewRunAuthorizedIntegrationEvent = {
  readonly type: typeof reviewRunAuthorizedEventType;
  readonly version: typeof reviewRunAuthorizedEventVersion;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly aggregateId: string;
  readonly payload: {
    readonly authorizationId: string;
    readonly authorizationVersion: number;
    readonly scmRepositoryIdentityId: string;
    readonly pullRequestNumber: number;
    readonly reviewRevisionHash: string;
    readonly producerReleaseId: string;
    readonly mutationEpoch: string;
    readonly protocolOfferHash: string;
    readonly authorizationSafetyDecisionHash: string;
  };
  readonly occurredAt: Date;
};

export function reviewRunAuthorizedEvent(
  authorization: Omit<ReviewRunAuthorization, "version">,
): ReviewRunAuthorizedIntegrationEvent {
  // Creation always admits version 1. Renewal/termination changes the current
  // row version, never the original event's key, payload or creation time.
  const creationAuthorizationVersion = 1;
  return {
    type: reviewRunAuthorizedEventType,
    version: reviewRunAuthorizedEventVersion,
    idempotencyKey: `${reviewRunAuthorizedEventType}:v${reviewRunAuthorizedEventVersion}:${authorization.authorizationId}:${creationAuthorizationVersion}`,
    workspaceId: authorization.workspaceId,
    repositoryId: authorization.repositoryConnectionId,
    aggregateId: authorization.authorizationId,
    payload: {
      authorizationId: authorization.authorizationId,
      authorizationVersion: creationAuthorizationVersion,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      reviewRevisionHash: authorization.reviewRevisionHash,
      producerReleaseId: authorization.producerReleaseId,
      mutationEpoch: authorization.mutationEpoch.toString(10),
      protocolOfferHash: authorization.protocolOfferHash,
      authorizationSafetyDecisionHash:
        authorization.authorizationSafetyDecisionHash,
    },
    occurredAt: new Date(authorization.createdAt),
  };
}
