import {
  assertDigest,
  assertIdentifier,
  assertPositiveInteger,
  canonicalJson,
  ReviewInvestigationDomainError,
} from "./canonicalization";
import type { ReviewInvestigationRevision } from "./coverage-contract";
import type { ReviewInvestigation } from "./review-investigation";
import { ReviewInvestigationTurnPurpose } from "./review-investigation-types";

export enum ReviewInvestigationLeasePurpose {
  ShadowTurn = "shadow_turn",
}

export enum ReviewInvestigationLeaseState {
  Active = "active",
  Released = "released",
  Expired = "expired",
  Revoked = "revoked",
}

export enum ReviewInvestigationLeaseProtectedOperation {
  ContextGatewayOpen = "context_gateway_open",
  ContextGatewaySeal = "context_gateway_seal",
  TurnCommit = "turn_commit",
  TurnAbort = "turn_abort",
}

export type ReviewInvestigationLease = Readonly<{
  leaseId: string;
  purpose: ReviewInvestigationLeasePurpose;
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  authorizationId: string;
  mutationEpoch: bigint;
  executionId: string;
  workSlotId: string;
  revision: ReviewInvestigationRevision;
  investigationId: string;
  investigationVersion: number;
  turnId: string;
  turnPurpose: ReviewInvestigationTurnPurpose;
  providerVoteLaneId: string;
  providerStrategyId: string;
  investigationManifestCanonicalJson: string;
  investigationManifestHash: string;
  attemptId: string;
  acquireRequestIdHash: string;
  acquireRequestHash: string;
  lastRenewRequestIdHash: string | null;
  lastRenewRequestHash: string | null;
  lastReleaseRequestIdHash: string | null;
  lastReleaseRequestHash: string | null;
  ownerIdHash: string;
  leaseCapabilityId: string;
  capabilitySigningKeyId: string;
  fencingToken: bigint;
  state: ReviewInvestigationLeaseState;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  resultReportUntil: string;
  retainUntil: string;
}>;

export type CreateReviewInvestigationLeaseInput = Omit<
  ReviewInvestigationLease,
  | "purpose"
  | "lastRenewRequestIdHash"
  | "lastRenewRequestHash"
  | "lastReleaseRequestIdHash"
  | "lastReleaseRequestHash"
  | "state"
  | "renewedAt"
>;

export enum ReviewInvestigationLeaseReplayStatus {
  Proceed = "proceed",
  Restored = "restored",
  IdempotencyConflict = "idempotency_conflict",
}

export enum ReviewInvestigationLeaseTransitionStatus {
  Applied = "applied",
  Restored = "restored",
  StaleFence = "stale_fence",
  BindingStale = "binding_stale",
  Expired = "expired",
  InvalidDeadline = "invalid_deadline",
  IdempotencyConflict = "idempotency_conflict",
}

export type ReviewInvestigationLeaseTransitionResult = Readonly<{
  status: ReviewInvestigationLeaseTransitionStatus;
  lease: ReviewInvestigationLease;
}>;

export function createReviewInvestigationLease(
  input: CreateReviewInvestigationLeaseInput,
): ReviewInvestigationLease {
  const lease: ReviewInvestigationLease = Object.freeze({
    ...input,
    purpose: ReviewInvestigationLeasePurpose.ShadowTurn,
    lastRenewRequestIdHash: null,
    lastRenewRequestHash: null,
    lastReleaseRequestIdHash: null,
    lastReleaseRequestHash: null,
    state: ReviewInvestigationLeaseState.Active,
    renewedAt: input.acquiredAt,
  });
  assertReviewInvestigationLease(lease);
  return lease;
}

export function decideReviewInvestigationLeaseReplay(input: {
  readonly existing: ReviewInvestigationLease | null;
  readonly candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">;
}): ReviewInvestigationLeaseReplayStatus {
  if (input.existing === null) {
    return ReviewInvestigationLeaseReplayStatus.Proceed;
  }
  const existing = input.existing;
  return existing.acquireRequestHash === input.candidate.acquireRequestHash &&
    leaseBindingKey(existing) === leaseBindingKey(input.candidate) &&
    existing.ownerIdHash === input.candidate.ownerIdHash
    ? ReviewInvestigationLeaseReplayStatus.Restored
    : ReviewInvestigationLeaseReplayStatus.IdempotencyConflict;
}

