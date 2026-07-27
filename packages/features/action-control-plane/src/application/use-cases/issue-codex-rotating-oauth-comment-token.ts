import type { Clock } from "@reviewrouter/shared";
import type { GitHubAppCommentTokenIssuerPort } from "../ports/github-app-comment-token-issuer-port.js";
import type { CodexRotatingOAuthRepositoryPort } from "../ports/codex-rotating-oauth-repository-port.js";
import {
  LegacyReviewMutationOperation,
  type LegacyReviewMutationAdmissionPort,
} from "../ports/legacy-review-mutation-admission-port.js";

export type IssueCodexRotatingOAuthCommentTokenDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly commentTokens: GitHubAppCommentTokenIssuerPort;
  readonly legacyMutationAdmission?: LegacyReviewMutationAdmissionPort;
  readonly clock: Clock;
};

export async function issueCodexRotatingOAuthCommentToken(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly authCleared: true;
  },
  dependencies: IssueCodexRotatingOAuthCommentTokenDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: string;
  readonly permissions: {
    readonly contents: "read";
    readonly pullRequests: "write";
    readonly issues: "write";
    readonly statuses: "write";
  };
}> {
  if (input.authCleared !== true) {
    throw new Error("codex_rotating_auth_clear_required");
  }
  const target =
    await dependencies.codexRotatingOAuth.findCompletedLeaseWriteTarget({
      leaseId: input.leaseId,
      providerInstanceId: input.providerInstanceId,
      now: dependencies.clock.now(),
    });
  if (target.status !== "ready") {
    throw new Error(`codex_rotating_${target.status}`);
  }
  await dependencies.legacyMutationAdmission?.assertLegacyReviewMutationAllowed(
    {
      operation: LegacyReviewMutationOperation.CodexRotatingCommentToken,
      githubRepositoryId: target.writeTarget.githubRepositoryId,
      repositoryFullName: target.writeTarget.repositoryFullName,
    },
  );

  const issued = await dependencies.commentTokens.issueCommentToken(
    target.writeTarget,
  );
  return {
    protocolVersion: 1,
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    repository: issued.repository,
    permissions: issued.permissions,
  };
}
