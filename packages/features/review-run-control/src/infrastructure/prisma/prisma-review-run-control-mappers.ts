import type {
  ProducerRelease as PrismaProducerRelease,
  ReviewMutationAuthority as PrismaReviewMutationAuthority,
  ReviewOperationalSloProfileV2 as PrismaReviewOperationalSloProfile,
  ReviewProtocolLimitsV2 as PrismaReviewProtocolLimits,
  ReviewRunAuthorization as PrismaReviewRunAuthorization,
  ReviewSafetyEmergencyControl as PrismaReviewSafetyEmergencyControl,
  ReviewSafetyPolicy as PrismaReviewSafetyPolicy,
  ReviewSafetyPolicySelector as PrismaReviewSafetyPolicySelector,
  ScmRepositoryIdentity as PrismaScmRepositoryIdentity,
} from "@prisma/client";
import type {
  ProducerRelease,
  ReviewOperationalSloProfileV2,
  ReviewProtocolLimitsV2,
} from "../../domain/producer-release";
import type { ReviewMutationAuthority } from "../../domain/review-mutation-authority";
import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";
import type {
  ReviewSafetyEmergencyControl,
  ReviewSafetyPolicy,
  ReviewSafetyScope,
} from "../../domain/review-safety-policy";
import type { ScmRepositoryIdentity } from "../../domain/scm-repository-identity";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewProtocolVersion,
  ReviewProviderKind,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenAudience,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTaskKind,
  ReviewTrustDomain,
  ScmProvider,
  type ProviderTaskSelector,
  type ProviderVoteLane,
} from "../../domain/review-run-control-types";

export function protocolLimitsToDomain(
  row: PrismaReviewProtocolLimits,
): ReviewProtocolLimitsV2 {
  return { ...row, registeredAt: new Date(row.registeredAt) };
}

export function operationalSloToDomain(
  row: PrismaReviewOperationalSloProfile,
): ReviewOperationalSloProfileV2 {
  return {
    ...row,
    ownerRefs: [...row.ownerRefs],
    runbookRefs: [...row.runbookRefs],
    registeredAt: new Date(row.registeredAt),
  };
}

export function producerReleaseToDomain(
  row: PrismaProducerRelease,
): ProducerRelease {
  return {
    ...row,
    distributionKind: producerDistributionKindToDomain(row.distributionKind),
    capabilityProfile: reviewCapabilityProfileToDomain(row.capabilityProfile),
    state: producerReleaseStateToDomain(row.state),
    registeredAt: new Date(row.registeredAt),
    revokedAt: row.revokedAt ? new Date(row.revokedAt) : null,
  };
}

export function scmRepositoryIdentityToDomain(
  row: PrismaScmRepositoryIdentity,
): ScmRepositoryIdentity {
  return {
    ...row,
    provider: scmProviderToDomain(row.provider),
    createdAt: new Date(row.createdAt),
    boundAt: row.boundAt ? new Date(row.boundAt) : null,
    unboundAt: row.unboundAt ? new Date(row.unboundAt) : null,
  };
}

export function reviewMutationAuthorityToDomain(
  row: PrismaReviewMutationAuthority,
): ReviewMutationAuthority {
  return {
    ...row,
    laneKind: reviewMutationLaneKindToDomain(row.laneKind),
    mode: reviewMutationModeToDomain(row.mode),
    drainStartedAt: row.drainStartedAt ? new Date(row.drainStartedAt) : null,
    v1AdmissionClosedAt: row.v1AdmissionClosedAt
      ? new Date(row.v1AdmissionClosedAt)
      : null,
    drainNotBefore: row.drainNotBefore ? new Date(row.drainNotBefore) : null,
    initializedAt: new Date(row.initializedAt),
    activatedAt: row.activatedAt ? new Date(row.activatedAt) : null,
    pausedAt: row.pausedAt ? new Date(row.pausedAt) : null,
  };
}

export function reviewSafetyPolicyToDomain(
  row: PrismaReviewSafetyPolicy,
  selectors: readonly PrismaReviewSafetyPolicySelector[],
): ReviewSafetyPolicy {
  return {
    policyId: row.policyId,
    scope: reviewSafetyScopeToDomain(row),
    capability: reviewSafetyCapabilityToDomain(row.capability),
    version: row.version,
    rolloutMode: reviewSafetyRolloutModeToDomain(row.rolloutMode),
    providerTaskSelectors: [...selectors]
      .sort((left, right) => left.selectorOrdinal - right.selectorOrdinal)
      .map(reviewSafetySelectorToDomain),
    updatedBy: row.updatedBy,
    updatedAt: new Date(row.updatedAt),
  };
}

