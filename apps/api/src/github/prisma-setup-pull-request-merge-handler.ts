import type { GitHubPullRequestWebhookEnvelope } from "@reviewrouter/features-github-installations";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { PrismaWorkflowProvisioningStatusAuthority } from "@reviewrouter/features-workflow-provisioning";

export class PrismaSetupPullRequestMergeHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const payload = envelope.payload;
    if (payload.action !== "closed" || payload.pull_request.merged !== true) {
      return {
        processed: false,
        ignored: true,
        reason: "pull_request_not_merged",
      };
    }

    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        githubRepositoryId: BigInt(payload.repository.id),
        installation: {
          githubInstallationId: BigInt(payload.installation.id),
        },
      },
      select: {
        id: true,
        fullName: true,
      },
    });
    if (!repository) {
      return {
        processed: false,
        ignored: true,
        reason: "repository_not_synced",
      };
    }

    const pullRequestNumber = payload.pull_request.number;
    const setupBranch = payload.pull_request.head.ref;
    const matched = await new PrismaWorkflowProvisioningStatusAuthority(
      this.prisma,
    ).markConfigured({
      repositoryId: repository.id,
      setupBranch,
      pullRequestNumber,
    });

    return matched
      ? {
          processed: true,
          repository: repository.fullName,
          status: "configured",
        }
      : {
          processed: false,
          ignored: true,
          reason: "not_reviewrouter_setup_pr",
          repository: repository.fullName,
        };
  }
}
