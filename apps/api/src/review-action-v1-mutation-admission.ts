import type {
  LegacyReviewMutationAdmissionInput,
  LegacyReviewMutationAdmissionPort,
} from "@reviewrouter/features-action-control-plane";
import {
  isManagedV2SessionBootstrapSource,
  LegacyReviewMutationOperation,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
  type ReviewMutationAuthorityQueryPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";

export interface ManagedV2SessionBootstrapSourceVerifierPort {
  verifyManagedV2SessionBootstrapSource(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
    readonly workflowPath: string;
    readonly workflowSha: string;
  }): Promise<{ readonly compatible: boolean }>;
}

export class ReviewRunControlLegacyMutationAdmission implements LegacyReviewMutationAdmissionPort {
  constructor(
    private readonly dependencies: {
      readonly repositoryIdentities: ScmRepositoryIdentityQueryPort;
      readonly mutationAuthorities: ReviewMutationAuthorityQueryPort;
      readonly workflowSourceVerifier?: ManagedV2SessionBootstrapSourceVerifierPort;
    },
  ) {}

  async assertLegacyReviewMutationAllowed(
    input: LegacyReviewMutationAdmissionInput,
  ): Promise<void> {
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
    if (
      authority.mode !== ReviewMutationMode.Paused &&
      (await this.isVerifiedManagedV2SessionBootstrap(input))
    ) {
      return;
    }

    throw new Error(`legacy_review_mutation_blocked:${authority.mode}`);
  }

  private async isVerifiedManagedV2SessionBootstrap(
    input: LegacyReviewMutationAdmissionInput,
  ): Promise<boolean> {
    if (input.operation !== LegacyReviewMutationOperation.SessionExchange) {
      return false;
    }
    if (
      !isManagedV2SessionBootstrapSource(input) ||
      !input.workflowSha ||
      !this.dependencies.workflowSourceVerifier
    ) {
      return false;
    }
    const verification =
      await this.dependencies.workflowSourceVerifier.verifyManagedV2SessionBootstrapSource(
        {
          githubInstallationId: input.githubInstallationId,
          githubRepositoryId: input.githubRepositoryId,
          repositoryFullName: input.repositoryFullName,
          owner: input.repositoryOwner,
          workflowPath: input.workflowPath,
          workflowSha: input.workflowSha,
        },
      );
    return verification.compatible;
  }
}
