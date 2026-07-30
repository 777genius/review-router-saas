import {
  ReviewMutationLaneKind,
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
  assertIdentifier,
  assertNonNegativeInteger,
  assertSha256,
  canonicalJson,
  invalid,
} from "./review-run-control-types";

export enum ReviewMutationAuthorityProofVersion {
  V1 = 1,
}

export enum ReviewMutationAuthorityProofKind {
  DirectV2Initialize = "direct_v2_initialize",
  AbortDrain = "abort_drain",
  Activate = "activate",
  Resume = "resume",
}

export enum ReviewMutationAuthorityProofBlocker {
  FreshProvisioningNotProven = "fresh_provisioning_not_proven",
  LegacyCapabilityPreviouslyIssued = "legacy_capability_previously_issued",
  V2ActivityExists = "v2_activity_exists",
  LegacyActivityExists = "legacy_activity_exists",
  WorkflowInventoryIncompatible = "workflow_inventory_incompatible",
  MutationSafetyDisabled = "mutation_safety_disabled",
  UnknownEffectsUnreconciled = "unknown_effects_unreconciled",
  RepositoryUnbound = "repository_unbound",
  RegisteredReleaseMissing = "registered_release_missing",
  CompletionWorkerUnavailable = "completion_worker_unavailable",
  DispatchCapabilityUnavailable = "dispatch_capability_unavailable",
  ExecutionAuthorityUnavailable = "execution_authority_unavailable",
}

export enum ReviewMutationExecutionAuthorityMode {
  ManagedDispatch = "managed_dispatch",
  ClientTriggered = "client_triggered",
}

declare const reviewMutationAuthorityProofDigestBrand: unique symbol;
export type ReviewMutationAuthorityProofDigest = string & {
  readonly [reviewMutationAuthorityProofDigestBrand]: true;
};

export type ReviewMutationAbortProofFacts = {
  readonly noV2AuthorizationOrMutationExists: boolean;
};

export type ReviewMutationDirectV2InitializationProofFacts = {
  readonly freshV2OnlyProvisioningProven: boolean;
  readonly noLegacyCapabilityEverIssued: boolean;
  readonly workflowInventoryCompatible: boolean;
  readonly registeredReleaseSelected: boolean;
  readonly completionWorkerConfigured: boolean;
  readonly executionAuthorityMode: ReviewMutationExecutionAuthorityMode | null;
  readonly managedWorkflowInventoryHash: string;
  readonly safetyDecisionEnabled: boolean;
  readonly activationSafetyDecisionHash: string;
};

export type ReviewMutationActivationProofFacts = {
  readonly noTrackedLegacyActivity: boolean;
  readonly workflowInventoryCompatible: boolean;
  readonly registeredReleaseSelected: boolean;
  readonly completionWorkerConfigured: boolean;
  readonly dispatchCapabilityAvailable: boolean;
  readonly managedWorkflowInventoryHash: string;
  readonly safetyDecisionEnabled: boolean;
  readonly activationSafetyDecisionHash: string;
};

export type ReviewMutationResumeProofFacts = {
  readonly unknownEffectsReconciled: boolean;
  readonly repositoryBound: boolean;
  readonly registeredReleaseSelected: boolean;
  readonly dispatchCapabilityAvailable: boolean;
  readonly safetyDecisionEnabled: boolean;
  readonly activationSafetyDecisionHash: string;
};

type ReviewMutationAuthorityProofBase = {
  readonly proofVersion: ReviewMutationAuthorityProofVersion;
  readonly proofDigest: ReviewMutationAuthorityProofDigest;
  readonly scmRepositoryIdentityId: string;
  readonly laneKind: ReviewMutationLaneKind;
  readonly authorityVersion: number;
  readonly factsVersion: string;
  readonly observedAt: string;
  readonly expiresAt: string;
};

export type ReviewMutationDirectV2InitializationProof =
  ReviewMutationAuthorityProofBase & {
    readonly kind: ReviewMutationAuthorityProofKind.DirectV2Initialize;
    readonly facts: ReviewMutationDirectV2InitializationProofFacts;
  };

export type ReviewMutationAbortProof = ReviewMutationAuthorityProofBase & {
  readonly kind: ReviewMutationAuthorityProofKind.AbortDrain;
  readonly facts: ReviewMutationAbortProofFacts;
};

export type ReviewMutationActivationProof = ReviewMutationAuthorityProofBase & {
  readonly kind: ReviewMutationAuthorityProofKind.Activate;
  readonly facts: ReviewMutationActivationProofFacts;
};

