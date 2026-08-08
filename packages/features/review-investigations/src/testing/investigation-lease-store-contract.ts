import { describe, expect, it } from "vitest";
import {
  ReviewInvestigationLeaseState,
  ReviewInvestigationLeaseTransitionStatus,
  type CreateReviewInvestigationLeaseInput,
} from "../domain/investigation-lease";
import {
  InvestigationLeaseAcquireStatus,
  type InvestigationLeaseStorePort,
} from "../application/ports/investigation-lease-store-port";
import { planInvestigationTurn } from "../domain/review-investigation";
import type { ReviewInvestigation } from "../domain/review-investigation";
import { ReviewInvestigationTurnPurpose } from "../domain/review-investigation-types";
import { createInvestigationStoreContractSeed } from "./investigation-store-contract";

export type InvestigationLeaseStoreContractHarness = Readonly<{
  store: InvestigationLeaseStorePort;
  seedBinding(
    candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
  ): Promise<void>;
  restart(): Promise<InvestigationLeaseStorePort>;
  dispose(): Promise<void>;
}>;

export type InvestigationLeaseStoreContractFactory =
  () => Promise<InvestigationLeaseStoreContractHarness>;

export function defineInvestigationLeaseStoreContract(
  name: string,
  factory: InvestigationLeaseStoreContractFactory,
): void {
  describe(`${name} InvestigationLeaseStorePort contract`, () => {
    it("restores exact acquisition, rejects conflicts, and survives restart", async () => {
      const harness = await factory();
      try {
        const candidate =
          createInvestigationLeaseStoreContractCandidate("restart");
        await harness.seedBinding(candidate);
        const acquired = await harness.store.acquireLease(candidate);
        expect(acquired).toMatchObject({
          status: InvestigationLeaseAcquireStatus.Acquired,
        });
        expect(acquired.lease!.fencingToken).toBeGreaterThan(0n);
        await expect(
          harness.store.acquireLease({
            ...candidate,
            leaseId: `${candidate.leaseId}-retry-generated`,
            attemptId: `${candidate.attemptId}-retry-generated`,
            leaseCapabilityId: `${candidate.leaseCapabilityId}-retry-generated`,
            capabilitySigningKeyId: "signing-key-retry-generated",
            acquiredAt: "2026-08-05T10:00:01.000Z",
            expiresAt: "2026-08-05T10:01:01.000Z",
          }),
        ).resolves.toMatchObject({
          status: InvestigationLeaseAcquireStatus.Restored,
          lease: {
            leaseId: candidate.leaseId,
            fencingToken: acquired.lease!.fencingToken,
          },
        });
        await expect(
          harness.store.acquireLease({
            ...candidate,
            acquireRequestHash: digest("conflicting-acquire"),
          }),
        ).resolves.toEqual({
          status: InvestigationLeaseAcquireStatus.IdempotencyConflict,
          lease: null,
        });
        const restarted = await harness.restart();
        await expect(restarted.findLease(candidate.leaseId)).resolves.toEqual(
          acquired.lease,
        );
      } finally {
        await harness.dispose();
      }
    });

    it("fences takeover and makes renew/release request identities idempotent", async () => {
      const harness = await factory();
      try {
        const candidate =
          createInvestigationLeaseStoreContractCandidate("term");
        await harness.seedBinding(candidate);
        const first = (await harness.store.acquireLease(candidate)).lease!;
        const secondCandidate = {
          ...createInvestigationLeaseStoreContractCandidate("term"),
          leaseId: "lease-term-second",
          attemptId: "attempt-term-second",
          leaseCapabilityId: "capability-term-second",
          acquireRequestIdHash: digest("acquire-term-second"),
          acquireRequestHash: digest("request-term-second"),
          acquiredAt: "2026-08-05T10:01:01.000Z",
          expiresAt: "2026-08-05T10:02:00.000Z",
        };
        const takeover = await harness.store.acquireLease(secondCandidate);
        expect(takeover).toMatchObject({
          status: InvestigationLeaseAcquireStatus.Acquired,
          lease: { fencingToken: first.fencingToken + 1n },
        });
        await expect(
          harness.store.findLease(first.leaseId),
        ).resolves.toMatchObject({
          state: ReviewInvestigationLeaseState.Expired,
        });
        const staleRelease = await harness.store.releaseLease({
          leaseId: takeover.lease!.leaseId,
          ownerIdHash: takeover.lease!.ownerIdHash,
          leaseCapabilityId: takeover.lease!.leaseCapabilityId,
          fencingToken: first.fencingToken,
          releaseRequestIdHash: digest("release-stale"),
          releaseRequestHash: digest("release-stale-request"),
          now: "2026-08-05T10:01:10.000Z",
        });
        expect(staleRelease?.status).toBe(
          ReviewInvestigationLeaseTransitionStatus.StaleFence,
        );
        const renewal = {
          leaseId: takeover.lease!.leaseId,
          ownerIdHash: takeover.lease!.ownerIdHash,
          leaseCapabilityId: takeover.lease!.leaseCapabilityId,
          fencingToken: takeover.lease!.fencingToken,
          renewRequestIdHash: digest("renew-term"),
          renewRequestHash: digest("renew-term-request"),
          now: "2026-08-05T10:01:10.000Z",
          expiresAt: "2026-08-05T10:02:30.000Z",
        };
        await expect(harness.store.renewLease(renewal)).resolves.toMatchObject({
          status: ReviewInvestigationLeaseTransitionStatus.Applied,
        });
        await expect(harness.store.renewLease(renewal)).resolves.toMatchObject({
          status: ReviewInvestigationLeaseTransitionStatus.Restored,
        });
        const release = {
          leaseId: takeover.lease!.leaseId,
          ownerIdHash: takeover.lease!.ownerIdHash,
          leaseCapabilityId: takeover.lease!.leaseCapabilityId,
          fencingToken: takeover.lease!.fencingToken,
          releaseRequestIdHash: digest("release-term"),
          releaseRequestHash: digest("release-term-request"),
          now: "2026-08-05T10:01:20.000Z",
        };
        await expect(
          harness.store.releaseLease(release),
        ).resolves.toMatchObject({
          status: ReviewInvestigationLeaseTransitionStatus.Applied,
          lease: { state: ReviewInvestigationLeaseState.Released },
        });
        await expect(
          harness.store.releaseLease(release),
        ).resolves.toMatchObject({
          status: ReviewInvestigationLeaseTransitionStatus.Restored,
        });
        await expect(
          harness.store.acquireLease(secondCandidate),
        ).resolves.toEqual({
          status: InvestigationLeaseAcquireStatus.IdempotencyConflict,
          lease: null,
        });
        await expect(
          harness.store.acquireLease({
            ...secondCandidate,
            leaseId: "lease-term-recovery",
            attemptId: "attempt-term-recovery",
            leaseCapabilityId: "capability-term-recovery",
            acquireRequestIdHash: digest("acquire-term-recovery"),
            acquireRequestHash: digest("request-term-recovery"),
            acquiredAt: "2026-08-05T10:01:21.000Z",
            expiresAt: "2026-08-05T10:02:20.000Z",
          }),
        ).resolves.toMatchObject({
          status: InvestigationLeaseAcquireStatus.Acquired,
          lease: { fencingToken: takeover.lease!.fencingToken + 1n },
        });
      } finally {
        await harness.dispose();
      }
    });
  });
}

