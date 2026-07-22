import type { ReviewPublicationPermitIdentity } from "../../domain/review-publication-attempt";
import {
  CurrentMutationAuthorityStatus,
  CurrentPublicationLifecycleStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  ReviewPublicationCapability,
  ReviewPublicationGateRejectedError,
  ReviewPublicationGateRejectionReason,
  ReviewPublicationRunControlStatus,
  type ReviewPublicationDecisionPorts,
} from "../ports/review-publication-ports";

export async function assertCurrentReviewPublication(input: {
  readonly permit: ReviewPublicationPermitIdentity;
  readonly capability: ReviewPublicationCapability;
  readonly now: Date;
  readonly decisions: ReviewPublicationDecisionPorts;
}): Promise<void> {
  if (input.now >= input.permit.publicationNotAfter) {
    reject(ReviewPublicationGateRejectionReason.PublicationExpired);
  }

  const scope = publicationScope(input.permit);
  const [permit, runControl, authority, revision, lifecycle, safety] =
    await Promise.all([
      input.decisions.permits.resolve({
        executionId: input.permit.executionId,
        generation: input.permit.generation,
        projectionHash: input.permit.projectionHash,
      }),
      input.decisions.runControl.resolve({
        authorizationId: input.permit.authorizationId,
        producerReleaseId: input.permit.producerReleaseId,
      }),
      input.decisions.authority.resolve(scope),
      input.decisions.revision.resolve(scope),
      input.decisions.lifecycle.resolve(scope),
      input.decisions.safety.resolve({
        scope,
        capability: input.capability,
      }),
    ]);

  if (permit.status !== CurrentPublicationPermitStatus.Current) {
    reject(ReviewPublicationGateRejectionReason.PermitNotCurrent);
  }
  if (!samePermit(permit.permit, input.permit)) {
    reject(ReviewPublicationGateRejectionReason.PermitMismatch);
  }
  if (
    runControl.status !== ReviewPublicationRunControlStatus.Allowed ||
    runControl.authorizationId !== input.permit.authorizationId ||
    runControl.producerReleaseId !== input.permit.producerReleaseId
  ) {
    reject(ReviewPublicationGateRejectionReason.RunControlDenied);
  }
  if (authority.status !== CurrentMutationAuthorityStatus.Active) {
    reject(ReviewPublicationGateRejectionReason.MutationAuthorityNotActive);
  }
  if (authority.mutationEpoch !== input.permit.permitEpoch) {
    reject(ReviewPublicationGateRejectionReason.MutationEpochMismatch);
  }
  if (
    revision.status !== CurrentReviewRevisionStatus.Current ||
    revision.reviewedHeadSha !== input.permit.reviewedHeadSha ||
    revision.reviewRevisionHash !== input.permit.reviewRevisionHash
  ) {
    reject(ReviewPublicationGateRejectionReason.RevisionNotCurrent);
  }
  if (
    lifecycle.status !== CurrentPublicationLifecycleStatus.Current ||
    lifecycle.lifecycleStateHash !== input.permit.lifecycleStateHash ||
    lifecycle.commandLedgerWatermark !== input.permit.commandLedgerWatermark
  ) {
    reject(ReviewPublicationGateRejectionReason.LifecycleNotCurrent);
  }
  if (safety.status !== CurrentReviewSafetyDecisionStatus.Allowed) {
    reject(ReviewPublicationGateRejectionReason.SafetyDenied);
  }
  if (safety.decisionHash !== input.permit.publicationSafetyDecisionHash) {
    reject(ReviewPublicationGateRejectionReason.SafetyDecisionMismatch);
  }
}

function publicationScope(permit: ReviewPublicationPermitIdentity) {
  return {
    workspaceId: permit.workspaceId,
    repositoryConnectionId: permit.repositoryConnectionId,
    scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
    pullRequestNumber: permit.pullRequestNumber,
  };
}

function samePermit(
  left: ReviewPublicationPermitIdentity,
  right: ReviewPublicationPermitIdentity,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryConnectionId === right.repositoryConnectionId &&
    left.scmRepositoryIdentityId === right.scmRepositoryIdentityId &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.executionId === right.executionId &&
    left.generation === right.generation &&
    left.authorizationId === right.authorizationId &&
    left.producerReleaseId === right.producerReleaseId &&
    left.reviewedHeadSha === right.reviewedHeadSha &&
    left.reviewRevisionHash === right.reviewRevisionHash &&
    left.projectionHash === right.projectionHash &&
    left.lifecycleStateHash === right.lifecycleStateHash &&
    left.commandLedgerWatermark === right.commandLedgerWatermark &&
    left.permitEpoch === right.permitEpoch &&
    left.publicationSafetyDecisionHash ===
      right.publicationSafetyDecisionHash &&
    left.publicationNotAfter.getTime() === right.publicationNotAfter.getTime()
  );
}

function reject(reason: ReviewPublicationGateRejectionReason): never {
  throw new ReviewPublicationGateRejectedError(reason);
}
