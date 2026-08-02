import type { ProviderInvocationManifest } from "./provider-invocation-manifest";
import type { ReviewObservation } from "./review-observation";
import {
  ProviderExecutionProfile,
  ReviewObservationQualityFlag,
  ReviewTaskKind,
  compareStrings,
  sameRevision,
  sameScope,
  type ReviewEvidenceScope,
  type ReviewRevision,
} from "./review-evidence-primitives";

export const reviewReuseEligibilityPolicyVersion = "review-reuse-v1";

export enum ReviewReuseTier {
  T0ExactRevision = "t0_exact_revision",
  T1PromptOnlyCrossRevision = "t1_prompt_only_cross_revision",
  T2ContextGatewayCrossRevision = "t2_context_gateway_cross_revision",
  None = "none",
}

export enum ReuseEligibility {
  ExactRevision = "exact_revision",
  PromptOnlyCrossRevision = "prompt_only_cross_revision",
  CandidateOnly = "candidate_only",
  DeniedExecutionProfile = "denied_execution_profile",
  DeniedIncompatible = "denied_incompatible",
}

export enum ReviewReuseDenialReason {
  None = "none",
  SameExecutionRequiresAdoption = "same_execution_requires_adoption",
  ScopeMismatch = "scope_mismatch",
  TrustDomainMismatch = "trust_domain_mismatch",
  Expired = "expired",
  ManifestMismatch = "manifest_mismatch",
  RevisionMismatch = "revision_mismatch",
  PlanMismatch = "plan_mismatch",
  ProviderMismatch = "provider_mismatch",
  ActualModelIncompatible = "actual_model_incompatible",
  RuntimeIncompatible = "runtime_incompatible",
  CapabilityProfileIncompatible = "capability_profile_incompatible",
  ProducerReleaseUnregistered = "producer_release_unregistered",
  EvidenceReuseDisabled = "evidence_reuse_disabled",
  EvidenceReuseShadow = "evidence_reuse_shadow",
  PromptOnlyReuseDisabled = "prompt_only_reuse_disabled",
  PromptOnlyReuseShadow = "prompt_only_reuse_shadow",
  LifecycleTaskPresent = "lifecycle_task_present",
  LifecycleStateIncomplete = "lifecycle_state_incomplete",
  ExecutionProfileDenied = "execution_profile_denied",
  PromptOnlyConfinementNotProven = "prompt_only_confinement_not_proven",
  ContextAttestationMissing = "context_attestation_missing",
  ContextReplayRequired = "context_replay_required",
  ReuseDenyingQualityFlag = "reuse_denying_quality_flag",
  ContextGatewayReuseDisabled = "context_gateway_reuse_disabled",
  ContextGatewayReuseShadow = "context_gateway_reuse_shadow",
  UnknownCompatibility = "unknown_compatibility",
}

export enum ReviewReuseEffectMode {
  Disabled = "disabled",
  Shadow = "shadow",
  Enabled = "enabled",
}

export enum ActualModelCompatibilityMode {
  Exact = "exact",
  Allowlisted = "allowlisted",
}

export type ReviewReuseSafetyDecision = Readonly<{
  evidenceReuseMode: ReviewReuseEffectMode;
  promptOnlyReuseMode: ReviewReuseEffectMode;
  contextGatewayReuseMode: ReviewReuseEffectMode;
  safetyDecisionHash: string;
}>;

export type ReviewReuseCompatibilityPolicy = Readonly<{
  registeredProducerReleaseIds: readonly string[];
  trustedCapabilityProfiles: readonly string[];
  compatibleProviderRuntimeVersions: readonly string[];
  actualModelMode: ActualModelCompatibilityMode;
  compatibleActualModels: readonly string[];
}>;

export type ReviewEvidenceLookupTarget = Readonly<{
  scope: ReviewEvidenceScope;
  revision: ReviewRevision;
  planHash: string;
  executionId: string;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  trustDomain: ReviewObservation["trustDomain"];
  nowMs: number;
  safetyDecision: ReviewReuseSafetyDecision;
  compatibility: ReviewReuseCompatibilityPolicy;
}>;

export type ReviewReuseDecision = Readonly<{
  observation: ReviewObservation;
  eligibility: ReuseEligibility;
  tier: ReviewReuseTier;
  reason: ReviewReuseDenialReason;
  canAttach: boolean;
  reuseSafetyDecisionHash: string | null;
}>;

