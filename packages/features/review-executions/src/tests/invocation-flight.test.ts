import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AcquireOrJoinInvocationFlight,
  AcquireOrJoinInvocationFlightStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseTransitionStatus,
  ReviewTaskKind,
  canonicalInvocationFlightIdentity,
  invocationFlightIdentityFrom,
  type PrepareReviewExecutionCommand,
  type ReviewExecutionLimits,
  type ReviewExecutionScope,
  type ReviewRevision,
} from "../index";
import { InMemoryReviewExecutionStore } from "../testing/index";

const baseTime = new Date("2026-07-24T08:00:00.000Z");
const limits: ReviewExecutionLimits = {
  profileId: "limits-v1",
  maxWorkSlots: 8,
  maxAttemptBudget: 8,
  maxProjectionBytes: 32_000,
  maxFindingCount: 100,
  maxLeaseDurationMs: 60_000,
  maxResultReportDurationMs: 120_000,
};
const scope: ReviewExecutionScope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "connection-1",
  scmRepositoryIdentityId: "repository-1",
  pullRequestNumber: 42,
};
const otherScope: ReviewExecutionScope = {
  ...scope,
  pullRequestNumber: 43,
};
const revision = revisionFixture("a", "b", "c", "d");
const nextRevision = revisionFixture("a", "b", "e", "f");

describe("InvocationFlight singleflight", () => {
  it("joins simultaneous exact-revision requests onto one durable flight", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store, scope, "execution-1", revision);
    const useCase = new AcquireOrJoinInvocationFlight(store, store, store);

    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        useCase.execute(
          leaseCommand({
            index,
            scope,
            executionId: "execution-1",
            now: plus(2),
          }),
        ),
      ),
    );

    expect(
      results.filter(
        (result) =>
          result.status === AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === AcquireOrJoinInvocationFlightStatus.Joined,
      ),
    ).toHaveLength(31);
    expect(new Set(results.map((result) => result.flight?.flightId))).toEqual(
      new Set(["lease-0"]),
    );
    expect(
      (await store.findExecution("execution-1"))?.activeLeases,
    ).toHaveLength(1);
  });

  it("never joins an active flight from another revision", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store, scope, "execution-1", revision);
    await prepareAndAdmit(store, otherScope, "execution-2", nextRevision);
    const useCase = new AcquireOrJoinInvocationFlight(store, store, store);
    const owner = await useCase.execute(
      leaseCommand({
        index: 1,
        scope,
        executionId: "execution-1",
        now: plus(2),
      }),
    );

    const result = await useCase.execute(
      leaseCommand({
        index: 2,
        scope: otherScope,
        executionId: "execution-2",
        now: plus(3),
      }),
    );

    expect(owner.status).toBe(
      AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
    );
    expect(result.status).toBe(
      AcquireOrJoinInvocationFlightStatus.CrossRevisionJoinForbidden,
    );
    expect(
      (await store.findExecution("execution-2"))?.activeLeases,
    ).toHaveLength(0);
  });

  it("does not join when provider or compatibility-policy identity differs", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store, scope, "execution-1", revision);
    const useCase = new AcquireOrJoinInvocationFlight(store, store, store);
    await useCase.execute(
      leaseCommand({
        index: 1,
        scope,
        executionId: "execution-1",
        now: plus(2),
      }),
    );

    const policyMismatch = await useCase.execute({
      ...leaseCommand({
        index: 2,
        scope,
        executionId: "execution-1",
        now: plus(3),
      }),
      leaseSafetyDecisionHash: hash("other-policy"),
    });
    const invocationMismatch = await useCase.execute({
      ...leaseCommand({
        index: 3,
        scope,
        executionId: "execution-1",
        now: plus(3),
      }),
      providerInvocationKey: hash("other-invocation"),
    });

    expect(policyMismatch.status).toBe(
      AcquireOrJoinInvocationFlightStatus.Busy,
    );
    expect(invocationMismatch.status).toBe(
      AcquireOrJoinInvocationFlightStatus.Busy,
    );
    expect(
      (await store.findExecution("execution-1"))?.activeLeases,
    ).toHaveLength(1);
  });

  it("takes over an expired owner with a larger fence and rejects the stale term", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store, scope, "execution-1", revision);
    const useCase = new AcquireOrJoinInvocationFlight(store, store, store);
    const owner = await useCase.execute(
      leaseCommand({
        index: 1,
        scope,
        executionId: "execution-1",
        now: plus(2),
        expiresAt: plus(1_000),
      }),
    );
    const takeover = await useCase.execute(
      leaseCommand({
        index: 2,
        scope,
        executionId: "execution-1",
        now: plus(2_000),
        expiresAt: plus(32_000),
      }),
    );
    const stale = await store.releaseLease({
      leaseId: takeover.flight!.ownerLeaseId,
      ownerIdHash: owner.flight!.ownerIdHash,
      leaseCapabilityId: "capability-1",
      fencingToken: owner.flight!.fencingToken,
      now: plus(2_001),
    });

    expect(takeover.status).toBe(AcquireOrJoinInvocationFlightStatus.TakenOver);
    expect(takeover.flight!.fencingToken).toBeGreaterThan(
      owner.flight!.fencingToken,
    );
    expect(stale.status).toBe(ReviewInvocationLeaseTransitionStatus.StaleTerm);
    expect(
      (
        await store.observeActiveInvocationFlightByLane({
          providerVoteIdentityHash: hash("lane"),
          requestedAt: plus(2_001),
        })
      ).flight,
    ).toMatchObject({
      ownerLeaseId: "lease-2",
      fencingToken: takeover.flight!.fencingToken,
    });
  });

  it("keeps identity independent from work-slot and scheduler shard order", async () => {
    const store = new InMemoryReviewExecutionStore();
    const snapshot = await prepareAndAdmit(
      store,
      scope,
      "execution-1",
      revision,
    );
    const slot = snapshot.execution.workSlots[0]!;
    const first = invocationFlightIdentityFrom({
      execution: snapshot.execution,
      slot,
      providerInvocationKey: hash("invocation"),
      preparedManifestKey: hash("manifest"),
      providerVoteIdentityHash: slot.providerVoteIdentityHash,
      policyIdentityHash: hash("policy"),
    });
    const rescheduled = invocationFlightIdentityFrom({
      execution: snapshot.execution,
      slot: { ...slot, workSlotId: "other-slot", shardKey: "other-shard" },
      providerInvocationKey: hash("invocation"),
      preparedManifestKey: hash("manifest"),
      providerVoteIdentityHash: slot.providerVoteIdentityHash,
      policyIdentityHash: hash("policy"),
    });

    expect(canonicalInvocationFlightIdentity(rescheduled)).toBe(
      canonicalInvocationFlightIdentity(first),
    );
    expect(
      canonicalInvocationFlightIdentity(
        invocationFlightIdentityFrom({
          execution: {
            ...snapshot.execution,
            compatibilityKey: "compatibility-v2",
          },
          slot,
          providerInvocationKey: hash("invocation"),
          preparedManifestKey: hash("manifest"),
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          policyIdentityHash: hash("policy"),
        }),
      ),
    ).not.toBe(canonicalInvocationFlightIdentity(first));
  });
});