export type ReviewMutationResumeProof = ReviewMutationAuthorityProofBase & {
  readonly kind: ReviewMutationAuthorityProofKind.Resume;
  readonly facts: ReviewMutationResumeProofFacts;
};

export type ReviewMutationAuthorityProof =
  | ReviewMutationDirectV2InitializationProof
  | ReviewMutationAbortProof
  | ReviewMutationActivationProof
  | ReviewMutationResumeProof;

export type ReviewMutationAuthorityProofReference = Readonly<{
  proofVersion: ReviewMutationAuthorityProofVersion;
  proofDigest: ReviewMutationAuthorityProofDigest;
  kind: ReviewMutationAuthorityProofKind;
  scmRepositoryIdentityId: string;
  laneKind: ReviewMutationLaneKind;
  authorityVersion: number;
  observedAt: string;
  expiresAt: string;
}>;

export type UnsealedReviewMutationAuthorityProof =
  | Omit<ReviewMutationDirectV2InitializationProof, "proofDigest">
  | Omit<ReviewMutationAbortProof, "proofDigest">
  | Omit<ReviewMutationActivationProof, "proofDigest">
  | Omit<ReviewMutationResumeProof, "proofDigest">;

export function reviewMutationAuthorityProofCanonicalJson(
  proof: UnsealedReviewMutationAuthorityProof,
): string {
  validateUnsealedProof(proof);
  return canonicalJson({
    proofVersion: proof.proofVersion,
    kind: proof.kind,
    scmRepositoryIdentityId: proof.scmRepositoryIdentityId,
    laneKind: proof.laneKind,
    authorityVersion: proof.authorityVersion,
    factsVersion: proof.factsVersion,
    observedAt: proof.observedAt,
    expiresAt: proof.expiresAt,
    facts: proof.facts,
  });
}

export function sealReviewMutationAuthorityProof(
  proof: Omit<ReviewMutationDirectV2InitializationProof, "proofDigest">,
  proofDigest: string,
): ReviewMutationDirectV2InitializationProof;
export function sealReviewMutationAuthorityProof(
  proof: Omit<ReviewMutationAbortProof, "proofDigest">,
  proofDigest: string,
): ReviewMutationAbortProof;
export function sealReviewMutationAuthorityProof(
  proof: Omit<ReviewMutationActivationProof, "proofDigest">,
  proofDigest: string,
): ReviewMutationActivationProof;
export function sealReviewMutationAuthorityProof(
  proof: Omit<ReviewMutationResumeProof, "proofDigest">,
  proofDigest: string,
): ReviewMutationResumeProof;
export function sealReviewMutationAuthorityProof(
  proof: UnsealedReviewMutationAuthorityProof,
  proofDigest: string,
): ReviewMutationAuthorityProof;
export function sealReviewMutationAuthorityProof(
  proof: UnsealedReviewMutationAuthorityProof,
  proofDigest: string,
): ReviewMutationAuthorityProof {
  validateUnsealedProof(proof);
  assertSha256(proofDigest, "mutation_authority_proof_digest");
  return freezeProof({
    ...proof,
    proofDigest: proofDigest as ReviewMutationAuthorityProofDigest,
  } as ReviewMutationAuthorityProof);
}

export function reviewMutationAuthorityProofReference(
  proof: ReviewMutationAuthorityProof,
): ReviewMutationAuthorityProofReference {
  validateProof(proof);
  return Object.freeze({
    proofVersion: proof.proofVersion,
    proofDigest: proof.proofDigest,
    kind: proof.kind,
    scmRepositoryIdentityId: proof.scmRepositoryIdentityId,
    laneKind: proof.laneKind,
    authorityVersion: proof.authorityVersion,
    observedAt: proof.observedAt,
    expiresAt: proof.expiresAt,
  });
}

