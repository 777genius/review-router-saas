import {
  actionReviewThreadLifecycleResolveRequestSchema,
  actionReviewThreadLifecycleResolveResponseSchema,
  validateActionSessionAgainstRepository,
  type ActionReviewThreadLifecycleResolveRequest,
  type ActionReviewThreadLifecycleResolveResponse,
} from "../../domain/action-control-plane.js";
import type { Clock } from "@reviewrouter/shared";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";
import type { GitHubReviewThreadLifecycleResolverPort } from "../ports/github-review-thread-lifecycle-resolver-port.js";

export type ResolveActionReviewThreadLifecycleDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly reviewThreadLifecycleResolver: GitHubReviewThreadLifecycleResolverPort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
};

export async function resolveActionReviewThreadLifecycle(
  input: {
    readonly sessionToken: string;
    readonly request: ActionReviewThreadLifecycleResolveRequest;
  },
  dependencies: ResolveActionReviewThreadLifecycleDependencies,
): Promise<ActionReviewThreadLifecycleResolveResponse> {
  const request = actionReviewThreadLifecycleResolveRequestSchema.parse(
    input.request,
  );
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
  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: session.workspaceId,
    repositoryId: session.repositoryId,
    repositoryFullName: session.repository,
  });

  const result =
    await dependencies.reviewThreadLifecycleResolver.resolveReviewThreadLifecycle(
      {
        repository,
        request,
        now: dependencies.clock.now(),
      },
    );

  return actionReviewThreadLifecycleResolveResponseSchema.parse(result);
}
