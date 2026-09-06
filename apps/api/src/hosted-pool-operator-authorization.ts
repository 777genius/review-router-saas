import {
  HashedReviewConfigurationOperatorAuthorization,
  ReviewConfigurationOperatorOperation,
} from "@reviewrouter/features-review-config";
import type { PrismaClient } from "@reviewrouter/platform-db";

export type HostedPoolOperatorScope = Readonly<{
  operatorId: string;
  workspaceId: string;
  ownerGitHubUserId: string;
}>;

/** Trusted deployment configuration only. Request workspace is a constraint, not a grant. */
export function readHostedPoolOperatorScope(
  env: Readonly<Record<string, string | undefined>>,
): HostedPoolOperatorScope | null {
  if (env.REVIEW_ROUTER_HOSTED_POOL_OPERATOR_ENABLED !== "1") return null;
  const operatorId = "reviewrouter-operator";
  const workspaceId =
    env.REVIEW_ROUTER_HOSTED_POOL_OPERATOR_WORKSPACE_ID?.trim();
  const ownerGitHubUserId =
    env.REVIEW_ROUTER_HOSTED_POOL_OPERATOR_OWNER_GITHUB_USER_ID?.trim();
  if (
    !workspaceId ||
    !ownerGitHubUserId ||
    !/^[1-9]\d*$/.test(ownerGitHubUserId)
  ) {
    throw new Error("hosted_pool_operator_scope_invalid");
  }
  return { operatorId, workspaceId, ownerGitHubUserId };
}

export function createHostedPoolOperatorAuthorization(input: {
  readonly scope: HostedPoolOperatorScope;
  readonly credentialSha256: string;
  readonly membership: {
    isCurrentAdmin(
      scope: HostedPoolOperatorScope,
      workspace: string,
    ): Promise<boolean>;
  };
}) {
  const authorization = new HashedReviewConfigurationOperatorAuthorization(
    input.scope.operatorId,
    input.credentialSha256,
  );
  return async (
    credential: string,
    workspace: string,
  ): Promise<HostedPoolOperatorScope> => {
    const principal = await authorization.authenticate({
      credential,
      operation: ReviewConfigurationOperatorOperation.Read,
    });
    if (!principal || principal.operatorId !== input.scope.operatorId)
      throw new Error("hosted_pool_operator_unauthorized");
    if (!(await input.membership.isCurrentAdmin(input.scope, workspace)))
      throw new Error("hosted_pool_operator_forbidden");
    return input.scope;
  };
}

export function prismaHostedPoolOperatorMembership(prisma: PrismaClient) {
  return {
    async isCurrentAdmin(scope: HostedPoolOperatorScope, workspace: string) {
      const membership = await prisma.workspaceMember.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          workspace: { OR: [{ id: workspace }, { slug: workspace }] },
          user: { githubUserId: BigInt(scope.ownerGitHubUserId) },
          role: { in: ["owner", "admin"] },
        },
        select: { id: true },
      });
      return membership !== null;
    },
  };
}
