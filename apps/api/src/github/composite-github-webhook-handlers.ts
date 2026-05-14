import type {
  GitHubPullRequestWebhookEnvelope,
  GitHubPullRequestWebhookHandlerPort,
  GitHubPushWebhookEnvelope,
  GitHubPushWebhookHandlerPort,
} from "@reviewrouter/features-github-installations";

export class CompositePullRequestWebhookHandler implements GitHubPullRequestWebhookHandlerPort {
  constructor(
    private readonly handlers: readonly GitHubPullRequestWebhookHandlerPort[],
  ) {}

  async handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    for (const handler of this.handlers) {
      results.push(await handler.handleGitHubPullRequestWebhook(envelope));
    }
    return { processed: true, handlers: results };
  }
}

export class CompositePushWebhookHandler implements GitHubPushWebhookHandlerPort {
  constructor(
    private readonly handlers: readonly GitHubPushWebhookHandlerPort[],
  ) {}

  async handleGitHubPushWebhook(
    envelope: GitHubPushWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    for (const handler of this.handlers) {
      results.push(await handler.handleGitHubPushWebhook(envelope));
    }
    return { processed: true, handlers: results };
  }
}
