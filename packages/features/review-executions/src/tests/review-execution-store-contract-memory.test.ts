import { InMemoryReviewExecutionStore } from "../infrastructure/memory/in-memory-review-execution-store";
import { InMemoryReviewRequestedIntentStore } from "../infrastructure/memory/in-memory-review-requested-intent-store";
import { runReviewExecutionStoreContract } from "../testing/review-execution-store-contract";

let sequence = 0;

runReviewExecutionStoreContract("memory", async () => {
  sequence += 1;
  const suffix = `memory-${sequence}`;
  return {
    executions: new InMemoryReviewExecutionStore(),
    requestedIntents: new InMemoryReviewRequestedIntentStore(),
    scope: {
      workspaceId: `workspace-${suffix}`,
      repositoryConnectionId: `repository-${suffix}`,
      scmRepositoryIdentityId: `scm-${suffix}`,
      pullRequestNumber: sequence,
    },
    authorizationId: `authorization-${suffix}`,
    producerReleaseId: `release-${suffix}`,
    ensureObservation: async () => undefined,
  };
});
