import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ActionControlPlaneRepositoryPort } from "@reviewrouter/features-action-control-plane";
import { isClientTriggeredT0WorkflowSchemaVersion } from "@reviewrouter/features-codex-oauth-rotating";
import {
  ProducerReleaseAttestationStatus,
  ProducerReleaseState,
  ReviewMutationLaneKind,
  ReviewMutationExecutionAuthorityMode,
  ReviewMutationMode,
  ReviewSafetyDecisionKind,
  producerReleaseImmutableKey,
  type ProducerReleaseAttestationPort,
  type ProducerReleaseQueryPort,
  type ReviewMutationAuthorityProofFactsQueryPorts,
  type ReviewMutationAuthorityQueryPort,
  type ReviewSafetyDecisionResolverPort,
  type ScmRepositoryIdentityQueryPort,
} from "@reviewrouter/features-review-run-control";
import {
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedSchemaDigest,
} from "@reviewrouter/protocol-review-action-v2";

const factsVersion = "review-mutation-authority-production-facts-v3";

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
    readonly workflowSchemaVersion: number | null;
  }>;
}

export interface ReviewV2DispatchCapabilityInspectionPort {
  inspectReviewV2DispatchCapability(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
  }): Promise<{ readonly available: boolean }>;
}

export class ProductionReviewMutationAuthorityProofFacts implements ReviewMutationAuthorityProofFactsQueryPorts {
  constructor(
    private readonly dependencies: {
      readonly prisma: PrismaClient;
      readonly identities: ScmRepositoryIdentityQueryPort;
      readonly authorities: ReviewMutationAuthorityQueryPort;
      readonly actionRepositories: ActionControlPlaneRepositoryPort;
      readonly releaseAttestations: ProducerReleaseAttestationPort;
      readonly producerReleases: ProducerReleaseQueryPort;
      readonly safety: ReviewSafetyDecisionResolverPort;
      readonly workflowInventory: ManagedReviewWorkflowInventoryInspectionPort;
      readonly dispatchCapability: ReviewV2DispatchCapabilityInspectionPort;
      readonly completionWorkerConfigured: boolean;
      readonly directV2InitializationEnabled: boolean;
      readonly now: () => Date;
    },
  ) {}

  async inspectActivationFacts(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }) {
    const target = await this.resolveTarget(input.scmRepositoryIdentityId);
    const [authority, inventory, dispatchCapability, safety] =
      await Promise.all([
        this.dependencies.authorities.findReviewMutationAuthority(input),
        this.dependencies.workflowInventory.inspectReviewV2ManagedWorkflowInventory(
          {
            githubInstallationId: target.repository.githubInstallationId,
            githubRepositoryId: target.repository.githubRepositoryId,
            repositoryFullName: target.repository.fullName,
            owner: target.repository.owner,
          },
        ),
        this.dependencies.dispatchCapability.inspectReviewV2DispatchCapability({
          githubInstallationId: target.repository.githubInstallationId,
          githubRepositoryId: target.repository.githubRepositoryId,
        }),
        this.dependencies.safety.resolveReviewSafetyPolicy({
          decisionKind: ReviewSafetyDecisionKind.MutationEpochActivation,
          target: target.safetyTarget,
        }),
      ]);
    const now = this.dependencies.now();
    const registeredReleaseSelected =
      await this.isExactRegisteredReleaseSelected(inventory.actionCommitSha);
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
        dispatchCapabilityAvailable: dispatchCapability.available,
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
    const [
      authority,
      inventory,
      dispatchCapability,
      safety,
      authorizationCount,
    ] = await Promise.all([
      this.dependencies.authorities.findReviewMutationAuthority({
        scmRepositoryIdentityId: input.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      }),
      this.dependencies.workflowInventory.inspectReviewV2ManagedWorkflowInventory(
        {
          githubInstallationId: target.repository.githubInstallationId,
          githubRepositoryId: target.repository.githubRepositoryId,
          repositoryFullName: target.repository.fullName,
          owner: target.repository.owner,
        },
      ),
      this.dependencies.dispatchCapability.inspectReviewV2DispatchCapability({
        githubInstallationId: target.repository.githubInstallationId,
        githubRepositoryId: target.repository.githubRepositoryId,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.MutationEpochActivation,
        target: target.safetyTarget,
      }),
      this.dependencies.prisma.reviewRunAuthorization.count({
        where: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
      }),
    ]);
    const registeredReleaseSelected =
      await this.isExactRegisteredReleaseSelected(inventory.actionCommitSha);
    const clientTriggeredWorkflowAvailable =
      inventory.compatible &&
      isClientTriggeredT0WorkflowSchemaVersion(inventory.workflowSchemaVersion);
    const executionAuthorityMode = dispatchCapability.available
      ? ReviewMutationExecutionAuthorityMode.ManagedDispatch
      : clientTriggeredWorkflowAvailable
        ? ReviewMutationExecutionAuthorityMode.ClientTriggered
        : null;
    const freshV2OnlyProvisioningProven =
      this.dependencies.directV2InitializationEnabled &&
      authority === null &&
      authorizationCount === 0;
    return {
      factsVersion: "review-mutation-authority-production-facts-v4",
      facts: {
        freshV2OnlyProvisioningProven,
        noLegacyCapabilityEverIssued: authority === null,
        workflowInventoryCompatible: inventory.compatible,
        registeredReleaseSelected,
        completionWorkerConfigured:
          this.dependencies.completionWorkerConfigured,
        executionAuthorityMode,
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
    const [
      unsafeOutcomeCount,
      registeredReleaseCount,
      dispatchCapability,
      safety,
    ] = await Promise.all([
      this.dependencies.prisma.reviewPublicationAttemptV2.count({
        where: {
          scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          terminalOutcome: { in: ["stale_visible", "terminal_unknown"] },
        },
      }),
      this.dependencies.prisma.producerRelease.count({
        where: { state: "registered" },
      }),
      this.dependencies.dispatchCapability.inspectReviewV2DispatchCapability({
        githubInstallationId: target.repository.githubInstallationId,
        githubRepositoryId: target.repository.githubRepositoryId,
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
        dispatchCapabilityAvailable: dispatchCapability.available,
        safetyDecisionEnabled: safety.effectAllowed,
        activationSafetyDecisionHash: safety.safetyDecisionHash,
      },
    } as const;
  }

  private async isExactRegisteredReleaseSelected(
    actionCommitSha: string | null,
  ): Promise<boolean> {
    if (actionCommitSha === null) return false;
    const attestation = await this.dependencies.releaseAttestations.attest({
      actionCommitSha,
      expectedSchemaDigest: reviewActionV2PublishedSchemaDigest,
      expectedCanonicalizerDigest: reviewActionV2CanonicalizerDigest,
    });
    if (attestation.status !== ProducerReleaseAttestationStatus.Attested) {
      return false;
    }
    const persisted =
      await this.dependencies.producerReleases.findProducerReleaseById(
        attestation.release.producerReleaseId,
      );
    return (
      persisted !== null &&
      persisted.state === ProducerReleaseState.Registered &&
      producerReleaseImmutableKey(persisted) ===
        producerReleaseImmutableKey(attestation.release)
    );
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
