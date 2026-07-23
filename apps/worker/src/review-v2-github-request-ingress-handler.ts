import type { ActionControlPlaneRepositoryPort } from "@reviewrouter/features-action-control-plane";
import {
  GitHubReviewRequestIngressCommandKind,
  GitHubReviewRequestTriggerAction,
  githubReviewRequestIngressEventType,
  githubReviewRequestIngressEventVersion,
  parseGitHubReviewRequestIngressPayload,
} from "@reviewrouter/features-github-installations";
import {
  ReviewRequestIngressCommandKind,
  ReviewRequestedTriggerKind,
  parseReviewRequestIngressPayload,
  type ReviewRequestIngressPayload,
} from "@reviewrouter/features-review-executions";
import {
  ScmProvider,
  normalizeScmSourceBaseUrl,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";
import {
  OutboxHandlerError,
  type OutboxEvent,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  ReviewRequestIngressApplicationService,
  retryableReviewRequestIngressError,
} from "./review-v2-request-ingress-handler";

export function createGitHubReviewRequestIngressHandler(dependencies: {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly identities: ScmRepositoryIdentityQueryPort;
  readonly application: ReviewRequestIngressApplicationService;
  readonly readyQuietPeriodMs: number;
  readonly draftQuietPeriodMs: number;
  readonly retentionMs: number;
}): OutboxHandler {
  return {
    type: githubReviewRequestIngressEventType,
    version: githubReviewRequestIngressEventVersion,
    async handle(event: OutboxEvent) {
      const external = parseGitHubReviewRequestIngressPayload(event.payload);
      assertExternalEnvelope(event);
      const repository =
        await dependencies.repositories.findSelectedRepositoryByGithubId(
          external.githubRepositoryId,
        );
      if (!repository) {
        throw retryableReviewRequestIngressError(
          "review_request_repository_projection_unavailable",
        );
      }
      if (
        !repository.selected ||
        repository.installationStatus !== "active" ||
        repository.githubInstallationId !== external.githubInstallationId ||
        repository.fullName.toLowerCase() !==
          external.repositoryFullName.toLowerCase()
      ) {
        return;
      }
      const identity =
        await dependencies.identities.findScmRepositoryIdentityByExternalIdentity(
          {
            provider: ScmProvider.GitHub,
            normalizedSourceBaseUrl:
              normalizeScmSourceBaseUrl("https://github.com"),
            externalRepositoryId: repository.githubRepositoryId,
          },
        );
      if (
        !identity ||
        identity.currentWorkspaceId !== repository.workspaceId ||
        identity.currentRepositoryConnectionId !== repository.repositoryId
      ) {
        throw retryableReviewRequestIngressError(
          "review_request_identity_projection_unavailable",
        );
      }
      const base = {
        protocolVersion: 1 as const,
        workspaceId: repository.workspaceId,
        repositoryConnectionId: repository.repositoryId,
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        pullRequestNumber: external.pullRequestNumber,
        githubInstallationId: repository.githubInstallationId,
        repositoryFullName: repository.fullName,
        deliveryIdentityHash: external.deliveryIdentityHash,
      };
      const payload: ReviewRequestIngressPayload =
        external.commandKind === GitHubReviewRequestIngressCommandKind.Cancel
          ? {
              ...base,
              commandKind: ReviewRequestIngressCommandKind.Cancel,
            }
          : {
              ...base,
              commandKind: ReviewRequestIngressCommandKind.Request,
              requestId: `review-request-${external.deliveryIdentityHash}`,
              triggerKind: triggerKind(external.triggerAction),
              expectedBaseSha: external.expectedBaseSha,
              expectedHeadSha: external.expectedHeadSha,
              quietPeriodMs: external.draftAtIngress
                ? dependencies.draftQuietPeriodMs
                : dependencies.readyQuietPeriodMs,
              retentionMs: dependencies.retentionMs,
            };
      await dependencies.application.execute({
        payload: parseReviewRequestIngressPayload(payload),
        occurredAt: event.occurredAt,
      });
    },
  };
}

function triggerKind(
  action: GitHubReviewRequestTriggerAction,
): ReviewRequestedTriggerKind {
  if (action === GitHubReviewRequestTriggerAction.Synchronize) {
    return ReviewRequestedTriggerKind.PullRequestSynchronized;
  }
  if (action === GitHubReviewRequestTriggerAction.ReadyForReview) {
    return ReviewRequestedTriggerKind.PullRequestReadyForReview;
  }
  return ReviewRequestedTriggerKind.LifecycleChanged;
}

function assertExternalEnvelope(event: OutboxEvent): void {
  if (
    event.type !== githubReviewRequestIngressEventType ||
    event.version !== githubReviewRequestIngressEventVersion ||
    event.workspaceId !== null ||
    event.repositoryId !== null
  ) {
    throw new OutboxHandlerError(
      "GitHub review request ingress envelope is invalid",
      "github_review_request_ingress_envelope_invalid",
      false,
    );
  }
}
