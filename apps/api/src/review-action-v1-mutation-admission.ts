import type {
  LegacyReviewMutationAdmissionPort,
  LegacyReviewMutationOperation,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
  type ReviewMutationAuthorityQueryPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";

export class ReviewRunControlLegacyMutationAdmission implements LegacyReviewMutationAdmissionPort {
  constructor(
    private readonly dependencies: {
      readonly repositoryIdentities: ScmRepositoryIdentityQueryPort;
      readonly mutationAuthorities: ReviewMutationAuthorityQueryPort;
    },
  ) {}

  async assertLegacyReviewMutationAllowed(input: {
    readonly operation: LegacyReviewMutationOperation;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<void> {
    const identity =
      await this.dependencies.repositoryIdentities.findScmRepositoryIdentityByExternalIdentity(
        {
          provider: ScmProvider.GitHub,
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: input.githubRepositoryId,
        },
      );
    if (!identity) return;

    const authority =
      await this.dependencies.mutationAuthorities.findReviewMutationAuthority({
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      });
    if (!authority || authority.mode === ReviewMutationMode.V1Open) return;

    throw new Error(`legacy_review_mutation_blocked:${authority.mode}`);
  }
}
