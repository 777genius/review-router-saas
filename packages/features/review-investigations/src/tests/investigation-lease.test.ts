import { describe, expect, it } from "vitest";
import {
  createReviewInvestigationLease,
  releaseReviewInvestigationLease,
  renewReviewInvestigationLease,
  ReviewInvestigationLeaseProtectedOperation,
  ReviewInvestigationLeaseState,
  ReviewInvestigationLeaseTransitionStatus,
  assertReviewInvestigationLeaseAllows,
} from "../domain/investigation-lease";
import { ReviewInvestigationTurnPurpose } from "../domain/review-investigation-types";

describe("review investigation lease", () => {
  it("binds the complete shadow turn identity and only permits scoped operations", () => {
    const lease = activeLease();
    expect(lease).toMatchObject({
      investigationId: "investigation-1",
      investigationVersion: 2,
      turnId: "turn-1",
      providerStrategyId: "provider-strategy-1",
      state: ReviewInvestigationLeaseState.Active,
    });
    for (const operation of Object.values(
      ReviewInvestigationLeaseProtectedOperation,
    )) {
      expect(() =>
        assertReviewInvestigationLeaseAllows(lease, operation),
      ).not.toThrow();
    }
  });

  it("rejects stale fencing and conflicting renewal/release replay identities", () => {
    const lease = activeLease();
    expect(
      renewReviewInvestigationLease({
        lease,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: 2n,
        renewRequestIdHash: digest("renew-stale"),
        renewRequestHash: digest("renew-stale-request"),
        now: "2026-08-05T10:00:30.000Z",
        expiresAt: "2026-08-05T10:03:00.000Z",
      }).status,
    ).toBe(ReviewInvestigationLeaseTransitionStatus.StaleFence);

    const released = releaseReviewInvestigationLease({
      lease,
      ownerIdHash: lease.ownerIdHash,
      leaseCapabilityId: lease.leaseCapabilityId,
      fencingToken: lease.fencingToken,
      releaseRequestIdHash: digest("release-1"),
      releaseRequestHash: digest("release-request-1"),
      now: "2026-08-05T10:00:30.000Z",
    });
    expect(released).toMatchObject({
      status: ReviewInvestigationLeaseTransitionStatus.Applied,
      lease: { state: ReviewInvestigationLeaseState.Released },
    });
    expect(
      releaseReviewInvestigationLease({
        lease: released.lease,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: lease.fencingToken,
        releaseRequestIdHash: digest("release-1"),
        releaseRequestHash: digest("release-request-conflict"),
        now: "2026-08-05T10:00:31.000Z",
      }).status,
    ).toBe(ReviewInvestigationLeaseTransitionStatus.IdempotencyConflict);
  });

  it("never restores an exact renewal after the ownership window expired", () => {
    const lease = activeLease();
    const renewal = {
      ownerIdHash: lease.ownerIdHash,
      leaseCapabilityId: lease.leaseCapabilityId,
      fencingToken: lease.fencingToken,
      renewRequestIdHash: digest("renew-expiry"),
      renewRequestHash: digest("renew-expiry-request"),
      now: "2026-08-05T10:00:30.000Z",
      expiresAt: "2026-08-05T10:03:00.000Z",
    };
    const renewed = renewReviewInvestigationLease({ lease, ...renewal });
    expect(renewed.status).toBe(
      ReviewInvestigationLeaseTransitionStatus.Applied,
    );
    const replayAfterExpiry = renewReviewInvestigationLease({
      lease: renewed.lease,
      ...renewal,
      now: "2026-08-05T10:03:00.000Z",
    });
    expect(replayAfterExpiry).toMatchObject({
      status: ReviewInvestigationLeaseTransitionStatus.Expired,
      lease: { state: ReviewInvestigationLeaseState.Expired },
    });
  });
});

function activeLease() {
  return createReviewInvestigationLease({
    leaseId: "lease-1",
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 42,
    authorizationId: "authorization-1",
    mutationEpoch: 1n,
    executionId: "execution-1",
    workSlotId: "slot-1",
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: digest("revision-1"),
    },
    investigationId: "investigation-1",
    investigationVersion: 2,
    turnId: "turn-1",
    turnPurpose: ReviewInvestigationTurnPurpose.Discovery,
    providerVoteLaneId: "provider-lane-1",
    providerStrategyId: "provider-strategy-1",
    investigationManifestCanonicalJson: '{"manifestVersion":1}',
    investigationManifestHash: digest("manifest-1"),
    attemptId: "attempt-1",
    acquireRequestIdHash: digest("acquire-1"),
    acquireRequestHash: digest("acquire-request-1"),
    ownerIdHash: digest("owner-1"),
    leaseCapabilityId: "capability-1",
    capabilitySigningKeyId: "signing-key-1",
    fencingToken: 1n,
    acquiredAt: "2026-08-05T10:00:00.000Z",
    expiresAt: "2026-08-05T10:01:00.000Z",
    resultReportUntil: "2026-08-05T10:05:00.000Z",
    retainUntil: "2026-09-05T10:05:00.000Z",
  });
}

function digest(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
