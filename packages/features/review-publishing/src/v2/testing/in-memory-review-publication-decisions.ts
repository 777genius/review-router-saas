import type { ReviewPublicationPermitIdentity } from "../domain/review-publication-attempt";
import {
  CurrentMutationAuthorityStatus,
  CurrentPublicationLifecycleStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  ReviewPublicationRunControlStatus,
  type ReviewPublicationClockPort,
  type ReviewPublicationDecisionPorts,
} from "../application/ports/review-publication-ports";

export class MutableReviewPublicationClock implements ReviewPublicationClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }
}

export function allowingReviewPublicationDecisionPorts(
  permit: ReviewPublicationPermitIdentity,
  overrides: Partial<ReviewPublicationDecisionPorts> = {},
): ReviewPublicationDecisionPorts {
  return {
    permits: {
      async resolve() {
        return {
          status: CurrentPublicationPermitStatus.Current,
          permit,
        };
      },
    },
    runControl: {
      async resolve() {
        return {
          status: ReviewPublicationRunControlStatus.Allowed,
          authorizationId: permit.authorizationId,
          producerReleaseId: permit.producerReleaseId,
        };
      },
    },
    authority: {
      async resolve() {
        return {
          status: CurrentMutationAuthorityStatus.Active,
          mutationEpoch: permit.permitEpoch,
        };
      },
    },
    revision: {
      async resolve() {
        return {
          status: CurrentReviewRevisionStatus.Current,
          reviewedHeadSha: permit.reviewedHeadSha,
          reviewRevisionHash: permit.reviewRevisionHash,
        };
      },
    },
    lifecycle: {
      async resolve() {
        return {
          status: CurrentPublicationLifecycleStatus.Current,
          lifecycleStateHash: permit.lifecycleStateHash,
          commandLedgerWatermark: permit.commandLedgerWatermark,
        };
      },
    },
    safety: {
      async resolve() {
        return {
          status: CurrentReviewSafetyDecisionStatus.Allowed,
          decisionHash: permit.publicationSafetyDecisionHash,
        };
      },
    },
    ...overrides,
  };
}