export function reviewMutationAuthorityProofBlockers(
  proof: ReviewMutationAuthorityProof,
): readonly ReviewMutationAuthorityProofBlocker[] {
  validateProof(proof);
  const blockers: ReviewMutationAuthorityProofBlocker[] = [];
  switch (proof.kind) {
    case ReviewMutationAuthorityProofKind.DirectV2Initialize:
      if (!proof.facts.freshV2OnlyProvisioningProven) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.FreshProvisioningNotProven,
        );
      }
      if (!proof.facts.noLegacyCapabilityEverIssued) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.LegacyCapabilityPreviouslyIssued,
        );
      }
      if (!proof.facts.workflowInventoryCompatible) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.WorkflowInventoryIncompatible,
        );
      }
      if (!proof.facts.registeredReleaseSelected) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.RegisteredReleaseMissing,
        );
      }
      if (!proof.facts.completionWorkerConfigured) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.CompletionWorkerUnavailable,
        );
      }
      if (proof.facts.executionAuthorityMode === null) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.ExecutionAuthorityUnavailable,
        );
      }
      if (!proof.facts.safetyDecisionEnabled) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.MutationSafetyDisabled,
        );
      }
      break;
    case ReviewMutationAuthorityProofKind.AbortDrain:
      if (!proof.facts.noV2AuthorizationOrMutationExists) {
        blockers.push(ReviewMutationAuthorityProofBlocker.V2ActivityExists);
      }
      break;
    case ReviewMutationAuthorityProofKind.Activate:
      if (!proof.facts.noTrackedLegacyActivity) {
        blockers.push(ReviewMutationAuthorityProofBlocker.LegacyActivityExists);
      }
      if (!proof.facts.workflowInventoryCompatible) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.WorkflowInventoryIncompatible,
        );
      }
      if (!proof.facts.registeredReleaseSelected) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.RegisteredReleaseMissing,
        );
      }
      if (!proof.facts.completionWorkerConfigured) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.CompletionWorkerUnavailable,
        );
      }
      if (!proof.facts.dispatchCapabilityAvailable) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.DispatchCapabilityUnavailable,
        );
      }
      if (!proof.facts.safetyDecisionEnabled) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.MutationSafetyDisabled,
        );
      }
      break;
    case ReviewMutationAuthorityProofKind.Resume:
      if (!proof.facts.unknownEffectsReconciled) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.UnknownEffectsUnreconciled,
        );
      }
      if (!proof.facts.repositoryBound) {
        blockers.push(ReviewMutationAuthorityProofBlocker.RepositoryUnbound);
      }
      if (!proof.facts.registeredReleaseSelected) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.RegisteredReleaseMissing,
        );
      }
      if (!proof.facts.dispatchCapabilityAvailable) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.DispatchCapabilityUnavailable,
        );
      }
      if (!proof.facts.safetyDecisionEnabled) {
        blockers.push(
          ReviewMutationAuthorityProofBlocker.MutationSafetyDisabled,
        );
      }
      break;
  }
  return Object.freeze(blockers);
}

export function requireReadyReviewMutationAuthorityProof(
  proof: ReviewMutationAuthorityProof,
): void {
  const [firstBlocker] = reviewMutationAuthorityProofBlockers(proof);
  if (firstBlocker) {
    throw new ReviewRunControlDomainError(
      ReviewRunControlErrorCode.ProofRequired,
      `mutation_authority_proof_blocked_${firstBlocker}`,
    );
  }
}

export function validateReviewMutationAuthorityProofReference(
  reference: ReviewMutationAuthorityProofReference,
): void {
  if (reference.proofVersion !== ReviewMutationAuthorityProofVersion.V1) {
    invalid("mutation_authority_proof_version_unsupported");
  }
  assertSha256(reference.proofDigest, "mutation_authority_proof_digest");
  assertIdentifier(
    reference.scmRepositoryIdentityId,
    "scm_repository_identity_id",
  );
  if (reference.laneKind !== ReviewMutationLaneKind.HostedReviewRouterApp) {
    invalid("mutation_authority_proof_lane_kind_invalid");
  }
  assertNonNegativeInteger(reference.authorityVersion, "authority_version");
  const observedAt = assertCanonicalTimestamp(
    reference.observedAt,
    "proof_observed_at",
  );
  const expiresAt = assertCanonicalTimestamp(
    reference.expiresAt,
    "proof_expires_at",
  );
  if (expiresAt <= observedAt) {
    invalid("mutation_authority_proof_expiry_invalid");
  }
}

function validateProof(proof: ReviewMutationAuthorityProof): void {
  validateUnsealedProof(proof);
  assertSha256(proof.proofDigest, "mutation_authority_proof_digest");
}

