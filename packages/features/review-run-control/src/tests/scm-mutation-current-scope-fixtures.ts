import { createScmRepositoryIdentity } from "../domain/scm-repository-identity";
import { initializeReviewMutationAuthority } from "../domain/review-mutation-authority";
import {
  ReviewMutationMode,
  ScmProvider,
} from "../domain/review-run-control-types";

export const changedAt = new Date("2026-09-08T00:00:00.000Z");
export function identityFixture(id = "scm", externalRepositoryId = "external") {
  return createScmRepositoryIdentity({
    scmRepositoryIdentityId: id,
    provider: ScmProvider.GitHub,
    sourceBaseUrl: "https://github.com",
    externalRepositoryId,
    createdAt: changedAt,
  });
}
export function authorityFixture(id = "scm") {
  return {
    ...initializeReviewMutationAuthority({
      scmRepositoryIdentityId: id,
      initializedAt: changedAt,
    }).authority,
    mode: ReviewMutationMode.V2Active,
    epoch: 1n,
    activatedAt: changedAt,
    managedWorkflowInventoryHash: "a".repeat(64),
    activationSafetyDecisionHash: "b".repeat(64),
  };
}
