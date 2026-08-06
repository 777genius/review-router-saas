import { describe, expect, it } from "vitest";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  createReviewInvestigationLease,
  ReviewInvestigationTurnPurpose,
} from "@reviewrouter/features-review-investigations";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import { ReviewActionV2InvestigationLeaseCapabilityAdapter } from "./review-action-v2-investigation-lease-capabilities.js";

describe("ReviewActionV2InvestigationLeaseCapabilityAdapter", () => {
  it("round-trips the complete shadow lease authority", async () => {
    const { adapter } = fixture();
    const lease = shadowLease();
    const token = await adapter.issue(lease, hash("scope"));

    await expect(
      adapter.verify(token, new Date("2026-08-05T10:00:30.000Z")),
    ).resolves.toMatchObject({
      capabilityId: lease.leaseCapabilityId,
      leaseId: lease.leaseId,
      attemptId: lease.attemptId,
      investigationId: lease.investigationId,
      investigationVersion: lease.investigationVersion,
      turnId: lease.turnId,
      providerStrategyId: lease.providerStrategyId,
      investigationManifestHash: lease.investigationManifestHash,
      fencingToken: lease.fencingToken,
    });
  });

  it("is rejected by standard lease and publication verifiers", async () => {
    const { adapter, standard } = fixture();
    const token = await adapter.issue(shadowLease(), hash("scope"));
    const now = new Date("2026-08-05T10:00:30.000Z");

    await expect(standard.verifyLease(token, now)).rejects.toThrow();
    await expect(
      standard.verifyPublicationPermit(token, now),
    ).rejects.toThrow();
  });
});

function fixture() {
  const keyRing = new ConfiguredCapabilityKeyRing({
    activeKeyId: "shadow-key",
    keys: [
      {
        keyId: "shadow-key",
        secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
        verifyUntil: null,
      },
    ],
  });
  const codec = new JoseRotatingCapabilityCodec(keyRing, 0);
  const issuer = "reviewrouter-investigation-shadow-test";
  return {
    adapter: new ReviewActionV2InvestigationLeaseCapabilityAdapter(
      codec,
      keyRing,
      issuer,
      () => "shadow-capability-generated",
    ),
    standard: new ReviewActionV2ExecutionEvidenceCapabilityAdapter(
      codec,
      keyRing,
      issuer,
      () => "standard-capability-generated",
    ),
  };
}

function shadowLease() {
  return createReviewInvestigationLease({
    leaseId: "shadow-lease-1",
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 46,
    authorizationId: "authorization-1",
    mutationEpoch: 1n,
    executionId: "execution-1",
    workSlotId: "slot-1",
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: hash("revision"),
    },
    investigationId: "investigation-1",
    investigationVersion: 2,
    turnId: "turn-1",
    turnPurpose: ReviewInvestigationTurnPurpose.Discovery,
    providerVoteLaneId: "lane-1",
    providerStrategyId: hash("strategy"),
    investigationManifestCanonicalJson: "{}",
    investigationManifestHash: hash("manifest"),
    attemptId: "attempt-1",
    acquireRequestIdHash: hash("acquire-id"),
    acquireRequestHash: hash("acquire"),
    ownerIdHash: hash("owner"),
    leaseCapabilityId: "lease-capability-1",
    capabilitySigningKeyId: "shadow-key",
    fencingToken: 7n,
    acquiredAt: "2026-08-05T10:00:00.000Z",
    expiresAt: "2026-08-05T10:01:00.000Z",
    resultReportUntil: "2026-08-05T10:05:00.000Z",
    retainUntil: "2026-09-05T10:05:00.000Z",
  });
}

function hash(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
