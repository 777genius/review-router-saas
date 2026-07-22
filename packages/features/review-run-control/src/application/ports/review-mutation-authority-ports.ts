import type { ReviewMutationAuthority } from "../../domain/review-mutation-authority";
import type { ReviewMutationLaneKind } from "../../domain/review-run-control-types";

export enum ReviewMutationAuthorityWriteStatus {
  Created = "created",
  Updated = "updated",
  Restored = "restored",
  Conflict = "conflict",
  Missing = "missing",
}

export interface ReviewMutationAuthorityQueryPort {
  findReviewMutationAuthority(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }): Promise<ReviewMutationAuthority | null>;
}

export interface ReviewMutationAuthorityCommandPort {
  initializeReviewMutationAuthority(
    authority: ReviewMutationAuthority,
  ): Promise<{
    readonly status:
      | ReviewMutationAuthorityWriteStatus.Created
      | ReviewMutationAuthorityWriteStatus.Restored
      | ReviewMutationAuthorityWriteStatus.Conflict;
    readonly authority: ReviewMutationAuthority;
  }>;
  compareAndSetReviewMutationAuthority(input: {
    readonly expectedVersion: number;
    readonly authority: ReviewMutationAuthority;
  }): Promise<
    | {
        readonly status:
          | ReviewMutationAuthorityWriteStatus.Updated
          | ReviewMutationAuthorityWriteStatus.Restored;
        readonly authority: ReviewMutationAuthority;
      }
    | {
        readonly status:
          | ReviewMutationAuthorityWriteStatus.Conflict
          | ReviewMutationAuthorityWriteStatus.Missing;
      }
  >;
}
