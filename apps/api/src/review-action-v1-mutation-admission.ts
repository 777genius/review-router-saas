import type {
  LegacyReviewMutationAdmissionInput,
  LegacyReviewMutationAdmissionPort,
} from "@reviewrouter/features-action-control-plane";
import {
  LegacyReviewMutationOperation,
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
  type ReviewMutationAuthorityQueryPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";

export interface ManagedV2SessionBootstrapInventoryPort {
  inspectReviewV2ManagedWorkflowInventory(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
  }): Promise<{
    readonly compatible: boolean;
    readonly defaultBranchHeadSha: string;
  }>;
}

export class ReviewRunControlLegacyMutationAdmission implements LegacyReviewMutationAdmissionPort {
  constructor(
    private readonly dependencies: {
      readonly repositoryIdentities: ScmRepositoryIdentityQueryPort;
      readonly mutationAuthorities: ReviewMutationAuthorityQueryPort;
      readonly workflowInventory?: ManagedV2SessionBootstrapInventoryPort;
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
      !isManagedV2SessionBootstrap(input) ||
      !input.workflowSha ||
      !this.dependencies.workflowInventory
    ) {
      return false;
    }
    const inventory =
      await this.dependencies.workflowInventory.inspectReviewV2ManagedWorkflowInventory(
        {
          githubInstallationId: input.githubInstallationId,
          githubRepositoryId: input.githubRepositoryId,
          repositoryFullName: input.repositoryFullName,
          owner: input.repositoryOwner,
        },
      );
    return (
      inventory.compatible &&
      inventory.defaultBranchHeadSha.toLowerCase() ===
        input.workflowSha.toLowerCase()
    );
  }
}

function isManagedV2SessionBootstrap(
  input: LegacyReviewMutationAdmissionInput,
): boolean {
  if (input.operation !== LegacyReviewMutationOperation.SessionExchange) {
    return false;
  }
  if (
    input.workflowPath === managedCodexWorkflowPath &&
    input.eventName === "workflow_dispatch"
  ) {
    return true;
  }
  return (
    input.workflowPath === managedInteractionWorkflowPath &&
    (input.eventName === "issue_comment" ||
      input.eventName === "pull_request_review_comment" ||
      input.eventName === "workflow_dispatch")
  );
}