export function reviewSafetyEmergencyControlToDomain(
  row: PrismaReviewSafetyEmergencyControl,
): ReviewSafetyEmergencyControl {
  return {
    emergencyControlId: row.emergencyControlId,
    scope: reviewSafetyScopeToDomain(row),
    version: row.version,
    stopped: row.stopped,
    reason: row.reason,
    updatedBy: row.updatedBy,
    updatedAt: new Date(row.updatedAt),
  };
}

export function reviewRunAuthorizationToDomain(
  row: PrismaReviewRunAuthorization,
): ReviewRunAuthorization {
  return {
    authorizationId: row.authorizationId,
    version: row.version,
    workspaceId: row.workspaceId,
    repositoryConnectionId: row.repositoryConnectionId,
    scmRepositoryIdentityId: row.scmRepositoryIdentityId,
    pullRequestNumber: row.pullRequestNumber,
    sourceRunId: row.sourceRunId,
    sourceRunAttempt: row.sourceRunAttempt,
    workflowIdentityHash: row.workflowIdentityHash,
    baseSha: row.baseSha,
    mergeBaseSha: row.mergeBaseSha,
    headSha: row.headSha,
    reviewRevisionHash: row.reviewRevisionHash,
    trustDomain: reviewTrustDomainToDomain(row.trustDomain),
    producerReleaseId: row.producerReleaseId,
    selectedProtocolVersion: reviewProtocolVersionToDomain(
      row.selectedProtocolVersion,
    ),
    schemaDigest: row.schemaDigest,
    protocolLimitsProfileId: row.protocolLimitsProfileId,
    operationalSloProfileId: row.operationalSloProfileId,
    mutationEpoch: row.mutationEpoch,
    providerVoteLanes: parseProviderVoteLanes(row.providerVoteLanes),
    authorizationSafetyDecisionHash: row.authorizationSafetyDecisionHash,
    protocolOfferHash: row.protocolOfferHash,
    oidcReplayKeyHash: row.oidcReplayKeyHash,
    tokenSigningKeyId: row.tokenSigningKeyId,
    tokenIssuer: row.tokenIssuer,
    tokenAudience: reviewRunAuthorizationAudienceToDomain(row.tokenAudience),
    state: reviewRunAuthorizationStateToDomain(row.state),
    expiresAt: new Date(row.expiresAt),
    maxExpiresAt: new Date(row.maxExpiresAt),
    createdAt: new Date(row.createdAt),
    renewedAt: row.renewedAt ? new Date(row.renewedAt) : null,
  };
}

export function reviewSafetyScopeColumns(scope: ReviewSafetyScope): {
  readonly policyScope: "global" | "workspace" | "repository";
  readonly workspaceId: string | null;
  readonly repositoryConnectionId: string | null;
  readonly scmRepositoryIdentityId: string | null;
} {
  switch (scope.scope) {
    case ReviewSafetyPolicyScope.Global:
      return {
        policyScope: "global",
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
      };
    case ReviewSafetyPolicyScope.Workspace:
      return {
        policyScope: "workspace",
        workspaceId: scope.workspaceId,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
      };
    case ReviewSafetyPolicyScope.Repository:
      return {
        policyScope: "repository",
        workspaceId: scope.workspaceId,
        repositoryConnectionId: scope.repositoryConnectionId,
        scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
      };
  }
}

export function reviewSafetySelectorColumns(selector: ProviderTaskSelector): {
  readonly providerKind: "codex" | "claude_code" | "openrouter";
  readonly taskKind: "code_review" | "finding_revalidation" | "conflict_review";
} {
  return {
    providerKind: reviewProviderKindToPersistence(selector.providerKind),
    taskKind: reviewTaskKindToPersistence(selector.taskKind),
  };
}

function producerDistributionKindToDomain(
  value: string,
): ProducerDistributionKind {
  switch (value) {
    case "hosted_composite":
      return ProducerDistributionKind.HostedComposite;
    case "public_reusable":
      return ProducerDistributionKind.PublicReusable;
    default:
      return corrupt("producer_distribution_kind", value);
  }
}

