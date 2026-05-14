import type {
  ActionRepositoryContext,
  ActionReviewThreadLifecycleResolveRequest,
  ActionReviewThreadLifecycleResolveResponse,
} from "../../domain/action-control-plane.js";

export type ResolveGitHubReviewThreadLifecycleInput = {
  readonly repository: ActionRepositoryContext;
  readonly request: ActionReviewThreadLifecycleResolveRequest;
  readonly now: Date;
};

export interface GitHubReviewThreadLifecycleResolverPort {
  resolveReviewThreadLifecycle(
    input: ResolveGitHubReviewThreadLifecycleInput,
  ): Promise<ActionReviewThreadLifecycleResolveResponse>;
}
