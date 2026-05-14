import {
  validateActionSessionAgainstRepository,
  type ActionCommentTokenResponse,
} from "../../domain/action-control-plane.js";
import type { Clock } from "@reviewrouter/shared";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";
import type { GitHubAppCommentTokenIssuerPort } from "../ports/github-app-comment-token-issuer-port.js";

export type IssueActionCommentTokenDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly commentTokens: GitHubAppCommentTokenIssuerPort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
};

export async function issueActionCommentToken(
  input: { readonly sessionToken: string },
  dependencies: IssueActionCommentTokenDependencies,
): Promise<ActionCommentTokenResponse> {
  const session = await dependencies.sessions.verify({
    token: input.sessionToken,
    now: dependencies.clock.now(),
  });
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGithubId(
      session.githubRepositoryId,
    );
  if (!repository) {
    throw new Error("repository_not_registered");
  }

  validateActionSessionAgainstRepository({ session, repository });
  if (session.reviewKind === "conflict-head") {
    throw new Error("conflict_review_posting_token_unavailable");
  }
  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: session.workspaceId,
    repositoryId: session.repositoryId,
    repositoryFullName: session.repository,
  });

  const issued = await dependencies.commentTokens.issueCommentToken({
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
  });

  return {
    protocolVersion: 1,
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    repository: issued.repository,
    permissions: issued.permissions,
  };
}