export function decideReviewReuseEligibility(
  observation: ReviewObservation,
  target: ReviewEvidenceLookupTarget,
): ReviewReuseDecision {
  const denied = (
    eligibility: ReuseEligibility,
    reason: ReviewReuseDenialReason,
    tier = ReviewReuseTier.None,
  ): ReviewReuseDecision =>
    Object.freeze({
      observation,
      eligibility,
      tier,
      reason,
      canAttach: false,
      reuseSafetyDecisionHash: null,
    });

  if (observation.sourceExecutionId === target.executionId) {
    return denied(
      ReuseEligibility.CandidateOnly,
      ReviewReuseDenialReason.SameExecutionRequiresAdoption,
    );
  }
  if (!sameScope(observation.scope, target.scope)) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.ScopeMismatch,
    );
  }
  if (observation.trustDomain !== target.trustDomain) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.TrustDomainMismatch,
    );
  }
  if (observation.reuseExpiresAtMs <= target.nowMs) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.Expired,
    );
  }
  if (
    observation.manifestKey !== target.manifestKey ||
    observation.providerInvocationKey !== target.providerInvocationKey ||
    observation.providerVoteIdentityHash !== target.providerVoteIdentityHash
  ) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.ManifestMismatch,
    );
  }
  if (
    observation.providerKind !== target.manifest.providerKind ||
    observation.requestedModel !== target.manifest.requestedModel ||
    observation.producerReleaseId !== target.manifest.producerReleaseId ||
    observation.selectedProtocolVersion !==
      target.manifest.selectedProtocolVersion
  ) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.ProviderMismatch,
    );
  }
  const commonDenial = decideCompatibility(observation, target.compatibility);
  if (commonDenial !== ReviewReuseDenialReason.None) {
    return denied(ReuseEligibility.DeniedIncompatible, commonDenial);
  }
  if (
    target.safetyDecision.evidenceReuseMode === ReviewReuseEffectMode.Disabled
  ) {
    return denied(
      ReuseEligibility.DeniedIncompatible,
      ReviewReuseDenialReason.EvidenceReuseDisabled,
    );
  }

  if (sameRevision(observation.sourceRevision, target.revision)) {
    if (observation.sourcePlanHash !== target.planHash) {
      return denied(
        ReuseEligibility.DeniedIncompatible,
        ReviewReuseDenialReason.PlanMismatch,
        ReviewReuseTier.T0ExactRevision,
      );
    }
    if (
      observation.taskKindSet.includes(ReviewTaskKind.LifecycleRevalidation) &&
      (target.manifest.lifecycleTargetSetHash === null ||
        target.manifest.liveLifecycleStateHash === null)
    ) {
      return denied(
        ReuseEligibility.DeniedIncompatible,
        ReviewReuseDenialReason.LifecycleStateIncomplete,
        ReviewReuseTier.T0ExactRevision,
      );
    }
    if (
      target.safetyDecision.evidenceReuseMode === ReviewReuseEffectMode.Shadow
    ) {
      return denied(
        ReuseEligibility.CandidateOnly,
        ReviewReuseDenialReason.EvidenceReuseShadow,
        ReviewReuseTier.T0ExactRevision,
      );
    }
    return eligible(
      observation,
      ReuseEligibility.ExactRevision,
      ReviewReuseTier.T0ExactRevision,
      target.safetyDecision.safetyDecisionHash,
    );
  }

  if (
    target.manifest.executionProfile ===
    ProviderExecutionProfile.ContextGatewayV1
  ) {
    if (
      observation.executionProfile !== ProviderExecutionProfile.ContextGatewayV1
    ) {
      return denied(
        ReuseEligibility.DeniedExecutionProfile,
        ReviewReuseDenialReason.ExecutionProfileDenied,
        ReviewReuseTier.T2ContextGatewayCrossRevision,
      );
    }
    if (
      observation.contextDependencyAttestationId === null ||
      observation.contextDependencyAttestationHash === null
    ) {
      return denied(
        ReuseEligibility.DeniedIncompatible,
        ReviewReuseDenialReason.ContextAttestationMissing,
        ReviewReuseTier.T2ContextGatewayCrossRevision,
      );
    }
    if (observation.qualityFlags.length > 0) {
      return denied(
        ReuseEligibility.DeniedIncompatible,
        ReviewReuseDenialReason.ReuseDenyingQualityFlag,
        ReviewReuseTier.T2ContextGatewayCrossRevision,
      );
    }
    if (
      target.manifest.taskKindSet.includes(
        ReviewTaskKind.LifecycleRevalidation,
      ) ||
      target.manifest.lifecycleTargetSetHash !== null ||
      target.manifest.liveLifecycleStateHash !== null
    ) {
      return denied(
        ReuseEligibility.DeniedExecutionProfile,
        ReviewReuseDenialReason.LifecycleTaskPresent,
        ReviewReuseTier.T2ContextGatewayCrossRevision,
      );
    }
    if (
      target.safetyDecision.contextGatewayReuseMode ===
      ReviewReuseEffectMode.Disabled
    ) {
      return denied(
        ReuseEligibility.DeniedIncompatible,
        ReviewReuseDenialReason.ContextGatewayReuseDisabled,
        ReviewReuseTier.T2ContextGatewayCrossRevision,
      );
    }
    return denied(
      ReuseEligibility.CandidateOnly,
      target.safetyDecision.contextGatewayReuseMode ===
        ReviewReuseEffectMode.Shadow
        ? ReviewReuseDenialReason.ContextGatewayReuseShadow
        : ReviewReuseDenialReason.ContextReplayRequired,
      ReviewReuseTier.T2ContextGatewayCrossRevision,
    );
  }
  if (
    target.manifest.executionProfile !==
      ProviderExecutionProfile.PromptOnlyEnvelopeV1 ||
    observation.executionProfile !==
      ProviderExecutionProfile.PromptOnlyEnvelopeV1
  ) {
    return denied(
      ReuseEligibility.DeniedExecutionProfile,
      ReviewReuseDenialReason.ExecutionProfileDenied,
    );
  }
  return denied(
    ReuseEligibility.DeniedExecutionProfile,
    ReviewReuseDenialReason.PromptOnlyConfinementNotProven,
    ReviewReuseTier.T1PromptOnlyCrossRevision,
  );
}

