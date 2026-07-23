import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ReviewRunControlErrorCode,
  ReviewRunControlDomainError,
  assertDate,
  assertIdentifier,
  assertNonNegativeBigInt,
  assertNonNegativeInteger,
  assertPositiveInteger,
  cloneDate,
  invalid,
} from "./review-run-control-types";
import {
  ReviewMutationAuthorityProofKind,
  requireReadyReviewMutationAuthorityProof,
  type ReviewMutationAbortProof,
  type ReviewMutationActivationProof,
  type ReviewMutationAuthorityProof,
  type ReviewMutationDirectV2InitializationProof,
  type ReviewMutationResumeProof,
} from "./review-mutation-authority-proof";

export type ReviewMutationAuthority = {
  readonly scmRepositoryIdentityId: string;
  readonly laneKind: ReviewMutationLaneKind;
  readonly version: number;
  readonly epoch: bigint;
  readonly mode: ReviewMutationMode;
  readonly drainPolicyVersion: number | null;
  readonly drainStartedAt: Date | null;
  readonly v1AdmissionClosedAt: Date | null;
  readonly drainNotBefore: Date | null;
  readonly managedWorkflowInventoryHash: string | null;
  readonly activationSafetyDecisionHash: string | null;
  readonly initializedAt: Date;
  readonly activatedAt: Date | null;
  readonly pausedAt: Date | null;
};

export enum ReviewMutationTransitionKind {
  Initialized = "initialized",
  Transitioned = "transitioned",
  Idempotent = "idempotent",
}

export type ReviewMutationTransition = {
  readonly kind: ReviewMutationTransitionKind;
  readonly authority: ReviewMutationAuthority;
};