export function renewReviewInvestigationLease(input: {
  readonly lease: ReviewInvestigationLease;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
  readonly renewRequestIdHash: string;
  readonly renewRequestHash: string;
  readonly now: string;
  readonly expiresAt: string;
}): ReviewInvestigationLeaseTransitionResult {
  assertDigest(input.renewRequestIdHash, "lease_renew_request_id_hash");
  assertDigest(input.renewRequestHash, "lease_renew_request_hash");
  const nowMs = timestampMs(input.now, "lease_renewed_at");
  const expiresAtMs = timestampMs(input.expiresAt, "lease_expires_at");
  if (!leaseTermMatches(input.lease, input)) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.StaleFence,
      input.lease,
    );
  }
  if (
    input.lease.state !== ReviewInvestigationLeaseState.Active ||
    timestampMs(input.lease.expiresAt, "lease_expires_at") <= nowMs
  ) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.Expired,
      expireReviewInvestigationLease(input.lease),
    );
  }
  if (input.lease.lastRenewRequestIdHash === input.renewRequestIdHash) {
    return transition(
      input.lease.lastRenewRequestHash === input.renewRequestHash
        ? ReviewInvestigationLeaseTransitionStatus.Restored
        : ReviewInvestigationLeaseTransitionStatus.IdempotencyConflict,
      input.lease,
    );
  }
  if (
    expiresAtMs <= timestampMs(input.lease.expiresAt, "lease_expires_at") ||
    expiresAtMs >
      timestampMs(input.lease.resultReportUntil, "lease_result_report_until")
  ) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.InvalidDeadline,
      input.lease,
    );
  }
  return transition(
    ReviewInvestigationLeaseTransitionStatus.Applied,
    Object.freeze({
      ...input.lease,
      lastRenewRequestIdHash: input.renewRequestIdHash,
      lastRenewRequestHash: input.renewRequestHash,
      renewedAt: input.now,
      expiresAt: input.expiresAt,
    }),
  );
}

export function releaseReviewInvestigationLease(input: {
  readonly lease: ReviewInvestigationLease;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
  readonly releaseRequestIdHash: string;
  readonly releaseRequestHash: string;
  readonly now: string;
}): ReviewInvestigationLeaseTransitionResult {
  assertDigest(input.releaseRequestIdHash, "lease_release_request_id_hash");
  assertDigest(input.releaseRequestHash, "lease_release_request_hash");
  const nowMs = timestampMs(input.now, "lease_released_at");
  if (!leaseTermMatches(input.lease, input)) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.StaleFence,
      input.lease,
    );
  }
  if (input.lease.lastReleaseRequestIdHash === input.releaseRequestIdHash) {
    return transition(
      input.lease.lastReleaseRequestHash === input.releaseRequestHash
        ? ReviewInvestigationLeaseTransitionStatus.Restored
        : ReviewInvestigationLeaseTransitionStatus.IdempotencyConflict,
      input.lease,
    );
  }
  if (input.lease.state === ReviewInvestigationLeaseState.Released) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.Restored,
      input.lease,
    );
  }
  if (
    input.lease.state !== ReviewInvestigationLeaseState.Active ||
    timestampMs(input.lease.expiresAt, "lease_expires_at") <= nowMs
  ) {
    return transition(
      ReviewInvestigationLeaseTransitionStatus.Expired,
      expireReviewInvestigationLease(input.lease),
    );
  }
  return transition(
    ReviewInvestigationLeaseTransitionStatus.Applied,
    Object.freeze({
      ...input.lease,
      state: ReviewInvestigationLeaseState.Released,
      lastReleaseRequestIdHash: input.releaseRequestIdHash,
      lastReleaseRequestHash: input.releaseRequestHash,
    }),
  );
}

export function expireReviewInvestigationLease(
  lease: ReviewInvestigationLease,
): ReviewInvestigationLease {
  return lease.state === ReviewInvestigationLeaseState.Active
    ? Object.freeze({
        ...lease,
        state: ReviewInvestigationLeaseState.Expired,
      })
    : lease;
}

export function revokeReviewInvestigationLease(
  lease: ReviewInvestigationLease,
): ReviewInvestigationLease {
  return lease.state === ReviewInvestigationLeaseState.Active
    ? Object.freeze({
        ...lease,
        state: ReviewInvestigationLeaseState.Revoked,
      })
    : lease;
}

export function assertReviewInvestigationLeaseAllows(
  lease: ReviewInvestigationLease,
  operation: ReviewInvestigationLeaseProtectedOperation,
): void {
  assertEnum(
    ReviewInvestigationLeaseProtectedOperation,
    operation,
    "operation",
  );
  if (lease.purpose !== ReviewInvestigationLeasePurpose.ShadowTurn) {
    throw new ReviewInvestigationDomainError("lease_operation_forbidden");
  }
}

