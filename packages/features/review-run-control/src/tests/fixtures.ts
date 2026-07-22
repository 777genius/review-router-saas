import { createHash } from "node:crypto";
import type {
  ProducerReleaseCandidate,
  ReviewOperationalSloThresholds,
  ReviewProtocolLimits,
} from "../domain/producer-release";
import {
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
} from "../domain/producer-release";
import type { VerifiedScmRunIdentity } from "../application/use-cases/manage-review-run-authorizations";
import { ReviewMutationAuthorityCommandKind } from "../application/use-cases/manage-review-mutation-authority";
import { reviewMutationAuthorityProofReference } from "../domain/review-mutation-authority-proof";
import {
  ProducerDistributionKind,
  ReviewCapabilityProfile,
  ReviewProviderKind,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTrustDomain,
  ScmProvider,
} from "../domain/review-run-control-types";
import type { ReviewRunControlTestKit } from "../testing/review-run-control-test-kit";

export const hashA = "a".repeat(64);
export const hashB = "b".repeat(64);
export const hashC = "c".repeat(64);
export const shaA = "a".repeat(40);
export const shaB = "b".repeat(40);
export const shaC = "c".repeat(40);

export const limits: ReviewProtocolLimits = {
  maxWorkSlots: 200,
  maxAttemptsPerSlot: 4,
  maxObservationBytes: 1_000_000,
  maxObservationFindings: 1_000,
  maxProjectionBytes: 2_000_000,
  maxProjectionFindings: 2_000,
  maxPublicationOperations: 500,
  maxPublicationChunks: 500,
  maxPublicationBodyBytes: 2_000_000,
  maxRequestBatchSize: 100,
  maxLeaseDurationMs: 600_000,
  maxResultReportDurationMs: 1_200_000,
  maxReconciliationDurationMs: 3_600_000,
};

export const sloThresholds: ReviewOperationalSloThresholds = {
  integrationEventDeliveryMs: 60_000,
  outboxClaimAgeMs: 120_000,
  missingCompletionProcessMs: 300_000,
  dueCompletionProcessMs: 300_000,
  publicationReconciliationMs: 600_000,
  v1DrainMs: 3_600_000,
  admissionMs: 30_000,
  pruningBacklogAgeMs: 86_400_000,
};

export const limitsDigest = createHash("sha256")
  .update(canonicalReviewProtocolLimits(limits), "utf8")
  .digest("hex");
export const sloDigest = createHash("sha256")
  .update(
    canonicalReviewOperationalSloProfile({
      thresholds: sloThresholds,
      ownerRefs: ["team-reviewrouter"],
      runbookRefs: ["runbook/review-v2"],
    }),
    "utf8",
  )
  .digest("hex");

export const releaseCandidate: ProducerReleaseCandidate = {
  producerReleaseId: "release-1",
  distributionKind: ProducerDistributionKind.PublicReusable,
  actionCommitSha: shaA,
  runtimeCommitSha: shaB,
  wrapperEntrypointDigest: null,
  runtimeEntrypointDigest: hashA,
  schemaDigest: hashB,
  capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
  protocolLimitsProfileId: "limits-1",
  operationalSloProfileId: "slo-1",
};

export async function provisionV2AuthorizationContext(
  kit: ReviewRunControlTestKit,
): Promise<{
  readonly verifiedIdentity: VerifiedScmRunIdentity;
  readonly authorizeInput: {
    readonly verifiedIdentity: VerifiedScmRunIdentity;
    readonly producerReleaseId: string;
    readonly protocolOfferHash: string;
    readonly oidcReplayKeyHash: string;
    readonly providerVoteLanes: readonly {
      readonly providerKind: ReviewProviderKind;
      readonly providerVoteIdentityHash: string;
    }[];
    readonly authorizationTtlMs: number;
    readonly maxAuthorizationLifetimeMs: number;
  };
}> {
  await kit.control.producerReleases.registerProtocolLimitsProfile({
    protocolLimitsProfileId: "limits-1",
    limitsDigest,
    limits,
  });
  await kit.control.producerReleases.registerOperationalSloProfile({
    operationalSloProfileId: "slo-1",
    sloDigest,
    thresholds: sloThresholds,
    ownerRefs: ["team-reviewrouter"],
    runbookRefs: ["runbook/review-v2"],
  });
  await kit.control.producerReleases.registerProducerRelease({
    candidate: releaseCandidate,
    expectedProtocolLimitsDigest: limitsDigest,
    expectedOperationalSloDigest: sloDigest,
  });
  const resolved =
    await kit.control.repositoryIdentities.resolveOrRegisterScmRepositoryIdentity(
      {
        provider: ScmProvider.GitHub,
        sourceBaseUrl: "https://github.com/",
        externalRepositoryId: "123456",
      },
    );
  const bound =
    await kit.control.repositoryIdentities.bindScmRepositoryIdentity({
      scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
      expectedVersion: resolved.identity.version,
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
    });
  if (!("identity" in bound)) {
    throw new Error("fixture_identity_binding_failed");
  }
  const directV2Preflight = await kit.control.mutationAuthority.preflight({
    scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
    operation: ReviewMutationAuthorityCommandKind.DirectV2Initialize,
  });
  if (!("proof" in directV2Preflight) || !directV2Preflight.proof) {
    throw new Error("fixture_direct_v2_proof_missing");
  }
  await kit.control.mutationAuthority.initializeDirectV2({
    scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
    proof: reviewMutationAuthorityProofReference(directV2Preflight.proof),
  });
  await kit.control.safetyControls.setReviewSafetyEmergencyStop({
    expectedVersion: 0,
    scope: { scope: ReviewSafetyPolicyScope.Global },
    stopped: false,
    reason: "test-v2-enabled",
    updatedBy: "test-operator",
  });
  await kit.control.safetyControls.updateReviewSafetyPolicy({
    expectedVersion: 0,
    scope: { scope: ReviewSafetyPolicyScope.Global },
    capability: ReviewSafetyCapability.RunAuthorizationV2,
    rolloutMode: ReviewSafetyRolloutMode.Enabled,
    updatedBy: "test-operator",
  });
  const verifiedIdentity: VerifiedScmRunIdentity = {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
    pullRequestNumber: 42,
    sourceRunId: "run-100",
    sourceRunAttempt: "1",
    workflowIdentityHash: hashA,
    baseSha: shaA,
    mergeBaseSha: shaB,
    headSha: shaC,
    reviewRevisionHash: hashC,
    trustDomain: ReviewTrustDomain.TrustedManaged,
  };
  return {
    verifiedIdentity,
    authorizeInput: {
      verifiedIdentity,
      producerReleaseId: releaseCandidate.producerReleaseId,
      protocolOfferHash: hashA,
      oidcReplayKeyHash: hashB,
      providerVoteLanes: [
        {
          providerKind: ReviewProviderKind.Codex,
          providerVoteIdentityHash: hashC,
        },
      ],
      authorizationTtlMs: 10 * 60_000,
      maxAuthorizationLifetimeMs: 60 * 60_000,
    },
  };
}