function producerReleaseStateToDomain(value: string): ProducerReleaseState {
  switch (value) {
    case "registered":
      return ProducerReleaseState.Registered;
    case "revoked":
      return ProducerReleaseState.Revoked;
    default:
      return corrupt("producer_release_state", value);
  }
}

function reviewCapabilityProfileToDomain(
  value: string,
): ReviewCapabilityProfile {
  switch (value) {
    case "exact_revision_v2":
      return ReviewCapabilityProfile.ExactRevisionV2;
    case "prompt_only_v2":
      return ReviewCapabilityProfile.PromptOnlyV2;
    case "context_gateway_v2":
      return ReviewCapabilityProfile.ContextGatewayV2;
    default:
      return corrupt("review_capability_profile", value);
  }
}

function scmProviderToDomain(value: string): ScmProvider {
  switch (value) {
    case "github":
      return ScmProvider.GitHub;
    case "gitlab":
      return ScmProvider.GitLab;
    default:
      return corrupt("scm_provider", value);
  }
}

function reviewMutationLaneKindToDomain(value: string): ReviewMutationLaneKind {
  switch (value) {
    case "hosted_reviewrouter_app":
      return ReviewMutationLaneKind.HostedReviewRouterApp;
    default:
      return corrupt("review_mutation_lane_kind", value);
  }
}

function reviewMutationModeToDomain(value: string): ReviewMutationMode {
  switch (value) {
    case "v1_open":
      return ReviewMutationMode.V1Open;
    case "v1_draining":
      return ReviewMutationMode.V1Draining;
    case "v2_active":
      return ReviewMutationMode.V2Active;
    case "paused":
      return ReviewMutationMode.Paused;
    default:
      return corrupt("review_mutation_mode", value);
  }
}

function reviewSafetyScopeToDomain(row: {
  readonly policyScope: string;
  readonly workspaceId: string | null;
  readonly repositoryConnectionId: string | null;
  readonly scmRepositoryIdentityId: string | null;
}): ReviewSafetyScope {
  switch (row.policyScope) {
    case "global":
      return { scope: ReviewSafetyPolicyScope.Global };
    case "workspace":
      if (!row.workspaceId) return corrupt("workspace_safety_scope", "null");
      return {
        scope: ReviewSafetyPolicyScope.Workspace,
        workspaceId: row.workspaceId,
      };
    case "repository":
      if (
        !row.workspaceId ||
        !row.repositoryConnectionId ||
        !row.scmRepositoryIdentityId
      ) {
        return corrupt("repository_safety_scope", "null");
      }
      return {
        scope: ReviewSafetyPolicyScope.Repository,
        workspaceId: row.workspaceId,
        repositoryConnectionId: row.repositoryConnectionId,
        scmRepositoryIdentityId: row.scmRepositoryIdentityId,
      };
    default:
      return corrupt("review_safety_scope", row.policyScope);
  }
}

function reviewSafetyCapabilityToDomain(value: string): ReviewSafetyCapability {
  switch (value) {
    case "run_authorization_v2":
      return ReviewSafetyCapability.RunAuthorizationV2;
    case "review_investigation_v1":
      return ReviewSafetyCapability.ReviewInvestigationV1;
    case "evidence_writes_v2":
      return ReviewSafetyCapability.EvidenceWritesV2;
    case "evidence_reuse_v2":
      return ReviewSafetyCapability.EvidenceReuseV2;
    case "prompt_only_reuse":
      return ReviewSafetyCapability.PromptOnlyReuse;
    case "context_gateway_reuse":
      return ReviewSafetyCapability.ContextGatewayReuse;
    case "publication_operations_v2":
      return ReviewSafetyCapability.PublicationOperationsV2;
    case "mutation_epoch_v2":
      return ReviewSafetyCapability.MutationEpochV2;
    default:
      return corrupt("review_safety_capability", value);
  }
}

function reviewSafetyRolloutModeToDomain(
  value: string,
): ReviewSafetyRolloutMode {
  switch (value) {
    case "disabled":
      return ReviewSafetyRolloutMode.Disabled;
    case "shadow":
      return ReviewSafetyRolloutMode.Shadow;
    case "allowlisted":
      return ReviewSafetyRolloutMode.Allowlisted;
    case "enabled":
      return ReviewSafetyRolloutMode.Enabled;
    default:
      return corrupt("review_safety_rollout_mode", value);
  }
}