export function createInvestigationLeaseStoreContractCandidate(
  suffix: string,
): Omit<CreateReviewInvestigationLeaseInput, "fencingToken"> {
  return {
    leaseId: `lease-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    repositoryConnectionId: `connection-${suffix}`,
    scmRepositoryIdentityId: `repository-${suffix}`,
    pullRequestNumber: 42,
    authorizationId: `authorization-${suffix}`,
    mutationEpoch: 1n,
    executionId: `execution-${suffix}`,
    workSlotId: `slot-${suffix}`,
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: digest(`revision-${suffix}`),
    },
    investigationId: `investigation-${suffix}`,
    investigationVersion: 2,
    turnId: `turn-${suffix}`,
    turnPurpose: ReviewInvestigationTurnPurpose.Discovery,
    providerVoteLaneId: `lane-${suffix}`,
    providerStrategyId: `strategy-${suffix}`,
    investigationManifestCanonicalJson: '{"manifestVersion":1}',
    investigationManifestHash: digest(`manifest-${suffix}`),
    attemptId: `attempt-${suffix}`,
    acquireRequestIdHash: digest(`acquire-${suffix}`),
    acquireRequestHash: digest(`request-${suffix}`),
    ownerIdHash: digest(`owner-${suffix}`),
    leaseCapabilityId: `capability-${suffix}`,
    capabilitySigningKeyId: "signing-key-1",
    acquiredAt: "2026-08-05T10:00:00.000Z",
    expiresAt: "2026-08-05T10:01:00.000Z",
    resultReportUntil: "2026-08-05T10:05:00.000Z",
    retainUntil: "2026-09-05T10:05:00.000Z",
  };
}

export function createInvestigationLeaseBindingSeed(
  candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
  options: Readonly<{ trustDomain?: string }> = {},
): Readonly<{ base: ReviewInvestigation; planned: ReviewInvestigation }> {
  const fixture = createInvestigationStoreContractSeed(
    `lease-${candidate.investigationId}`,
    options,
  );
  const base: ReviewInvestigation = {
    ...fixture,
    investigationId: candidate.investigationId,
    scope: {
      ...fixture.scope,
      workspaceId: candidate.workspaceId,
      repositoryConnectionId: candidate.repositoryConnectionId,
      scmRepositoryIdentityId: candidate.scmRepositoryIdentityId,
      pullRequestNumber: candidate.pullRequestNumber,
    },
    revision: { ...candidate.revision },
    executionId: candidate.executionId,
    workSlotId: candidate.workSlotId,
    providerVoteLaneId: candidate.providerVoteLaneId,
    providerStrategyId: candidate.providerStrategyId,
    investigationManifestCanonicalJson:
      candidate.investigationManifestCanonicalJson,
    investigationManifestHash: candidate.investigationManifestHash,
  };
  const planned = planInvestigationTurn({
    investigation: base,
    turn: {
      turnId: candidate.turnId,
      purpose: candidate.turnPurpose,
      leasedAtVersion: candidate.investigationVersion,
      dossierDigest: base.dossierDigest,
      obligationIds: base.obligations.map((item) => item.obligationId),
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: candidate.acquiredAt,
      expiresAt: candidate.resultReportUntil,
    },
  });
  return Object.freeze({ base, planned });
}

function digest(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