function validateUnsealedProof(proof: UnsealedReviewMutationAuthorityProof) {
  if (proof.proofVersion !== ReviewMutationAuthorityProofVersion.V1) {
    invalid("mutation_authority_proof_version_unsupported");
  }
  assertIdentifier(proof.scmRepositoryIdentityId, "scm_repository_identity_id");
  if (proof.laneKind !== ReviewMutationLaneKind.HostedReviewRouterApp) {
    invalid("mutation_authority_proof_lane_kind_invalid");
  }
  assertNonNegativeInteger(proof.authorityVersion, "authority_version");
  assertIdentifier(proof.factsVersion, "proof_facts_version");
  const observedAt = assertCanonicalTimestamp(
    proof.observedAt,
    "proof_observed_at",
  );
  const expiresAt = assertCanonicalTimestamp(
    proof.expiresAt,
    "proof_expires_at",
  );
  if (expiresAt <= observedAt) {
    invalid("mutation_authority_proof_expiry_invalid");
  }
  switch (proof.kind) {
    case ReviewMutationAuthorityProofKind.DirectV2Initialize:
      assertBoolean(
        proof.facts.freshV2OnlyProvisioningProven,
        "fresh_v2_only_provisioning_proven",
      );
      assertBoolean(
        proof.facts.noLegacyCapabilityEverIssued,
        "no_legacy_capability_ever_issued",
      );
      assertBoolean(
        proof.facts.workflowInventoryCompatible,
        "workflow_inventory_compatible",
      );
      assertBoolean(
        proof.facts.registeredReleaseSelected,
        "registered_release_selected",
      );
      assertBoolean(
        proof.facts.completionWorkerConfigured,
        "completion_worker_configured",
      );
      if (
        proof.facts.executionAuthorityMode !== null &&
        !Object.values(ReviewMutationExecutionAuthorityMode).includes(
          proof.facts.executionAuthorityMode,
        )
      ) {
        invalid("execution_authority_mode_invalid");
      }
      assertSha256(
        proof.facts.managedWorkflowInventoryHash,
        "managed_workflow_inventory_hash",
      );
      assertBoolean(
        proof.facts.safetyDecisionEnabled,
        "safety_decision_enabled",
      );
      assertSha256(
        proof.facts.activationSafetyDecisionHash,
        "activation_safety_decision_hash",
      );
      break;
    case ReviewMutationAuthorityProofKind.AbortDrain:
      assertBoolean(
        proof.facts.noV2AuthorizationOrMutationExists,
        "no_v2_authorization_or_mutation_exists",
      );
      break;
    case ReviewMutationAuthorityProofKind.Activate:
      assertBoolean(
        proof.facts.noTrackedLegacyActivity,
        "no_tracked_legacy_activity",
      );
      assertBoolean(
        proof.facts.workflowInventoryCompatible,
        "workflow_inventory_compatible",
      );
      assertBoolean(
        proof.facts.registeredReleaseSelected,
        "registered_release_selected",
      );
      assertBoolean(
        proof.facts.completionWorkerConfigured,
        "completion_worker_configured",
      );
      assertBoolean(
        proof.facts.dispatchCapabilityAvailable,
        "dispatch_capability_available",
      );
      assertSha256(
        proof.facts.managedWorkflowInventoryHash,
        "managed_workflow_inventory_hash",
      );
      assertBoolean(
        proof.facts.safetyDecisionEnabled,
        "safety_decision_enabled",
      );
      assertSha256(
        proof.facts.activationSafetyDecisionHash,
        "activation_safety_decision_hash",
      );
      break;
    case ReviewMutationAuthorityProofKind.Resume:
      assertBoolean(
        proof.facts.unknownEffectsReconciled,
        "unknown_effects_reconciled",
      );
      assertBoolean(proof.facts.repositoryBound, "repository_bound");
      assertBoolean(
        proof.facts.registeredReleaseSelected,
        "registered_release_selected",
      );
      assertBoolean(
        proof.facts.dispatchCapabilityAvailable,
        "dispatch_capability_available",
      );
      assertBoolean(
        proof.facts.safetyDecisionEnabled,
        "safety_decision_enabled",
      );
      assertSha256(
        proof.facts.activationSafetyDecisionHash,
        "activation_safety_decision_hash",
      );
      break;
    default:
      invalid("mutation_authority_proof_kind_invalid");
  }
}

function freezeProof(
  proof: ReviewMutationAuthorityProof,
): ReviewMutationAuthorityProof {
  return Object.freeze({
    ...proof,
    facts: Object.freeze({ ...proof.facts }),
  }) as ReviewMutationAuthorityProof;
}

function assertBoolean(value: boolean, field: string): void {
  if (typeof value !== "boolean") {
    invalid(`${field}_invalid`);
  }
}

function assertCanonicalTimestamp(value: string, field: string): number {
  if (typeof value !== "string") {
    return invalid(`${field}_invalid`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    return invalid(`${field}_invalid`);
  }
  return epochMs;
}