async function prepareAndAdmit(
  store: InMemoryReviewExecutionStore,
  requestedScope: ReviewExecutionScope,
  executionId: string,
  requestedRevision: ReviewRevision,
) {
  const prepared = await store.prepareExecution(
    prepareCommand(requestedScope, executionId, requestedRevision),
  );
  const admitted = await store.confirmAdmission({
    scope: requestedScope,
    expectedStreamVersion: prepared.snapshot!.stream.version,
    executionId,
    authorizationId: "authorization-1",
    mutationEpoch: 1n,
    requestedRevision,
    observedRevision: requestedRevision,
    verdict: ReviewExecutionAdmissionVerdict.Current,
    checkedAt: plus(1),
  });
  return admitted.snapshot!;
}

function prepareCommand(
  requestedScope: ReviewExecutionScope,
  executionId: string,
  requestedRevision: ReviewRevision,
): PrepareReviewExecutionCommand {
  return {
    scope: requestedScope,
    expectedStreamVersion: 0n,
    executionId,
    authorizationId: "authorization-1",
    producerReleaseId: "producer-release-1",
    mutationEpoch: 1n,
    revision: requestedRevision,
    startIdentityHash: hash(`start-${executionId}`),
    canonicalStartHash: hash(`canonical-${executionId}`),
    admissionSafetyDecisionHash: hash("admission"),
    compatibilityKey: "compatibility-v1",
    planHash: hash(`plan-${executionId}`),
    workSlots: [
      {
        workSlotId: "slot-1",
        taskKind: ReviewTaskKind.FindingDiscovery,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash("lane"),
        shardKey: `pr-${requestedScope.pullRequestNumber}`,
        required: true,
        attemptBudget: 4,
        retryPolicyVersion: "retry-v1",
      },
    ],
    limits,
    sourceRunId: `run-${executionId}`,
    sourceRunAttempt: "1",
    now: baseTime,
    admissionDeadlineAt: plus(60_000),
    executionDeadlineAt: plus(600_000),
    retainUntil: plus(3_600_000),
  };
}

function leaseCommand(input: {
  readonly index: number;
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly now: Date;
  readonly expiresAt?: Date;
}) {
  return {
    scope: input.scope,
    executionId: input.executionId,
    workSlotId: "slot-1",
    purpose: ReviewInvocationLeasePurpose.ProviderExecution,
    providerInvocationKey: hash("invocation"),
    preparedManifestCanonicalJson: '{"manifestVersion":1}',
    preparedManifestKey: hash("manifest"),
    providerVoteIdentityHash: hash("lane"),
    leaseId: `lease-${input.index}`,
    attemptId: `attempt-${input.index}`,
    sourceObservationId: null,
    acquireRequestIdHash: hash(`request-id-${input.index}`),
    acquireRequestHash: hash(`request-${input.index}`),
    ownerIdHash: `owner-${input.index}`,
    leaseCapabilityId: `capability-${input.index}`,
    capabilitySigningKeyId: "signing-key-1",
    leaseSafetyDecisionHash: hash("policy"),
    now: input.now,
    expiresAt: input.expiresAt ?? new Date(input.now.getTime() + 30_000),
    resultReportUntil: new Date(input.now.getTime() + 60_000),
    retainUntil: plus(300_000),
    limits,
  } as const;
}

function revisionFixture(
  base: string,
  mergeBase: string,
  head: string,
  review: string,
): ReviewRevision {
  return {
    baseSha: base.repeat(40),
    mergeBaseSha: mergeBase.repeat(40),
    headSha: head.repeat(40),
    reviewRevisionHash: review.repeat(64),
  };
}

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function plus(milliseconds: number): Date {
  return new Date(baseTime.getTime() + milliseconds);
}