export function initializeReviewMutationAuthority(input: {
  readonly scmRepositoryIdentityId: string;
  readonly initializedAt: Date;
}): ReviewMutationTransition {
  assertIdentifier(input.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertDate(input.initializedAt, "initialized_at");
  return initializedAuthority(
    input.scmRepositoryIdentityId,
    input.initializedAt,
  );
}

export function initializeDirectV2ReviewMutationAuthority(input: {
  readonly scmRepositoryIdentityId: string;
  readonly proof: ReviewMutationDirectV2InitializationProof;
}): ReviewMutationTransition {
  assertIdentifier(input.scmRepositoryIdentityId, "scm_repository_identity_id");
  if (
    input.proof.kind !== ReviewMutationAuthorityProofKind.DirectV2Initialize ||
    input.proof.scmRepositoryIdentityId !== input.scmRepositoryIdentityId ||
    input.proof.laneKind !== ReviewMutationLaneKind.HostedReviewRouterApp ||
    input.proof.authorityVersion !== 0
  ) {
    throw proofRequired("direct_v2_initialization_proof_scope_mismatch");
  }
  requireReadyReviewMutationAuthorityProof(input.proof);
  const initializedAt = new Date(input.proof.observedAt);
  assertDate(initializedAt, "initialized_at");
  return initializedAuthority(
    input.scmRepositoryIdentityId,
    initializedAt,
    input.proof,
  );
}

function initializedAuthority(
  scmRepositoryIdentityId: string,
  initializedAt: Date,
  directV2Proof: ReviewMutationDirectV2InitializationProof | null = null,
): ReviewMutationTransition {
  return {
    kind: ReviewMutationTransitionKind.Initialized,
    authority: {
      scmRepositoryIdentityId,
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      version: 1,
      epoch: directV2Proof ? 1n : 0n,
      mode: directV2Proof
        ? ReviewMutationMode.V2Active
        : ReviewMutationMode.V1Open,
      drainPolicyVersion: null,
      drainStartedAt: null,
      v1AdmissionClosedAt: null,
      drainNotBefore: null,
      managedWorkflowInventoryHash:
        directV2Proof?.facts.managedWorkflowInventoryHash ?? null,
      activationSafetyDecisionHash:
        directV2Proof?.facts.activationSafetyDecisionHash ?? null,
      initializedAt: cloneDate(initializedAt),
      activatedAt: directV2Proof ? cloneDate(initializedAt) : null,
      pausedAt: null,
    },
  };
}

export function beginReviewMutationDrain(
  authority: ReviewMutationAuthority,
  input: {
    readonly expectedVersion: number;
    readonly drainPolicyVersion: number;
    readonly drainWindowMs: number;
    readonly now: Date;
  },
): ReviewMutationTransition {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  assertPositiveInteger(input.drainPolicyVersion, "drain_policy_version");
  assertPositiveInteger(input.drainWindowMs, "drain_window_ms");
  assertDate(input.now, "now");
  const proposedNotBefore = new Date(input.now.getTime() + input.drainWindowMs);
  if (authority.mode === ReviewMutationMode.V1Draining) {
    const currentNotBefore = requiredDate(
      authority.drainNotBefore,
      "drain_not_before_missing",
    );
    if (proposedNotBefore <= currentNotBefore) {
      return idempotent(authority);
    }
    return transitioned(authority, {
      drainPolicyVersion: Math.max(
        authority.drainPolicyVersion ?? 0,
        input.drainPolicyVersion,
      ),
      drainNotBefore: proposedNotBefore,
    });
  }
  assertExpectedVersion(authority, input.expectedVersion);
  requireMode(authority, ReviewMutationMode.V1Open, "begin_drain");
  return transitioned(authority, {
    mode: ReviewMutationMode.V1Draining,
    drainPolicyVersion: input.drainPolicyVersion,
    drainStartedAt: input.now,
    v1AdmissionClosedAt: input.now,
    drainNotBefore: proposedNotBefore,
  });
}

export function abortReviewMutationDrain(
  authority: ReviewMutationAuthority,
  input: {
    readonly expectedVersion: number;
    readonly proof: ReviewMutationAbortProof;
  },
): ReviewMutationTransition {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  requireProofContext(
    authority,
    input.proof,
    ReviewMutationAuthorityProofKind.AbortDrain,
  );
  requireReadyReviewMutationAuthorityProof(input.proof);
  if (authority.mode === ReviewMutationMode.V1Open) {
    return idempotent(authority);
  }
  assertExpectedVersion(authority, input.expectedVersion);
  requireProofAuthorityVersion(input.proof, input.expectedVersion);
  requireMode(authority, ReviewMutationMode.V1Draining, "abort_drain");
  return transitioned(authority, {
    mode: ReviewMutationMode.V1Open,
    drainPolicyVersion: null,
    drainStartedAt: null,
    v1AdmissionClosedAt: null,
    drainNotBefore: null,
  });
}

export function activateReviewMutationEpoch(
  authority: ReviewMutationAuthority,
  input: {
    readonly expectedVersion: number;
    readonly proof: ReviewMutationActivationProof;
  },
): ReviewMutationTransition {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  requireProofContext(
    authority,
    input.proof,
    ReviewMutationAuthorityProofKind.Activate,
  );
  requireReadyReviewMutationAuthorityProof(input.proof);
  const { facts } = input.proof;
  if (authority.mode === ReviewMutationMode.V2Active) {
    if (
      authority.managedWorkflowInventoryHash ===
        facts.managedWorkflowInventoryHash &&
      authority.activationSafetyDecisionHash ===
        facts.activationSafetyDecisionHash
    ) {
      return idempotent(authority);
    }
    throw invalidTransition("activation_already_completed_with_other_proof");
  }
  assertExpectedVersion(authority, input.expectedVersion);
  requireProofAuthorityVersion(input.proof, input.expectedVersion);
  requireMode(authority, ReviewMutationMode.V1Draining, "activate_v2");
  const notBefore = requiredDate(
    authority.drainNotBefore,
    "drain_not_before_missing",
  );
  const proofObservedAt = new Date(input.proof.observedAt);
  if (proofObservedAt < notBefore) {
    throw proofRequired("drain_window_not_elapsed");
  }
  return transitioned(authority, {
    mode: ReviewMutationMode.V2Active,
    epoch: authority.epoch + 1n,
    managedWorkflowInventoryHash: facts.managedWorkflowInventoryHash,
    activationSafetyDecisionHash: facts.activationSafetyDecisionHash,
    activatedAt: proofObservedAt,
    pausedAt: null,
  });
}

export function pauseReviewMutation(
  authority: ReviewMutationAuthority,
  input: { readonly expectedVersion: number; readonly pausedAt: Date },
): ReviewMutationTransition {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  assertDate(input.pausedAt, "paused_at");
  if (authority.mode === ReviewMutationMode.Paused) {
    return idempotent(authority);
  }
  assertExpectedVersion(authority, input.expectedVersion);
  requireMode(authority, ReviewMutationMode.V2Active, "pause_v2");
  return transitioned(authority, {
    mode: ReviewMutationMode.Paused,
    pausedAt: input.pausedAt,
  });
}

export function resumeReviewMutationEpoch(
  authority: ReviewMutationAuthority,
  input: {
    readonly expectedVersion: number;
    readonly proof: ReviewMutationResumeProof;
  },
): ReviewMutationTransition {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  assertNonNegativeInteger(input.expectedVersion, "expected_version");
  requireProofContext(
    authority,
    input.proof,
    ReviewMutationAuthorityProofKind.Resume,
  );
  requireReadyReviewMutationAuthorityProof(input.proof);
  const { facts } = input.proof;
  if (
    authority.mode === ReviewMutationMode.V2Active &&
    authority.activationSafetyDecisionHash ===
      facts.activationSafetyDecisionHash &&
    authority.activatedAt?.getTime() === Date.parse(input.proof.observedAt)
  ) {
    return idempotent(authority);
  }
  assertExpectedVersion(authority, input.expectedVersion);
  requireProofAuthorityVersion(input.proof, input.expectedVersion);
  requireMode(authority, ReviewMutationMode.Paused, "resume_v2");
  return transitioned(authority, {
    mode: ReviewMutationMode.V2Active,
    epoch: authority.epoch + 1n,
    activationSafetyDecisionHash: facts.activationSafetyDecisionHash,
    activatedAt: new Date(input.proof.observedAt),
    pausedAt: null,
  });
}

export function cloneReviewMutationAuthority(
  authority: ReviewMutationAuthority,
): ReviewMutationAuthority {
  assertNonNegativeBigInt(authority.epoch, "mutation_epoch");
  return {
    ...authority,
    drainStartedAt: cloneNullableDate(authority.drainStartedAt),
    v1AdmissionClosedAt: cloneNullableDate(authority.v1AdmissionClosedAt),
    drainNotBefore: cloneNullableDate(authority.drainNotBefore),
    initializedAt: cloneDate(authority.initializedAt),
    activatedAt: cloneNullableDate(authority.activatedAt),
    pausedAt: cloneNullableDate(authority.pausedAt),
  };
}

function transitioned(
  authority: ReviewMutationAuthority,
  patch: Partial<ReviewMutationAuthority>,
): ReviewMutationTransition {
  return {
    kind: ReviewMutationTransitionKind.Transitioned,
    authority: cloneReviewMutationAuthority({
      ...authority,
      ...patch,
      version: authority.version + 1,
    }),
  };
}

function idempotent(
  authority: ReviewMutationAuthority,
): ReviewMutationTransition {
  return {
    kind: ReviewMutationTransitionKind.Idempotent,
    authority: cloneReviewMutationAuthority(authority),
  };
}

function assertExpectedVersion(
  authority: ReviewMutationAuthority,
  expectedVersion: number,
): void {
  assertNonNegativeInteger(expectedVersion, "expected_version");
  if (authority.version !== expectedVersion) {
    throw new ReviewRunControlDomainError(
      ReviewRunControlErrorCode.VersionConflict,
      "mutation_authority_version_conflict",
    );
  }
}

function requireMode(
  authority: ReviewMutationAuthority,
  expected: ReviewMutationMode,
  command: string,
): void {
  if (authority.mode !== expected) {
    throw invalidTransition(`${command}_from_${authority.mode}`);
  }
}

function requireProofContext(
  authority: ReviewMutationAuthority,
  proof: ReviewMutationAuthorityProof,
  expectedKind: ReviewMutationAuthorityProofKind,
): void {
  if (
    proof.kind !== expectedKind ||
    proof.scmRepositoryIdentityId !== authority.scmRepositoryIdentityId ||
    proof.laneKind !== authority.laneKind
  ) {
    throw proofRequired("mutation_authority_proof_scope_mismatch");
  }
}

function requireProofAuthorityVersion(
  proof: ReviewMutationAuthorityProof,
  expectedVersion: number,
): void {
  if (proof.authorityVersion !== expectedVersion) {
    throw proofRequired("mutation_authority_proof_authority_version_mismatch");
  }
}

function requiredDate(value: Date | null, message: string): Date {
  if (!value) {
    return invalid(message);
  }
  return value;
}

function proofRequired(message: string): ReviewRunControlDomainError {
  return new ReviewRunControlDomainError(
    ReviewRunControlErrorCode.ProofRequired,
    message,
  );
}

function invalidTransition(message: string): ReviewRunControlDomainError {
  return new ReviewRunControlDomainError(
    ReviewRunControlErrorCode.InvalidTransition,
    message,
  );
}

function cloneNullableDate(value: Date | null): Date | null {
  return value ? cloneDate(value) : null;
}
