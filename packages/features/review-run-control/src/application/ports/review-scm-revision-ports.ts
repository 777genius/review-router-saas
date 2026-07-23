export type ReviewScmPullRequestPointer = {
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
};

export enum ReviewScmMergeBaseStatus {
  Resolved = "resolved",
  Unavailable = "unavailable",
  Conflict = "conflict",
}

export type ReviewScmMergeBaseResult =
  | {
      readonly status: ReviewScmMergeBaseStatus.Resolved;
      readonly mergeBaseSha: string;
    }
  | { readonly status: ReviewScmMergeBaseStatus.Unavailable }
  | { readonly status: ReviewScmMergeBaseStatus.Conflict };

export interface GitHubReviewRevisionSourcePort {
  findPullRequestNumbersForRun(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly sourceRunId: string;
  }): Promise<readonly number[]>;

  loadPullRequestPointer(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewScmPullRequestPointer | null>;

  resolveOfficialMergeBase(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly baseSha: string;
    readonly headSha: string;
  }): Promise<ReviewScmMergeBaseResult>;
}

export enum CanonicalReviewRevisionResolutionStatus {
  Resolved = "resolved",
  PullRequestUnavailable = "pull_request_unavailable",
  PullRequestConflict = "pull_request_conflict",
  MergeBaseUnavailable = "merge_base_unavailable",
  MergeBaseConflict = "merge_base_conflict",
  RevisionMoved = "revision_moved",
}

export type CanonicalReviewRevisionResolution =
  | {
      readonly status: CanonicalReviewRevisionResolutionStatus.Resolved;
      readonly pullRequestNumber: number;
      readonly baseSha: string;
      readonly mergeBaseSha: string;
      readonly headSha: string;
      readonly reviewRevisionHash: string;
    }
  | {
      readonly status: Exclude<
        CanonicalReviewRevisionResolutionStatus,
        CanonicalReviewRevisionResolutionStatus.Resolved
      >;
    };

export interface CanonicalReviewRevisionResolverPort {
  resolve(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly scmRepositoryIdentityId: string;
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly sourceRunId: string | null;
    readonly pullRequestNumberHint: number | null;
  }): Promise<CanonicalReviewRevisionResolution>;
}
