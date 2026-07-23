import {
  GitHubReviewRequestIngressCommandKind,
  GitHubReviewRequestTriggerAction,
  type GitHubPullRequestWebhookEnvelope,
  type GitHubPullRequestWebhookHandlerPort,
} from "@reviewrouter/features-github-installations";

const supportedActions = new Set<string>(
  Object.values(GitHubReviewRequestTriggerAction),
);

export type EnqueueGitHubReviewRequestIngressCommand = Readonly<{
  commandKind: GitHubReviewRequestIngressCommandKind;
  triggerAction: GitHubReviewRequestTriggerAction;
  sourceIdentity: string;
  occurredAt: Date;
  githubInstallationId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  expectedBaseSha?: string;
  expectedHeadSha?: string;
  draftAtIngress?: boolean;
}>;

export interface GitHubReviewRequestIngressPort {
  enqueue(command: EnqueueGitHubReviewRequestIngressCommand): Promise<{
    readonly created: boolean;
    readonly requestId: string | null;
  }>;
}

export class ReviewV2PullRequestWebhookHandler implements GitHubPullRequestWebhookHandlerPort {
  constructor(
    private readonly dependencies: Readonly<{
      ingress: GitHubReviewRequestIngressPort;
      clock: { now(): Date };
      policy: { reviewDrafts(repositoryFullName: string): boolean };
    }>,
  ) {}

  async handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const payload = envelope.payload;
    if (!supportedActions.has(payload.action)) {
      return { reviewV2Intent: "ignored", reason: "action_unsupported" };
    }
    if (payload.action === "edited" && !payload.changes?.base) {
      return {
        reviewV2Intent: "ignored",
        reason: "edit_not_revision_changing",
      };
    }
    const pullRequest = payload.pull_request;
    if (
      pullRequest.user?.type === "Bot" ||
      !pullRequest.head.repo ||
      pullRequest.head.repo.full_name.toLowerCase() !==
        payload.repository.full_name.toLowerCase()
    ) {
      return { reviewV2Intent: "ignored", reason: "trust_domain_unsupported" };
    }
    const reviewDrafts = this.dependencies.policy.reviewDrafts(
      payload.repository.full_name,
    );
    const cancel =
      payload.action === "closed" ||
      pullRequest.state !== "open" ||
      (pullRequest.draft && !reviewDrafts);
    const commandKind = cancel
      ? GitHubReviewRequestIngressCommandKind.Cancel
      : GitHubReviewRequestIngressCommandKind.Request;
    const baseSha = pullRequest.base.sha;
    const headSha = pullRequest.head.sha;
    if (
      commandKind === GitHubReviewRequestIngressCommandKind.Request &&
      (!baseSha || !headSha)
    ) {
      throw new Error("review_v2_webhook_revision_missing");
    }
    const result = await this.dependencies.ingress.enqueue({
      commandKind,
      triggerAction: payload.action as GitHubReviewRequestTriggerAction,
      sourceIdentity: `github-webhook:${envelope.deliveryId}`,
      occurredAt: this.dependencies.clock.now(),
      githubInstallationId: String(payload.installation.id),
      githubRepositoryId: String(payload.repository.id),
      repositoryFullName: payload.repository.full_name,
      pullRequestNumber: pullRequest.number,
      ...(commandKind === GitHubReviewRequestIngressCommandKind.Request
        ? {
            expectedBaseSha: baseSha!,
            expectedHeadSha: headSha!,
            draftAtIngress: pullRequest.draft,
          }
        : {}),
    });
    return {
      reviewV2Intent: result.created ? "queued" : "restored",
      commandKind,
      requestId: result.requestId,
    };
  }
}