export function selectDeterministicReviewObservations(
  decisions: readonly ReviewReuseDecision[],
): readonly ReviewReuseDecision[] {
  const selectedByVote = new Map<string, ReviewReuseDecision>();
  for (const decision of decisions) {
    if (!decision.canAttach) continue;
    const voteIdentity = decision.observation.providerVoteIdentityHash;
    const current = selectedByVote.get(voteIdentity);
    if (!current || compareReviewReuseDecisions(decision, current) < 0) {
      selectedByVote.set(voteIdentity, decision);
    }
  }
  return Object.freeze(
    [...selectedByVote.values()].sort((left, right) =>
      compareStrings(
        left.observation.providerVoteIdentityHash,
        right.observation.providerVoteIdentityHash,
      ),
    ),
  );
}

function decideCompatibility(
  observation: ReviewObservation,
  policy: ReviewReuseCompatibilityPolicy,
): ReviewReuseDenialReason {
  if (
    !policy.registeredProducerReleaseIds.includes(observation.producerReleaseId)
  ) {
    return ReviewReuseDenialReason.ProducerReleaseUnregistered;
  }
  if (
    !policy.trustedCapabilityProfiles.includes(
      observation.trustedCapabilityProfile,
    )
  ) {
    return ReviewReuseDenialReason.CapabilityProfileIncompatible;
  }
  if (
    !policy.compatibleProviderRuntimeVersions.includes(
      observation.providerRuntimeVersion,
    )
  ) {
    return ReviewReuseDenialReason.RuntimeIncompatible;
  }
  if (policy.actualModelMode === ActualModelCompatibilityMode.Exact) {
    return observation.actualModel === observation.requestedModel
      ? ReviewReuseDenialReason.None
      : ReviewReuseDenialReason.ActualModelIncompatible;
  }
  if (policy.actualModelMode === ActualModelCompatibilityMode.Allowlisted) {
    return policy.compatibleActualModels.includes(observation.actualModel)
      ? ReviewReuseDenialReason.None
      : ReviewReuseDenialReason.ActualModelIncompatible;
  }
  return ReviewReuseDenialReason.UnknownCompatibility;
}

function eligible(
  observation: ReviewObservation,
  eligibility: ReuseEligibility,
  tier: ReviewReuseTier,
  safetyDecisionHash: string,
): ReviewReuseDecision {
  return Object.freeze({
    observation,
    eligibility,
    tier,
    reason: ReviewReuseDenialReason.None,
    canAttach: true,
    reuseSafetyDecisionHash: safetyDecisionHash,
  });
}

function compareReviewReuseDecisions(
  left: ReviewReuseDecision,
  right: ReviewReuseDecision,
): number {
  const leftFlags = qualityPenalty(left.observation.qualityFlags);
  const rightFlags = qualityPenalty(right.observation.qualityFlags);
  if (leftFlags !== rightFlags) return leftFlags - rightFlags;
  const leftExactModel =
    left.observation.actualModel === left.observation.requestedModel;
  const rightExactModel =
    right.observation.actualModel === right.observation.requestedModel;
  if (leftExactModel !== rightExactModel) return leftExactModel ? -1 : 1;
  if (left.observation.createdAtMs !== right.observation.createdAtMs) {
    return right.observation.createdAtMs - left.observation.createdAtMs;
  }
  const payloadOrder = compareStrings(
    left.observation.payloadHash,
    right.observation.payloadHash,
  );
  return payloadOrder !== 0
    ? payloadOrder
    : compareStrings(
        left.observation.observationId,
        right.observation.observationId,
      );
}

function qualityPenalty(
  flags: readonly ReviewObservationQualityFlag[],
): number {
  return flags.reduce((total, flag) => {
    switch (flag) {
      case ReviewObservationQualityFlag.ModelFallback:
        return total + 4;
      case ReviewObservationQualityFlag.LowConfidence:
        return total + 2;
      case ReviewObservationQualityFlag.ProviderWarning:
        return total + 1;
      case ReviewObservationQualityFlag.ContextInspectionIncomplete:
        return total + 100;
      case ReviewObservationQualityFlag.ContextAttestationUnavailable:
        return total + 50;
      case ReviewObservationQualityFlag.CrossRevisionReuseDisabled:
        return total + 1;
      case ReviewObservationQualityFlag.InvestigationFindings:
        return total;
      case ReviewObservationQualityFlag.InvestigationInconclusive:
        return total + 100;
      case ReviewObservationQualityFlag.Unknown:
        return total + 1_000;
    }
  }, 0);
}
