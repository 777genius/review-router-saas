import type { Clock } from "@reviewrouter/shared";
import type {
  CodexRotatingGitHubCheckoutTokenIssuerPort,
  CodexRotatingOAuthRepositoryPort,
} from "../ports/codex-rotating-oauth-repository-port.js";

export type IssueCodexRotatingOAuthCheckoutTokenDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly codexRotatingCheckoutTokens: CodexRotatingGitHubCheckoutTokenIssuerPort;
  readonly clock: Clock;
};

export async function issueCodexRotatingOAuthCheckoutToken(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
  },
  dependencies: IssueCodexRotatingOAuthCheckoutTokenDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: string;
  readonly permissions: {
    readonly contents: "read";
    readonly pullRequests: "read";
  };
}> {
  const target =
    await dependencies.codexRotatingOAuth.findCompletedLeaseWriteTarget({
      leaseId: input.leaseId,
      providerInstanceId: input.providerInstanceId,
      now: dependencies.clock.now(),
    });
  if (target.status !== "ready") {
    throw new Error(`codex_rotating_${target.status}`);
  }

  const issued =
    await dependencies.codexRotatingCheckoutTokens.issueContentsReadToken(
      target.writeTarget,
    );
  return {
    protocolVersion: 1,
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    repository: target.writeTarget.repositoryFullName,
    permissions: issued.permissions,
  };
}
