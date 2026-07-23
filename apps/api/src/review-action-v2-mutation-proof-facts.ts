import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ActionControlPlaneRepositoryPort } from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewSafetyDecisionKind,
  type ReviewMutationAuthorityProofFactsQueryPorts,
  type ReviewMutationAuthorityQueryPort,
  type ReviewSafetyDecisionResolverPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";

const factsVersion = "review-mutation-authority-production-facts-v2";

export interface ManagedReviewWorkflowInventoryInspectionPort {
  inspectReviewV2ManagedWorkflowInventory(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
  }): Promise<{
    readonly compatible: boolean;
    readonly inventoryHash: string;
    readonly actionCommitSha: string | null;
  }>;
}

export class ProductionReviewMutationAuthorityProofFacts implements ReviewMutationAuthorityProofFactsQueryPorts {
  constructor(
    private readonly dependencies: {
      readonly prisma: PrismaClient;
      readonly identities: ScmRepositoryIdentityQueryPort;
      readonly authorities: ReviewMutationAuthorityQueryPort;
      readonly actionRepositories: ActionControlPlaneRepositoryPort;
      readonly safety: ReviewSafetyDecisionResolverPort;
      readonly workflowInventory: ManagedReviewWorkflowInventoryInspectionPort;
      readonly completionWorkerConfigured: boolean;
      readonly now: () => Date;
    },
  ) {}

  async inspectActivationFacts(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }) {
    const target = await this.resolveTarget(input.scmRepositoryIdentityId);
    const [authority, inventory, safety] = await Promise.all([
      this.dependencies.authorities.findReviewMutationAuthority(input),
      this.dependencies.workflowInventory.inspectReviewV2ManagedWorkflowInventory(
        {
          githubInstallationId: target.repository.githubInstallationId,
          githubRepositoryId: target.repository.githubRepositoryId,
          repositoryFullName: target.repository.fullName,
          owner: target.repository.owner,
        },
      ),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.MutationEpochActivation,
        target: target.safetyTarget,
      }),
    ]);
    const now = this.dependencies.now();
    const registeredReleaseSelected = inventory.actionCommitSha
      ? (await this.dependencies.prisma.producerRelease.count({
          where: {
            actionCommitSha: inventory.actionCommitSha,
            state: "registered",
          },
        })) > 0
      : false;
    const noTrackedLegacyActivity = Boolean(
      authority?.mode === ReviewMutationMode.V1Draining &&
      authority.v1AdmissionClosedAt &&
      authority.drainNotBefore &&
      authority.v1AdmissionClosedAt <= authority.drainNotBefore &&
      authority.drainNotBefore <= now,
    );
    return {
      factsVersion,
      facts: {
        noTrackedLegacyActivity,
        workflowInventoryCompatible: inventory.compatible,
        registeredReleaseSelected,
        completionWorkerConfigured:
          this.dependencies.completionWorkerConfigured,
        managedWorkflowInventoryHash: inventory.inventoryHash,
        safetyDecisionEnabled: safety.effectAllowed,
        activationSafetyDecisionHash: safety.safetyDecisionHash,
      },
    } as const;
  }

  async inspectAbortDrainFacts(input: {
    readonly scmRepositoryIdentityId: string;
  }) {
    const authorizationCount =
      await this.dependencies.prisma.reviewRunAuthorization.count({
        where: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
      });
    return {
      factsVersion,
      facts: { noV2AuthorizationOrMutationExists: authorizationCount === 0 },
    } as const;
  }

  async inspectDirectV2InitializationFacts(input: {
    readonly scmRepositoryIdentityId: string;
  }) {
    const target = await this.resolveTarget(input.scmRepositoryIdentityId);
    const [inventory, safety] = await Promise.all([
      this.dependencies.workflowInventory.inspectReviewV2ManagedWorkflowInventory(
        {
          githubInstallationId: target.repository.githubInstallationId,
          githubRepositoryId: target.repository.githubRepositoryId,
          repositoryFullName: target.repository.fullName,
          owner: target.repository.owner,
        },
      ),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.MutationEpochActivation,
        target: target.safetyTarget,
      }),
    ]);
    return {
      factsVersion,
      facts: {
        freshV2OnlyProvisioningProven: false,
        noLegacyCapabilityEverIssued: false,
        managedWorkflowInventoryHash: inventory.inventoryHash,
        safetyDecisionEnabled: safety.effectAllowed,
        activationSafetyDecisionHash: safety.safetyDecisionHash,
      },
    } as const;
  }

  async inspectResumeFacts(input: {
    readonly scmRepositoryIdentityId: string;
  }) {
    const target = await this.resolveTarget(input.scmRepositoryIdentityId);
    const [unsafeOutcomeCount, registeredReleaseCount, safety] =
      await Promise.all([
        this.dependencies.prisma.reviewPublicationAttemptV2.count({
          where: {
            scmRepositoryIdentityId: input.scmRepositoryIdentityId,
            terminalOutcome: { in: ["stale_visible", "terminal_unknown"] },
          },
        }),
        this.dependencies.prisma.producerRelease.count({
          where: { state: "registered" },
        }),
        this.dependencies.safety.resolveReviewSafetyPolicy({
          decisionKind: ReviewSafetyDecisionKind.MutationEpochActivation,
          target: target.safetyTarget,
        }),
      ]);
    return {
      factsVersion,
      facts: {
        unknownEffectsReconciled: unsafeOutcomeCount === 0,
        repositoryBound: true,
        registeredReleaseSelected: registeredReleaseCount > 0,
        safetyDecisionEnabled: safety.effectAllowed,
        activationSafetyDecisionHash: safety.safetyDecisionHash,
      },
    } as const;
  }

  private async resolveTarget(scmRepositoryIdentityId: string) {
    const identity =
      await this.dependencies.identities.findScmRepositoryIdentityById(
        scmRepositoryIdentityId,
      );
    if (
      !identity ||
      !identity.currentWorkspaceId ||
      !identity.currentRepositoryConnectionId
    ) {
      throw new Error("review_mutation_proof_repository_unbound");
    }
    const repository =
      await this.dependencies.actionRepositories.findSelectedRepositoryByGithubId(
        identity.externalRepositoryId,
      );
    if (
      !repository ||
      repository.workspaceId !== identity.currentWorkspaceId ||
      repository.repositoryId !== identity.currentRepositoryConnectionId
    ) {
      throw new Error("review_mutation_proof_repository_mismatch");
    }
    return {
      repository,
      safetyTarget: {
        workspaceId: identity.currentWorkspaceId,
        repositoryConnectionId: identity.currentRepositoryConnectionId,
        scmRepositoryIdentityId,
      },
    } as const;
  }
}