export function reviewInvestigationLeaseBindingIsCurrent(
  lease: Pick<
    ReviewInvestigationLease,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "pullRequestNumber"
    | "executionId"
    | "workSlotId"
    | "revision"
    | "investigationId"
    | "investigationVersion"
    | "turnId"
    | "turnPurpose"
    | "providerVoteLaneId"
    | "providerStrategyId"
    | "investigationManifestCanonicalJson"
    | "investigationManifestHash"
  >,
  investigation: ReviewInvestigation,
): boolean {
  const turn = investigation.activeTurn;
  return (
    investigation.investigationId === lease.investigationId &&
    investigation.version === lease.investigationVersion &&
    investigation.scope.workspaceId === lease.workspaceId &&
    investigation.scope.repositoryConnectionId ===
      lease.repositoryConnectionId &&
    investigation.scope.scmRepositoryIdentityId ===
      lease.scmRepositoryIdentityId &&
    investigation.scope.pullRequestNumber === lease.pullRequestNumber &&
    investigation.executionId === lease.executionId &&
    investigation.workSlotId === lease.workSlotId &&
    investigation.revision.baseSha === lease.revision.baseSha &&
    investigation.revision.mergeBaseSha === lease.revision.mergeBaseSha &&
    investigation.revision.headSha === lease.revision.headSha &&
    investigation.revision.reviewRevisionHash ===
      lease.revision.reviewRevisionHash &&
    investigation.providerVoteLaneId === lease.providerVoteLaneId &&
    investigation.providerStrategyId === lease.providerStrategyId &&
    investigation.investigationManifestCanonicalJson ===
      lease.investigationManifestCanonicalJson &&
    investigation.investigationManifestHash ===
      lease.investigationManifestHash &&
    turn?.turnId === lease.turnId &&
    turn.purpose === lease.turnPurpose
  );
}

export function assertReviewInvestigationLease(
  lease: ReviewInvestigationLease,
): void {
  for (const [value, field] of [
    [lease.leaseId, "lease_id"],
    [lease.workspaceId, "lease_workspace_id"],
    [lease.repositoryConnectionId, "lease_repository_connection_id"],
    [lease.scmRepositoryIdentityId, "lease_scm_repository_identity_id"],
    [lease.authorizationId, "lease_authorization_id"],
    [lease.executionId, "lease_execution_id"],
    [lease.workSlotId, "lease_work_slot_id"],
    [lease.investigationId, "lease_investigation_id"],
    [lease.turnId, "lease_turn_id"],
    [lease.providerVoteLaneId, "lease_provider_vote_lane_id"],
    [lease.providerStrategyId, "lease_provider_strategy_id"],
    [lease.attemptId, "lease_attempt_id"],
    [lease.leaseCapabilityId, "lease_capability_id"],
    [lease.capabilitySigningKeyId, "lease_capability_signing_key_id"],
  ] as const) {
    assertIdentifier(value, field);
  }
  for (const [value, field] of [
    [lease.revision.reviewRevisionHash, "lease_review_revision_hash"],
    [lease.investigationManifestHash, "lease_manifest_hash"],
    [lease.acquireRequestIdHash, "lease_acquire_request_id_hash"],
    [lease.acquireRequestHash, "lease_acquire_request_hash"],
    [lease.ownerIdHash, "lease_owner_id_hash"],
  ] as const) {
    assertDigest(value, field);
  }
  assertGitOid(lease.revision.baseSha, "lease_base_sha");
  assertGitOid(lease.revision.mergeBaseSha, "lease_merge_base_sha");
  assertGitOid(lease.revision.headSha, "lease_head_sha");
  assertPositiveInteger(lease.pullRequestNumber, "lease_pull_request_number");
  assertPositiveInteger(
    lease.investigationVersion,
    "lease_investigation_version",
  );
  if (lease.mutationEpoch <= 0n || lease.fencingToken <= 0n) {
    throw new ReviewInvestigationDomainError("lease_term_invalid");
  }
  assertEnum(ReviewInvestigationLeasePurpose, lease.purpose, "purpose");
  assertEnum(ReviewInvestigationLeaseState, lease.state, "state");
  assertEnum(ReviewInvestigationTurnPurpose, lease.turnPurpose, "turn_purpose");
  assertOptionalReplayIdentity(
    lease.lastRenewRequestIdHash,
    lease.lastRenewRequestHash,
    "renew",
  );
  assertOptionalReplayIdentity(
    lease.lastReleaseRequestIdHash,
    lease.lastReleaseRequestHash,
    "release",
  );
  assertCanonicalManifest(lease.investigationManifestCanonicalJson);
  const acquiredAt = timestampMs(lease.acquiredAt, "lease_acquired_at");
  const renewedAt = timestampMs(lease.renewedAt, "lease_renewed_at");
  const expiresAt = timestampMs(lease.expiresAt, "lease_expires_at");
  const resultReportUntil = timestampMs(
    lease.resultReportUntil,
    "lease_result_report_until",
  );
  const retainUntil = timestampMs(lease.retainUntil, "lease_retain_until");
  if (
    renewedAt < acquiredAt ||
    expiresAt <= renewedAt ||
    resultReportUntil < expiresAt ||
    retainUntil <= resultReportUntil
  ) {
    throw new ReviewInvestigationDomainError("lease_deadline_order_invalid");
  }
}

