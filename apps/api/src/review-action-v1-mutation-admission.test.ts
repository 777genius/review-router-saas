import { describe, expect, it } from "vitest";
import { LegacyReviewMutationOperation } from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
  type ReviewMutationAuthority,
  type ScmRepositoryIdentity,
} from "@reviewrouter/features-review-run-control";
import { ReviewRunControlLegacyMutationAdmission } from "./review-action-v1-mutation-admission";

describe("ReviewRunControlLegacyMutationAdmission", () => {
  it.each([
    ReviewMutationMode.V1Draining,
    ReviewMutationMode.V2Active,
    ReviewMutationMode.Paused,
  ])("blocks new legacy mutation capability in %s", async (mode) => {
    const admission = createAdmission(mode);

    await expect(
      admission.assertLegacyReviewMutationAllowed({
        operation: LegacyReviewMutationOperation.CommentToken,
        githubRepositoryId: "123",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow(`legacy_review_mutation_blocked:${mode}`);
  });

  it("allows legacy mutation before an authority exists and while v1 is open", async () => {
    await expect(
      createAdmission(null).assertLegacyReviewMutationAllowed({
        operation: LegacyReviewMutationOperation.SessionExchange,
        githubRepositoryId: "123",
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toBeUndefined();
    await expect(
      createAdmission(
        ReviewMutationMode.V1Open,
      ).assertLegacyReviewMutationAllowed({
        operation: LegacyReviewMutationOperation.SessionExchange,
        githubRepositoryId: "123",
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toBeUndefined();
  });
});

function createAdmission(mode: ReviewMutationMode | null) {
  const identity: ScmRepositoryIdentity = {
    scmRepositoryIdentityId: "identity-1",
    provider: ScmProvider.GitHub,
    normalizedSourceBaseUrl: "https://github.com",
    externalRepositoryId: "123",
    version: 1,
    currentWorkspaceId: "workspace-1",
    currentRepositoryConnectionId: "repository-1",
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    boundAt: new Date("2026-07-22T00:00:00.000Z"),
    unboundAt: null,
  };
  const authority: ReviewMutationAuthority | null = mode
    ? {
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
        mode,
        epoch: 1n,
        version: 1,
        drainPolicyVersion: null,
        activationSafetyDecisionHash: null,
        drainStartedAt: null,
        v1AdmissionClosedAt: null,
        drainNotBefore: null,
        managedWorkflowInventoryHash: null,
        initializedAt: new Date("2026-07-22T00:00:00.000Z"),
        activatedAt: null,
        pausedAt: null,
      }
    : null;
  return new ReviewRunControlLegacyMutationAdmission({
    repositoryIdentities: {
      findScmRepositoryIdentityById: async () => identity,
      findScmRepositoryIdentityByExternalIdentity: async () => identity,
    },
    mutationAuthorities: {
      findReviewMutationAuthority: async () => authority,
    },
  });
}
