import type { Clock } from "@reviewrouter/shared";
import {
  classifyConflictReviewEligibility,
  conflictReviewDispatchEventType,
  conflictReviewFallbackVersion,
  createConflictReviewDispatchIdentity,
  safeConflictReviewErrorSummary,
  type ConflictReviewAttempt,
  type ConflictReviewRepository,
} from "../../domain/conflict-review";
import type { ConflictReviewGitHubGatewayPort } from "../ports/conflict-review-github-gateway-port";
import type { ConflictReviewRepositoryPort } from "../ports/conflict-review-repository-port";
import type { ConflictReviewDetectionRequestPayload } from "./request-conflict-review-detection";

export type ProcessConflictReviewDetectionResult =
  | { readonly status: "ignored"; readonly reason: string }
  | {
      readonly status: "queued";
      readonly pullRequestNumber: number;
      readonly attemptId: string;
    }
  | {
      readonly status: "already_recorded";
      readonly pullRequestNumber: number;
      readonly attemptId: string;
    };

export async function processConflictReviewDetection(
  payload: ConflictReviewDetectionRequestPayload,
  dependencies: {
    readonly repositories: ConflictReviewRepositoryPort;
    readonly github: ConflictReviewGitHubGatewayPort;
    readonly clock: Clock;
  },
): Promise<ProcessConflictReviewDetectionResult> {
  const storedRepository =
    await dependencies.repositories.findRepositoryByGitHubIdentity({
      githubRepositoryId: payload.githubRepositoryId,
      githubInstallationId: payload.githubInstallationId,
    });
  if (!storedRepository) {
    return { status: "ignored", reason: "repository_not_registered" };
  }
  const repository = applyRepositoryFullNameHint(
    storedRepository,
    payload.repositoryFullName,
  );

  if (payload.source === "base_push") {
    return processBasePush(payload, repository, dependencies);
  }

  return processPullRequestNumber(
    {
      repository,
      githubInstallationId: payload.githubInstallationId,
      pullRequestNumber: payload.pullRequestNumber,
    },
    dependencies,
  );
}

function applyRepositoryFullNameHint(
  repository: ConflictReviewRepository,
  fullName: string,
): ConflictReviewRepository {
  const parts = fullName.split("/");
  if (parts.length !== 2) {
    return repository;
  }
  const [owner, name] = parts;
  if (
    !owner ||
    !name ||
    !isSafeRepositoryOwner(owner) ||
    !isSafeRepoName(name)
  ) {
    return repository;
  }
  if (fullName.toLowerCase() === repository.fullName.toLowerCase()) {
    return repository;
  }
  return {
    ...repository,
    owner,
    name,
    fullName,
  };
}

function isSafeRepositoryOwner(owner: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
}

function isSafeRepoName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(name);
}

async function processBasePush(
  payload: Extract<
    ConflictReviewDetectionRequestPayload,
    { readonly source: "base_push" }
  >,
  repository: ConflictReviewRepository,
  dependencies: {
    readonly repositories: ConflictReviewRepositoryPort;
    readonly github: ConflictReviewGitHubGatewayPort;
    readonly clock: Clock;
  },
): Promise<ProcessConflictReviewDetectionResult> {
  const pullRequestNumbers =
    await dependencies.github.listOpenPullRequestNumbersForBase({
      githubInstallationId: payload.githubInstallationId,
      owner: repository.owner,
      repo: repository.name,
      baseRef: payload.baseRef,
    });
  if (pullRequestNumbers.length === 0) {
    return { status: "ignored", reason: "no_open_prs_for_base" };
  }

  let lastResult: ProcessConflictReviewDetectionResult | null = null;
  let retryUnknownMergeability = false;
  for (const pullRequestNumber of pullRequestNumbers) {
    lastResult = await processPullRequestNumber(
      {
        repository,
        githubInstallationId: payload.githubInstallationId,
        pullRequestNumber,
      },
      dependencies,
    );
    if (
      lastResult.status === "ignored" &&
      lastResult.reason === "github_mergeability_unknown"
    ) {
      retryUnknownMergeability = true;
    }
  }

  if (retryUnknownMergeability) {
    return { status: "ignored", reason: "github_mergeability_unknown" };
  }
  return lastResult ?? { status: "ignored", reason: "no_open_prs_for_base" };
}