export function leaseBindingKey(
  lease: Pick<
    ReviewInvestigationLease,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "pullRequestNumber"
    | "authorizationId"
    | "mutationEpoch"
    | "executionId"
    | "workSlotId"
    | "revision"
    | "investigationId"
    | "investigationVersion"
    | "turnId"
    | "turnPurpose"
    | "providerVoteLaneId"
    | "providerStrategyId"
    | "investigationManifestCanonicalJson"
    | "investigationManifestHash"
    | "acquireRequestIdHash"
  >,
): string {
  return canonicalJson({
    workspaceId: lease.workspaceId,
    repositoryConnectionId: lease.repositoryConnectionId,
    scmRepositoryIdentityId: lease.scmRepositoryIdentityId,
    pullRequestNumber: lease.pullRequestNumber,
    authorizationId: lease.authorizationId,
    mutationEpoch: lease.mutationEpoch.toString(10),
    executionId: lease.executionId,
    workSlotId: lease.workSlotId,
    revision: lease.revision,
    investigationId: lease.investigationId,
    investigationVersion: lease.investigationVersion,
    turnId: lease.turnId,
    turnPurpose: lease.turnPurpose,
    providerVoteLaneId: lease.providerVoteLaneId,
    providerStrategyId: lease.providerStrategyId,
    investigationManifestCanonicalJson:
      lease.investigationManifestCanonicalJson,
    investigationManifestHash: lease.investigationManifestHash,
    acquireRequestIdHash: lease.acquireRequestIdHash,
  });
}

function leaseTermMatches(
  lease: ReviewInvestigationLease,
  term: Readonly<{
    ownerIdHash: string;
    leaseCapabilityId: string;
    fencingToken: bigint;
  }>,
): boolean {
  return (
    lease.ownerIdHash === term.ownerIdHash &&
    lease.leaseCapabilityId === term.leaseCapabilityId &&
    lease.fencingToken === term.fencingToken
  );
}

function transition(
  status: ReviewInvestigationLeaseTransitionStatus,
  lease: ReviewInvestigationLease,
): ReviewInvestigationLeaseTransitionResult {
  return Object.freeze({ status, lease });
}

function assertOptionalReplayIdentity(
  requestIdHash: string | null,
  requestHash: string | null,
  transitionName: string,
): void {
  if ((requestIdHash === null) !== (requestHash === null)) {
    throw new ReviewInvestigationDomainError(
      `lease_${transitionName}_replay_identity_invalid`,
    );
  }
  if (requestIdHash !== null && requestHash !== null) {
    assertDigest(requestIdHash, `lease_${transitionName}_request_id_hash`);
    assertDigest(requestHash, `lease_${transitionName}_request_hash`);
  }
}

function assertCanonicalManifest(value: string): void {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 262_144
  ) {
    throw new ReviewInvestigationDomainError("lease_manifest_invalid");
  }
  try {
    if (canonicalJson(JSON.parse(value)) !== value) throw new Error();
  } catch {
    throw new ReviewInvestigationDomainError("lease_manifest_not_canonical");
  }
}

function assertGitOid(value: string, field: string): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

function timestampMs(value: string, field: string): number {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
  return date.getTime();
}

function assertEnum<T extends Record<string, string>>(
  values: T,
  value: string,
  field: string,
): void {
  if (!Object.values(values).includes(value)) {
    throw new ReviewInvestigationDomainError(`lease_${field}_invalid`);
  }
}