function reviewSafetySelectorToDomain(
  row: PrismaReviewSafetyPolicySelector,
): ProviderTaskSelector {
  if (!row.providerKind || !row.taskKind) {
    return corrupt("review_safety_selector", "null");
  }
  return {
    providerKind: reviewProviderKindToDomain(row.providerKind),
    taskKind: reviewTaskKindToDomain(row.taskKind),
  };
}

function reviewProviderKindToDomain(value: string): ReviewProviderKind {
  switch (value) {
    case "codex":
      return ReviewProviderKind.Codex;
    case "claude_code":
      return ReviewProviderKind.ClaudeCode;
    case "openrouter":
      return ReviewProviderKind.OpenRouter;
    default:
      return corrupt("review_provider_kind", value);
  }
}

function reviewProviderKindToPersistence(
  value: ReviewProviderKind,
): "codex" | "claude_code" | "openrouter" {
  switch (value) {
    case ReviewProviderKind.Codex:
      return "codex";
    case ReviewProviderKind.ClaudeCode:
      return "claude_code";
    case ReviewProviderKind.OpenRouter:
      return "openrouter";
  }
}

function reviewTaskKindToDomain(value: string): ReviewTaskKind {
  switch (value) {
    case "code_review":
      return ReviewTaskKind.CodeReview;
    case "finding_revalidation":
      return ReviewTaskKind.FindingRevalidation;
    case "conflict_review":
      return ReviewTaskKind.ConflictReview;
    default:
      return corrupt("review_task_kind", value);
  }
}

function reviewTaskKindToPersistence(
  value: ReviewTaskKind,
): "code_review" | "finding_revalidation" | "conflict_review" {
  switch (value) {
    case ReviewTaskKind.CodeReview:
      return "code_review";
    case ReviewTaskKind.FindingRevalidation:
      return "finding_revalidation";
    case ReviewTaskKind.ConflictReview:
      return "conflict_review";
  }
}

function reviewTrustDomainToDomain(value: string): ReviewTrustDomain {
  switch (value) {
    case "trusted_managed":
      return ReviewTrustDomain.TrustedManaged;
    case "trusted_local":
      return ReviewTrustDomain.TrustedLocal;
    case "untrusted_contribution":
      return ReviewTrustDomain.UntrustedContribution;
    default:
      return corrupt("review_trust_domain", value);
  }
}

function reviewProtocolVersionToDomain(value: string): ReviewProtocolVersion {
  switch (value) {
    case "review_action_v2":
      return ReviewProtocolVersion.V2;
    default:
      return corrupt("review_protocol_version", value);
  }
}

function reviewRunAuthorizationAudienceToDomain(
  value: string,
): ReviewRunAuthorizationTokenAudience {
  switch (value) {
    case "review_run":
      return ReviewRunAuthorizationTokenAudience.ReviewRun;
    default:
      return corrupt("review_run_authorization_audience", value);
  }
}

function reviewRunAuthorizationStateToDomain(
  value: string,
): ReviewRunAuthorizationState {
  switch (value) {
    case "active":
      return ReviewRunAuthorizationState.Active;
    case "expired":
      return ReviewRunAuthorizationState.Expired;
    case "revoked":
      return ReviewRunAuthorizationState.Revoked;
    default:
      return corrupt("review_run_authorization_state", value);
  }
}

function parseProviderVoteLanes(value: unknown): readonly ProviderVoteLane[] {
  if (!Array.isArray(value)) {
    return corrupt("provider_vote_lanes", "not_array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      return corrupt("provider_vote_lane", "not_object");
    }
    const providerKind = entry.providerKind;
    const providerVoteIdentityHash = entry.providerVoteIdentityHash;
    if (
      typeof providerKind !== "string" ||
      typeof providerVoteIdentityHash !== "string"
    ) {
      return corrupt("provider_vote_lane", "invalid_fields");
    }
    return {
      providerKind: reviewProviderKindToDomain(providerKind),
      providerVoteIdentityHash,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corrupt(field: string, value: string): never {
  throw new Error(`review_run_control_persistence_corrupt:${field}:${value}`);
}
