import type { GitHubPullRequestWebhookEnvelope } from "@reviewrouter/features-github-installations";
import type { PrismaClient } from "@reviewrouter/platform-db";

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
    const result = await this.prisma.$transaction(async (tx) => {
      const provisioning = await tx.workflowProvisioning.findFirst({
        where: {
          repositoryId: repository.id,
          status: "setup_pr_open",
          OR: [
            { branch: setupBranch },
            { pullRequestUrl: { endsWith: `/pull/${pullRequestNumber}` } },
          ],
        },
        select: { id: true },
      });

      if (!provisioning) {
        return { matched: false };
      }

      await tx.workflowProvisioning.update({
        where: { id: provisioning.id },
        data: {
          status: "configured",
          errorMessage: null,
        },
      });
      await tx.repositoryConnection.update({
        where: { id: repository.id },
        data: { setupStatus: "configured" },
      });

      return { matched: true };
    });

    return result.matched
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
