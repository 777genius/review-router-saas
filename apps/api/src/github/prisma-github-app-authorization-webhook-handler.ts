import type { GitHubAppAuthorizationWebhookEnvelope } from "@reviewrouter/features-github-installations";
import type { PrismaClient } from "@reviewrouter/platform-db";

export class PrismaGitHubAppAuthorizationWebhookHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async handleGitHubAppAuthorizationWebhook(
    envelope: GitHubAppAuthorizationWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const githubUserId = BigInt(envelope.payload.sender.id);
    const users = await this.prisma.user.findMany({
      where: { githubUserId },
      select: { id: true },
    });
    if (users.length === 0) {
      return {
        processed: false,
        ignored: true,
        reason: "user_not_found",
        githubUserId: githubUserId.toString(),
      };
    }

    const userIds = users.map((user) => user.id);
    const appSlug = resolveGitHubAppSlug();
    await this.prisma.$transaction([
      this.prisma.gitHubUserAuthorization.updateMany({
        where: {
          appSlug,
          userId: { in: userIds },
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          lastErrorCode: "github_app_authorization_revoked",
        },
      }),
      this.prisma.repositoryPermissionCache.deleteMany({
        where: { userId: { in: userIds } },
      }),
    ]);

    return {
      processed: true,
      appSlug,
      githubUserId: githubUserId.toString(),
      userCount: users.length,
    };
  }
}

function resolveGitHubAppSlug(): string {
  return (
    process.env.GITHUB_APP_SLUG?.trim() ||
    process.env.GITHUB_APP_CLIENT_ID?.trim() ||
    "github-app"
  );
}
