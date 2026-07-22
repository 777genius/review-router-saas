import type {
  ReviewRunAuthorization,
  ReviewRunAuthorizationCandidate,
} from "../../domain/review-run-authorization";
import type {
  ReviewSafetyPolicySnapshot,
  ReviewSafetyResolutionTarget,
} from "../../domain/review-safety-policy";
import type { ProducerRelease } from "../../domain/producer-release";
import type { ReviewRunAuthorizationState } from "../../domain/review-run-control-types";

export enum ReviewRunAuthorizationCreateStatus {
  Created = "created",
  Restored = "restored",
  ReplayConflict = "replay_conflict",
  RunAttemptConflict = "run_attempt_conflict",
  IdentifierConflict = "identifier_conflict",
  EligibilityChanged = "eligibility_changed",
}

export type ReviewRunAuthorizationAdmissionFence = {
  readonly repositoryIdentityVersion: number;
  readonly mutationAuthorityVersion: number;
  readonly producerRelease: ProducerRelease;
  readonly protocolLimitsDigest: string;
  readonly operationalSloDigest: string;
  readonly safetySnapshot: ReviewSafetyPolicySnapshot;
  readonly safetyTarget: ReviewSafetyResolutionTarget;
};

export enum ReviewRunAuthorizationRenewStatus {
  Renewed = "renewed",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
  Terminal = "terminal",
}

export enum ReviewRunAuthorizationTerminateStatus {
  Terminated = "terminated",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
}

export interface ReviewRunAuthorizationQueryPort {
  findReviewRunAuthorizationById(
    authorizationId: string,
  ): Promise<ReviewRunAuthorization | null>;
}

export interface ReviewRunAuthorizationCommandPort {
  createOrRestoreReviewRunAuthorization(
    candidate: ReviewRunAuthorizationCandidate,
  ): Promise<{
    readonly status: ReviewRunAuthorizationCreateStatus;
    readonly authorization?: ReviewRunAuthorization | undefined;
  }>;
  renewReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly renewalReplayKeyHash: string;
    readonly renewalProofHash: string;
    readonly renewedAt: Date;
    readonly expiresAt: Date;
  }): Promise<{
    readonly status: ReviewRunAuthorizationRenewStatus;
    readonly authorization?: ReviewRunAuthorization | undefined;
  }>;
  terminateReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly state:
      | ReviewRunAuthorizationState.Expired
      | ReviewRunAuthorizationState.Revoked;
    readonly at: Date;
  }): Promise<{
    readonly status: ReviewRunAuthorizationTerminateStatus;
    readonly authorization?: ReviewRunAuthorization | undefined;
  }>;
}

export interface ReviewRunAuthorizationAdmissionCommandPort {
  createOrRestoreReviewRunAuthorizationAtomically(input: {
    readonly candidate: ReviewRunAuthorizationCandidate;
    readonly fence: ReviewRunAuthorizationAdmissionFence;
  }): Promise<{
    readonly status: ReviewRunAuthorizationCreateStatus;
    readonly authorization?: ReviewRunAuthorization | undefined;
  }>;
}
