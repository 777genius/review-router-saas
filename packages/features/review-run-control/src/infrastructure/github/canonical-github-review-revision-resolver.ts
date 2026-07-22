import type { Sha256DigestPort } from "../../application/ports/platform-ports";
import {
  CanonicalReviewRevisionResolutionStatus,
  ReviewScmMergeBaseStatus,
  type CanonicalReviewRevisionResolverPort,
  type GitHubReviewRevisionSourcePort,
  type ReviewScmPullRequestPointer,
} from "../../application/ports/review-scm-revision-ports";
import { canonicalJson } from "../../domain/review-run-control-types";

export class CanonicalGitHubReviewRevisionResolver implements CanonicalReviewRevisionResolverPort {
  constructor(
    private readonly source: GitHubReviewRevisionSourcePort,
    private readonly digest: Sha256DigestPort,
  ) {}

  async resolve(
    input: Parameters<CanonicalReviewRevisionResolverPort["resolve"]>[0],
  ): ReturnType<CanonicalReviewRevisionResolverPort["resolve"]> {
    const runPullRequestNumbers = normalizePullRequestNumbers(
      await this.source.findPullRequestNumbersForRun(input),
    );
    const pullRequestNumber = selectPullRequestNumber(
      runPullRequestNumbers,
      input.pullRequestNumberHint,
    );
    if (pullRequestNumber === "conflict") {
      return {
        status: CanonicalReviewRevisionResolutionStatus.PullRequestConflict,
      };
    }
    if (pullRequestNumber === null) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.PullRequestUnavailable,
      };
    }

    const before = await this.source.loadPullRequestPointer({
      ...input,
      pullRequestNumber,
    });
    if (!before || !validPointer(before, pullRequestNumber)) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.PullRequestUnavailable,
      };
    }
    const mergeBase = await this.source.resolveOfficialMergeBase({
      ...input,
      baseSha: before.baseSha,
      headSha: before.headSha,
    });
    if (mergeBase.status === ReviewScmMergeBaseStatus.Unavailable) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.MergeBaseUnavailable,
      };
    }
    if (mergeBase.status === ReviewScmMergeBaseStatus.Conflict) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.MergeBaseConflict,
      };
    }
    if (!isCommitSha(mergeBase.mergeBaseSha)) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.MergeBaseUnavailable,
      };
    }

    const after = await this.source.loadPullRequestPointer({
      ...input,
      pullRequestNumber,
    });
    if (!after || !validPointer(after, pullRequestNumber)) {
      return {
        status: CanonicalReviewRevisionResolutionStatus.PullRequestUnavailable,
      };
    }
    if (!samePointer(before, after)) {
      return { status: CanonicalReviewRevisionResolutionStatus.RevisionMoved };
    }

    const baseSha = before.baseSha.toLowerCase();
    const headSha = before.headSha.toLowerCase();
    const mergeBaseSha = mergeBase.mergeBaseSha.toLowerCase();
    return {
      status: CanonicalReviewRevisionResolutionStatus.Resolved,
      pullRequestNumber,
      baseSha,
      mergeBaseSha,
      headSha,
      reviewRevisionHash: await this.digest.digestUtf8(
        canonicalJson({
          workspaceId: input.workspaceId,
          repositoryConnectionId: input.repositoryConnectionId,
          scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          pullRequestNumber,
          baseSha,
          mergeBaseSha,
          headSha,
        }),
      ),
    };
  }
}

function normalizePullRequestNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].filter(isPullRequestNumber).sort((a, b) => a - b);
}

function selectPullRequestNumber(
  runValues: readonly number[],
  hint: number | null,
): number | null | "conflict" {
  if (hint !== null && !isPullRequestNumber(hint)) return "conflict";
  if (runValues.length > 1) return "conflict";
  if (runValues.length === 1) {
    return hint === null || hint === runValues[0] ? runValues[0]! : "conflict";
  }
  return hint;
}

function validPointer(
  value: ReviewScmPullRequestPointer,
  expectedNumber: number,
): boolean {
  return (
    value.pullRequestNumber === expectedNumber &&
    isCommitSha(value.baseSha) &&
    isCommitSha(value.headSha)
  );
}

function samePointer(
  left: ReviewScmPullRequestPointer,
  right: ReviewScmPullRequestPointer,
): boolean {
  return (
    left.pullRequestNumber === right.pullRequestNumber &&
    left.baseSha.toLowerCase() === right.baseSha.toLowerCase() &&
    left.headSha.toLowerCase() === right.headSha.toLowerCase()
  );
}

function isPullRequestNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}