async function processPullRequestNumber(
  input: {
    readonly repository: ConflictReviewRepository;
    readonly githubInstallationId: string;
    readonly pullRequestNumber: number;
  },
  dependencies: {
    readonly repositories: ConflictReviewRepositoryPort;
    readonly github: ConflictReviewGitHubGatewayPort;
    readonly clock: Clock;
  },
): Promise<ProcessConflictReviewDetectionResult> {
  const repository = input.repository;
  if (!repository.selected) {
    return { status: "ignored", reason: "repository_not_selected" };
  }
  if (repository.installationStatus !== "active") {
    return { status: "ignored", reason: "installation_not_active" };
  }

  const capability = await dependencies.github.getReviewWorkflowCapability({
    githubInstallationId: input.githubInstallationId,
    owner: repository.owner,
    repo: repository.name,
    ref: repository.defaultBranch,
  });
  if (!capability.supported) {
    return {
      status: "ignored",
      reason: "workflow_missing_conflict_capability",
    };
  }

  const pullRequest = await dependencies.github.getPullRequest({
    githubInstallationId: input.githubInstallationId,
    owner: repository.owner,
    repo: repository.name,
    pullRequestNumber: input.pullRequestNumber,
  });
  const eligibility = classifyConflictReviewEligibility({
    repository,
    pullRequest,
  });
  if (!eligibility.eligible) {
    return { status: "ignored", reason: eligibility.reason };
  }

  const dispatch = createConflictReviewDispatchIdentity({
    githubRepositoryId: repository.githubRepositoryId,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
  });

  const created = await dependencies.repositories.tryCreateAttempt({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    githubInstallationId: repository.githubInstallationId,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    fallbackVersion: conflictReviewFallbackVersion,
    dispatchId: dispatch.dispatchId,
    dispatchNonceHash: dispatch.nonceHash,
    dispatchEventType: conflictReviewDispatchEventType,
    createdAt: dependencies.clock.now(),
  });

  if (!created.created) {
    if (
      created.attempt.status === "recorded" ||
      created.attempt.status === "failed"
    ) {
      const refreshed = await dependencies.repositories.refreshAttemptDispatch({
        attemptId: created.attempt.id,
        previousDispatchId: created.attempt.dispatchId,
        dispatchId: dispatch.dispatchId,
        dispatchNonceHash: dispatch.nonceHash,
        dispatchEventType: conflictReviewDispatchEventType,
        refreshedAt: dependencies.clock.now(),
      });
      if (refreshed) {
        await dispatchAttempt(
          {
            repository,
            attempt: refreshed,
            payload: dispatch.payload,
          },
          dependencies,
        );
        return {
          status: "queued",
          pullRequestNumber: pullRequest.number,
          attemptId: refreshed.id,
        };
      }
    }
    return {
      status: "already_recorded",
      pullRequestNumber: pullRequest.number,
      attemptId: created.attempt.id,
    };
  }

  await dispatchAttempt(
    {
      repository,
      attempt: created.attempt,
      payload: dispatch.payload,
    },
    dependencies,
  );

  return {
    status: "queued",
    pullRequestNumber: pullRequest.number,
    attemptId: created.attempt.id,
  };
}

async function dispatchAttempt(
  input: {
    readonly repository: ConflictReviewRepository;
    readonly attempt: ConflictReviewAttempt;
    readonly payload: ReturnType<
      typeof createConflictReviewDispatchIdentity
    >["payload"];
  },
  dependencies: {
    readonly repositories: ConflictReviewRepositoryPort;
    readonly github: ConflictReviewGitHubGatewayPort;
    readonly clock: Clock;
  },
): Promise<void> {
  try {
    await dependencies.github.dispatchConflictReview({
      githubInstallationId: input.repository.githubInstallationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      payload: input.payload,
    });
    await dependencies.repositories.markAttemptDispatched({
      attemptId: input.attempt.id,
      dispatchedAt: dependencies.clock.now(),
    });
  } catch (error) {
    await dependencies.repositories.markAttemptFailed({
      attemptId: input.attempt.id,
      errorCode: "github_dispatch_failed",
      safeErrorSummary: safeConflictReviewErrorSummary(error, [
        input.payload.nonce,
      ]),
      failedAt: dependencies.clock.now(),
    });
    throw error;
  }
}
