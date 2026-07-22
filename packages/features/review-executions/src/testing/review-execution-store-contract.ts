import { beforeEach, describe, expect, it } from "vitest";
import {
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionPrepareStatus,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentStatus,
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  type ReviewExecutionCommandPort,
  type ReviewExecutionQueryPort,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../index";
import {
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewTaskKind,
  type ReviewExecutionLimits,
  type ReviewExecutionScope,
  type ReviewRevision,
} from "../domain/review-execution";
import {
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
} from "../domain/review-requested-intent";

export type ReviewExecutionStoreContractHarness = Readonly<{
  executions: ReviewExecutionQueryPort & ReviewExecutionCommandPort;
  requestedIntents: ReviewRequestedIntentQueryPort &
    ReviewRequestedIntentCommandPort;
  scope: ReviewExecutionScope;
  authorizationId: string;
  producerReleaseId: string;
  ensureObservation: (input: {
    readonly observationId: string;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly fencingToken: bigint;
    readonly providerInvocationKey: string;
    readonly providerVoteIdentityHash: string;
    readonly payloadHash: string;
    readonly createdAt: Date;
  }) => Promise<void>;
}>;

export type ReviewExecutionStoreContractFactory =
  () => Promise<ReviewExecutionStoreContractHarness>;

export function runReviewExecutionStoreContract(
  label: string,
  createHarness: ReviewExecutionStoreContractFactory,
): void {
  describe(`${label} review execution store contract`, () => {
    let harness: ReviewExecutionStoreContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    it("restores prepare identity and preserves canonical work-slot order", async () => {
      const command = prepareCommand(harness, "prepare-order", [
        workSlot("slot-z", 1),
        workSlot("slot-a", 2),
      ]);
      const prepared = await harness.executions.prepareExecution(command);
      expect(prepared.status).toBe(ReviewExecutionPrepareStatus.Prepared);
      expect(
        prepared.snapshot?.execution.workSlots.map((slot) => slot.workSlotId),
      ).toEqual(["slot-z", "slot-a"]);

      const restored = await harness.executions.prepareExecution(command);
      expect(restored.status).toBe(ReviewExecutionPrepareStatus.Restored);
      expect(restored.snapshot?.execution.generation).toBe(1n);

      const conflict = await harness.executions.prepareExecution({
        ...command,
        canonicalStartHash: hash(15),
      });
      expect(conflict.status).toBe(
        ReviewExecutionPrepareStatus.IdempotencyConflict,
      );
    });

    it("keeps active execution alive until prepared admission is confirmed", async () => {
      const first = await prepareAndAdmit(harness, "active-first");
      const secondCommand = prepareCommand(
        harness,
        "active-second",
        [workSlot("slot-second", 3)],
        first.snapshot.stream.version,
      );
      const second = await harness.executions.prepareExecution(secondCommand);
      expect(second.status).toBe(ReviewExecutionPrepareStatus.Prepared);
      expect(second.snapshot?.stream.activeExecutionId).toBe(
        first.snapshot.execution.executionId,
      );

      const admitted = await harness.executions.confirmAdmission({
        scope: harness.scope,
        expectedStreamVersion: second.snapshot!.stream.version,
        executionId: second.snapshot!.execution.executionId,
        authorizationId: harness.authorizationId,
        mutationEpoch: 1n,
        requestedRevision: revision,
        observedRevision: revision,
        verdict: ReviewExecutionAdmissionVerdict.Current,
        checkedAt: new Date(),
      });
      expect(admitted.status).toBe(ReviewExecutionAdmissionStatus.Admitted);
      expect(
        (
          await harness.executions.findExecution(
            first.snapshot.execution.executionId,
          )
        )?.execution.state,
      ).toBe(ReviewExecutionState.Superseded);
    });

    it("restores lost lease acknowledgements without consuming another attempt", async () => {
      const running = await prepareAndAdmit(harness, "lease-replay");
      const command = leaseCommand(harness, running.snapshot, "lease-replay");
      const acquired = await harness.executions.acquireLease(command);
      expect(acquired.status).toBe(ReviewInvocationLeaseAcquireStatus.Acquired);
      expect(acquired.lease?.attemptOrdinal).toBe(1);

      const restored = await harness.executions.acquireLease(command);
      expect(restored.status).toBe(ReviewInvocationLeaseAcquireStatus.Restored);
      expect(restored.lease?.fencingToken).toBe(acquired.lease?.fencingToken);
      expect(
        (
          await harness.executions.findExecution(
            running.snapshot.execution.executionId,
          )
        )?.execution.workSlots[0]?.nextAttemptOrdinal,
      ).toBe(2);
    });

    it("uses exact lease fencing for renew and release", async () => {
      const running = await prepareAndAdmit(harness, "lease-transition");
      const acquired = await harness.executions.acquireLease(
        leaseCommand(harness, running.snapshot, "lease-transition"),
      );
      const lease = acquired.lease!;
      const renewedAt = new Date();
      const renewedExpiresAt = new Date(renewedAt.getTime() + 45_000);
      const renewedResultReportUntil = new Date(renewedAt.getTime() + 90_000);
      const renewed = await harness.executions.renewLease({
        leaseId: lease.leaseId,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: lease.fencingToken,
        now: renewedAt,
        expiresAt: renewedExpiresAt,
        resultReportUntil: renewedResultReportUntil,
        limits,
      });
      expect(renewed.status).toBe(
        ReviewInvocationLeaseTransitionStatus.Applied,
      );
      expect(renewed.lease?.fencingToken).toBe(lease.fencingToken);
      expect(renewed.lease).toMatchObject({
        leaseCapabilityId: lease.leaseCapabilityId,
        capabilitySigningKeyId: lease.capabilitySigningKeyId,
      });
      expect(renewed.lease!.expiresAt.getTime()).toBeGreaterThan(
        lease.expiresAt.getTime(),
      );
      expect(
        renewed.lease!.resultReportUntil.getTime() -
          renewed.lease!.expiresAt.getTime(),
      ).toBe(45_000);

      await expect(
        harness.executions.releaseLease({
          leaseId: lease.leaseId,
          ownerIdHash: lease.ownerIdHash,
          leaseCapabilityId: lease.leaseCapabilityId,
          fencingToken: lease.fencingToken + 1n,
          now: new Date(),
        }),
      ).resolves.toEqual({
        status: ReviewInvocationLeaseTransitionStatus.StaleTerm,
      });
      const released = await harness.executions.releaseLease({
        leaseId: lease.leaseId,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: lease.fencingToken,
        now: new Date(),
      });
      expect(released.status).toBe(
        ReviewInvocationLeaseTransitionStatus.Applied,
      );
      expect(released.lease?.state).toBe(ReviewInvocationLeaseState.Released);
    });

    it("atomically attaches an observation and closes its current lease", async () => {
      const running = await prepareAndAdmit(harness, "attach");
      const acquired = await harness.executions.acquireLease(
        leaseCommand(harness, running.snapshot, "attach"),
      );
      const lease = acquired.lease!;
      const observationId = "observation-attach";
      const payloadHash = hash(10);
      await harness.ensureObservation({
        observationId,
        executionId: lease.executionId,
        workSlotId: lease.workSlotId,
        attemptId: lease.attemptId!,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        providerInvocationKey: lease.providerInvocationKey,
        providerVoteIdentityHash:
          running.snapshot.execution.workSlots[0]!.providerVoteIdentityHash,
        payloadHash,
        createdAt: new Date(),
      });
      const command = {
        scope: harness.scope,
        executionId: lease.executionId,
        workSlotId: lease.workSlotId,
        observationRefId: "observation-ref-attach",
        observationId,
        providerInvocationKey: lease.providerInvocationKey,
        providerVoteIdentityHash:
          running.snapshot.execution.workSlots[0]!.providerVoteIdentityHash,
        payloadHash,
        byteCount: 2,
        findingCount: 0,
        eligibilityPolicyVersion: "eligibility-v1",
        leaseId: lease.leaseId,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: lease.fencingToken,
        now: new Date(),
      } as const;
      const attached = await harness.executions.attachObservation(command);
      expect(attached.status).toBe(ReviewObservationAttachmentStatus.Attached);
      expect(attached.snapshot?.execution.workSlots[0]).toMatchObject({
        state: "satisfied",
        activeLeaseId: null,
        acceptedObservationRefId: command.observationRefId,
      });
      expect(await harness.executions.attachObservation(command)).toMatchObject(
        { status: ReviewObservationAttachmentStatus.Restored },
      );
    });

    it("adopts a reported observation without consuming another attempt", async () => {
      const running = await prepareAndAdmit(harness, "adopt");
      const acquired = await harness.executions.acquireLease(
        leaseCommand(harness, running.snapshot, "adopt"),
      );
      const sourceLease = acquired.lease!;
      const sourceObservationId = "observation-adopt";
      const payloadHash = hash(9);
      await harness.ensureObservation({
        observationId: sourceObservationId,
        executionId: sourceLease.executionId,
        workSlotId: sourceLease.workSlotId,
        attemptId: sourceLease.attemptId!,
        leaseId: sourceLease.leaseId,
        fencingToken: sourceLease.fencingToken,
        providerInvocationKey: sourceLease.providerInvocationKey,
        providerVoteIdentityHash:
          running.snapshot.execution.workSlots[0]!.providerVoteIdentityHash,
        payloadHash,
        createdAt: new Date(),
      });
      const released = await harness.executions.releaseLease({
        leaseId: sourceLease.leaseId,
        ownerIdHash: sourceLease.ownerIdHash,
        leaseCapabilityId: sourceLease.leaseCapabilityId,
        fencingToken: sourceLease.fencingToken,
        now: new Date(),
      });
      expect(released.status).toBe(
        ReviewInvocationLeaseTransitionStatus.Applied,
      );

      const adopted = await harness.executions.adoptObservation({
        scope: harness.scope,
        executionId: sourceLease.executionId,
        workSlotId: sourceLease.workSlotId,
        sourceLeaseId: sourceLease.leaseId,
        sourceFencingToken: sourceLease.fencingToken,
        sourceObservationId,
        observationRefId: "observation-ref-adopt",
        providerInvocationKey: sourceLease.providerInvocationKey,
        providerVoteIdentityHash:
          running.snapshot.execution.workSlots[0]!.providerVoteIdentityHash,
        payloadHash,
        byteCount: 2,
        findingCount: 0,
        eligibilityPolicyVersion: "eligibility-v1",
        adoptionLeaseId: "lease-adopt-observation",
        adoptionAcquireRequestIdHash: hash(10),
        adoptionAcquireRequestHash: hash(11),
        ownerIdHash: "owner-adopt-observation",
        leaseCapabilityId: "capability-adopt-observation",
        capabilitySigningKeyId: "signing-key-v1",
        leaseSafetyDecisionHash: hash(12),
        now: new Date(),
        retainUntil: new Date(Date.now() + 86_400_000),
      });
      expect(adopted.status).toBe(ReviewObservationAttachmentStatus.Attached);
      expect(adopted.snapshot?.execution.workSlots[0]).toMatchObject({
        state: "satisfied",
        nextAttemptOrdinal: 2,
        activeLeaseId: null,
        acceptedObservationRefId: "observation-ref-adopt",
      });
      await expect(
        harness.executions.findLease("lease-adopt-observation"),
      ).resolves.toMatchObject({
        purpose: ReviewInvocationLeasePurpose.ObservationAdoption,
        state: ReviewInvocationLeaseState.Released,
        attemptId: null,
        attemptOrdinal: 1,
      });
    });

    it("persists exact artifact bytes and restores only the same artifact hash", async () => {
      const running = await prepareAndAdmit(harness, "finalize");
      const envelope = '{  "findings": [] }';
      const command = {
        scope: harness.scope,
        executionId: running.snapshot.execution.executionId,
        expectedStreamVersion: running.snapshot.stream.version,
        expectedExecutionVersion: running.snapshot.execution.version,
        artifactId: "artifact-finalize",
        artifactHash: hash(11),
        projectionEnvelopeVersion: 1,
        projectionEnvelopeJson: envelope,
        projectionHash: hash(12),
        byteCount: new TextEncoder().encode(envelope).byteLength,
        findingCount: 0,
        lifecycleStateHash: hash(13),
        commandLedgerWatermark: 7n,
        projectionPolicyVersion: "projection-v1",
        publicationSafetyDecisionHash: hash(14),
        publicationNotAfter: new Date(Date.now() + 300_000),
        permitEpoch: 1n,
        allowPartial: true,
        limits,
        now: new Date(),
        retainUntil: new Date(Date.now() + 86_400_000),
      } as const;
      const finalized = await harness.executions.finalizeExecution(command);
      expect(finalized.status).toBe(ReviewExecutionFinalizeStatus.Finalized);
      expect(finalized.artifact?.projectionEnvelopeJson).toBe(envelope);
      const restored = await harness.executions.finalizeExecution(command);
      expect(restored.status).toBe(ReviewExecutionFinalizeStatus.Restored);
      expect(restored.artifact?.projectionEnvelopeJson).toBe(envelope);
      await expect(
        harness.executions.finalizeExecution({
          ...command,
          artifactHash: hash(15),
        }),
      ).resolves.toEqual({ status: ReviewExecutionFinalizeStatus.Conflict });
    });

    it("durably claims and links ReviewRequested intent with exact fencing", async () => {
      const running = await prepareAndAdmit(harness, "intent-link");
      const candidate = intentCandidate(harness, "intent-link");
      const registered = await harness.requestedIntents.registerIntent({
        candidate,
      });
      expect(registered.status).toBe(ReviewRequestedRegisterStatus.Registered);
      expect(
        (await harness.requestedIntents.registerIntent({ candidate })).status,
      ).toBe(ReviewRequestedRegisterStatus.Restored);
      const claimed = await harness.requestedIntents.claimIntent({
        requestId: candidate.requestId,
        claimId: "claim-intent-link",
        ownerIdHash: "owner-intent-link",
        now: new Date(),
        claimUntil: new Date(Date.now() + 60_000),
      });
      expect(claimed.status).toBe(ReviewRequestedClaimStatus.Claimed);
      const claim = claimed.intent!.claim!;
      await expect(
        harness.requestedIntents.recordDispatch({
          requestId: candidate.requestId,
          claimId: claim.claimId,
          ownerIdHash: claim.ownerIdHash,
          fencingToken: claim.fencingToken + 1n,
          sourceRunId: "run-intent-link",
          sourceRunAttempt: "1",
          now: new Date(),
        }),
      ).resolves.toEqual({
        status: ReviewRequestedTransitionStatus.StaleClaim,
      });
      const dispatched = await harness.requestedIntents.recordDispatch({
        requestId: candidate.requestId,
        claimId: claim.claimId,
        ownerIdHash: claim.ownerIdHash,
        fencingToken: claim.fencingToken,
        sourceRunId: "run-intent-link",
        sourceRunAttempt: "1",
        now: new Date(),
      });
      expect(dispatched.status).toBe(ReviewRequestedTransitionStatus.Applied);
      const linked = await harness.requestedIntents.linkAdmission({
        requestId: candidate.requestId,
        sourceRunId: "run-intent-link",
        sourceRunAttempt: "1",
        authorizationId: harness.authorizationId,
        executionId: running.snapshot.execution.executionId,
        revision,
        now: new Date(),
      });
      expect(linked.status).toBe(ReviewRequestedTransitionStatus.Applied);
      expect(linked.intent?.state).toBe(ReviewRequestedIntentState.Dispatched);
    });

    it("serializes pending-intent supersession per PR scope", async () => {
      const first = intentCandidate(harness, "intent-first");
      const second = intentCandidate(harness, "intent-second");
      await harness.requestedIntents.registerIntent({ candidate: first });
      await harness.requestedIntents.registerIntent({ candidate: second });
      expect(
        await harness.requestedIntents.findByRequestId(first.requestId),
      ).toMatchObject({
        state: ReviewRequestedIntentState.Superseded,
        supersededByRequestId: second.requestId,
      });
      expect(
        await harness.requestedIntents.findPendingByScope(harness.scope),
      ).toMatchObject({ requestId: second.requestId });
    });
  });
}

const revision: ReviewRevision = Object.freeze({
  baseSha: "a".repeat(40),
  mergeBaseSha: "b".repeat(40),
  headSha: "c".repeat(40),
  reviewRevisionHash: hash(1),
});

const limits: ReviewExecutionLimits = Object.freeze({
  profileId: "limits-contract",
  maxWorkSlots: 16,
  maxAttemptBudget: 4,
  maxProjectionBytes: 1_000_000,
  maxFindingCount: 1_000,
  maxLeaseDurationMs: 120_000,
  maxResultReportDurationMs: 180_000,
});

export async function prepareAndAdmit(
  harness: ReviewExecutionStoreContractHarness,
  identity: string,
) {
  const prepared = await harness.executions.prepareExecution(
    prepareCommand(harness, identity, [workSlot(`slot-${identity}`, 4)]),
  );
  expect(prepared.status).toBe(ReviewExecutionPrepareStatus.Prepared);
  const admitted = await harness.executions.confirmAdmission({
    scope: harness.scope,
    expectedStreamVersion: prepared.snapshot!.stream.version,
    executionId: prepared.snapshot!.execution.executionId,
    authorizationId: harness.authorizationId,
    mutationEpoch: 1n,
    requestedRevision: revision,
    observedRevision: revision,
    verdict: ReviewExecutionAdmissionVerdict.Current,
    checkedAt: new Date(),
  });
  expect(admitted.status).toBe(ReviewExecutionAdmissionStatus.Admitted);
  return { snapshot: admitted.snapshot! };
}

export function prepareCommand(
  harness: ReviewExecutionStoreContractHarness,
  identity: string,
  workSlots: readonly ReturnType<typeof workSlot>[],
  expectedStreamVersion = 0n,
) {
  const now = new Date();
  const index = identity.length % 16;
  return {
    scope: harness.scope,
    expectedStreamVersion,
    executionId: `execution-${identity}`,
    authorizationId: harness.authorizationId,
    producerReleaseId: harness.producerReleaseId,
    mutationEpoch: 1n,
    revision,
    startIdentityHash: hash(index),
    canonicalStartHash: hash(index + 1),
    admissionSafetyDecisionHash: hash(2),
    compatibilityKey: "compatibility-v1",
    planHash: hash(3),
    workSlots,
    limits,
    sourceRunId: `run-${identity}`,
    sourceRunAttempt: "1",
    now,
    admissionDeadlineAt: new Date(now.getTime() + 60_000),
    executionDeadlineAt: new Date(now.getTime() + 600_000),
    retainUntil: new Date(now.getTime() + 86_400_000),
  } as const;
}

export function workSlot(workSlotId: string, index: number) {
  return {
    workSlotId,
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    providerVoteIdentityHash: hash(index + 4),
    shardKey: `shard-${index}`,
    required: true,
    attemptBudget: 2,
    retryPolicyVersion: "retry-v1",
  } as const;
}

export function leaseCommand(
  harness: ReviewExecutionStoreContractHarness,
  snapshot: Awaited<ReturnType<ReviewExecutionQueryPort["findExecution"]>> & {},
  identity: string,
) {
  const now = new Date();
  const slot = snapshot.execution.workSlots[0]!;
  const index = identity.length % 16;
  return {
    scope: harness.scope,
    executionId: snapshot.execution.executionId,
    workSlotId: slot.workSlotId,
    purpose: ReviewInvocationLeasePurpose.ProviderExecution,
    providerInvocationKey: hash(index + 5),
    preparedManifestCanonicalJson: '{"manifestVersion":1}',
    preparedManifestKey: hash(index + 9),
    providerVoteIdentityHash: slot.providerVoteIdentityHash,
    leaseId: `lease-${identity}`,
    attemptId: `attempt-${identity}`,
    sourceObservationId: null,
    acquireRequestIdHash: hash(index + 6),
    acquireRequestHash: hash(index + 7),
    ownerIdHash: `owner-${identity}`,
    leaseCapabilityId: `capability-${identity}`,
    capabilitySigningKeyId: "signing-key-v1",
    leaseSafetyDecisionHash: hash(index + 8),
    now,
    expiresAt: new Date(now.getTime() + 30_000),
    resultReportUntil: new Date(now.getTime() + 90_000),
    retainUntil: new Date(now.getTime() + 86_400_000),
    limits,
  } as const;
}

function intentCandidate(
  harness: ReviewExecutionStoreContractHarness,
  identity: string,
) {
  const now = new Date();
  const index = identity.length % 16;
  return {
    ...harness.scope,
    requestId: `request-${identity}`,
    revision,
    triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
    deliveryIdentityHash: hash(index + 9),
    canonicalRequestHash: hash(index + 10),
    notBefore: now,
    createdAt: now,
    retainUntil: new Date(now.getTime() + 86_400_000),
  } as const;
}

function hash(index: number): string {
  return "0123456789abcdef"[index % 16]!.repeat(64);
}
