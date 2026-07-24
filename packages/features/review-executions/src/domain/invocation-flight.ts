import {
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  assertDate,
  assertIdentifier,
  assertSha256,
  scopeKey,
  type ReviewExecution,
  type ReviewInvocationLease,
  type ReviewWorkSlot,
} from "./review-execution";

export type InvocationFlightIdentity = Readonly<{
  reviewRevisionHash: string;
  providerInvocationKey: string;
  preparedManifestKey: string;
  providerVoteIdentityHash: string;
  compatibilityKey: string;
  policyIdentityHash: string;
}>;

export type InvocationFlight = Readonly<{
  flightId: string;
  identity: InvocationFlightIdentity;
  executionId: string;
  workSlotId: string;
  laneKey: string;
  shardKey: string;
  ownerIdHash: string;
  ownerLeaseId: string;
  fencingToken: bigint;
  acquiredAt: Date;
  renewedAt: Date;
  expiresAt: Date;
}>;

export enum InvocationFlightJoinDecisionStatus {
  Acquire = "acquire",
  Join = "join",
  Busy = "busy",
  CrossRevisionJoinForbidden = "cross_revision_join_forbidden",
  Takeover = "takeover",
}

export function invocationFlightIdentityFrom(input: {
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly providerInvocationKey: string;
  readonly preparedManifestKey: string;
  readonly providerVoteIdentityHash: string;
  readonly policyIdentityHash: string;
}): InvocationFlightIdentity {
  const identity = Object.freeze({
    reviewRevisionHash: input.execution.revision.reviewRevisionHash,
    providerInvocationKey: input.providerInvocationKey,
    preparedManifestKey: input.preparedManifestKey,
    providerVoteIdentityHash: input.providerVoteIdentityHash,
    compatibilityKey: input.execution.compatibilityKey,
    policyIdentityHash: input.policyIdentityHash,
  });
  assertInvocationFlightIdentity(identity);
  if (
    input.slot.providerVoteIdentityHash !== identity.providerVoteIdentityHash
  ) {
    throw new Error("invocation_flight_provider_lane_mismatch");
  }
  return identity;
}

export function restoreInvocationFlight(input: {
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly lease: ReviewInvocationLease;
}): InvocationFlight {
  const { execution, slot, lease } = input;
  if (
    lease.purpose !== ReviewInvocationLeasePurpose.ProviderExecution ||
    lease.state !== ReviewInvocationLeaseState.Active
  ) {
    throw new Error("invocation_flight_owner_lease_not_active");
  }
  if (
    lease.executionId !== execution.executionId ||
    lease.workSlotId !== slot.workSlotId ||
    slot.activeLeaseId !== lease.leaseId ||
    slot.providerVoteIdentityHash !== lease.providerVoteIdentityHash ||
    lease.reviewRevisionHash !== execution.revision.reviewRevisionHash ||
    scopeKey(lease) !== scopeKey(execution) ||
    lease.preparedManifestKey === null
  ) {
    throw new Error("invocation_flight_owner_aggregate_mismatch");
  }
  const identity = invocationFlightIdentityFrom({
    execution,
    slot,
    providerInvocationKey: lease.providerInvocationKey,
    preparedManifestKey: lease.preparedManifestKey,
    providerVoteIdentityHash: lease.providerVoteIdentityHash,
    policyIdentityHash: lease.leaseSafetyDecisionHash,
  });
  return Object.freeze({
    flightId: lease.leaseId,
    identity,
    executionId: execution.executionId,
    workSlotId: slot.workSlotId,
    laneKey: lease.providerVoteIdentityHash,
    shardKey: slot.shardKey,
    ownerIdHash: lease.ownerIdHash,
    ownerLeaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    acquiredAt: new Date(lease.acquiredAt),
    renewedAt: new Date(lease.renewedAt),
    expiresAt: new Date(lease.expiresAt),
  });
}

export function decideInvocationFlightJoin(input: {
  readonly incumbent: InvocationFlight | null;
  readonly requestedIdentity: InvocationFlightIdentity;
  readonly now: Date;
}): InvocationFlightJoinDecisionStatus {
  assertInvocationFlightIdentity(input.requestedIdentity);
  assertDate(input.now, "invocation_flight_decision_time");
  if (input.incumbent === null) {
    return InvocationFlightJoinDecisionStatus.Acquire;
  }
  if (input.incumbent.expiresAt <= input.now) {
    return InvocationFlightJoinDecisionStatus.Takeover;
  }
  if (
    input.incumbent.identity.reviewRevisionHash !==
    input.requestedIdentity.reviewRevisionHash
  ) {
    return InvocationFlightJoinDecisionStatus.CrossRevisionJoinForbidden;
  }
  return invocationFlightIdentitiesEqual(
    input.incumbent.identity,
    input.requestedIdentity,
  )
    ? InvocationFlightJoinDecisionStatus.Join
    : InvocationFlightJoinDecisionStatus.Busy;
}

export function canonicalInvocationFlightIdentity(
  identity: InvocationFlightIdentity,
): string {
  assertInvocationFlightIdentity(identity);
  return [
    "rr.invocation-flight-identity.v1",
    identity.reviewRevisionHash,
    identity.providerInvocationKey,
    identity.preparedManifestKey,
    identity.providerVoteIdentityHash,
    identity.compatibilityKey,
    identity.policyIdentityHash,
  ].join("\0");
}

export function invocationFlightIdentitiesEqual(
  left: InvocationFlightIdentity,
  right: InvocationFlightIdentity,
): boolean {
  return (
    canonicalInvocationFlightIdentity(left) ===
    canonicalInvocationFlightIdentity(right)
  );
}

export function assertInvocationFlightIdentity(
  identity: InvocationFlightIdentity,
): void {
  assertSha256(identity.reviewRevisionHash, "flight_review_revision_hash");
  assertSha256(
    identity.providerInvocationKey,
    "flight_provider_invocation_key",
  );
  assertSha256(identity.preparedManifestKey, "flight_prepared_manifest_key");
  assertSha256(
    identity.providerVoteIdentityHash,
    "flight_provider_vote_identity_hash",
  );
  assertIdentifier(identity.compatibilityKey, "flight_compatibility_key");
  assertSha256(identity.policyIdentityHash, "flight_policy_identity_hash");
}
