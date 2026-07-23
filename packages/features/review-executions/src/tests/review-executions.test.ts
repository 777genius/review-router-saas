import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CurrentReviewRevisionStatus,
  DispatchDueReviewRequestedIntents,
  RecoverReviewRequestedDispatches,
  PublicationPermitValidationStatus,
  ReviewCoverageState,
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionLifecycleTransitionStatus,
  ReviewExecutionPrepareStatus,
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentKind,
  ReviewObservationAttachmentStatus,
  ReviewRequestedClaimStatus,
  ReviewRequestedClaimDecisionStatus,
  ReviewRequestedDispatchLookupStatus,
  ReviewRequestedDispatchRunStatus,
  ReviewRequestedDispatchSubmissionStatus,
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  ReviewRequestedTriggerKind,
  ReviewTaskKind,
  ReviewWorkSlotState,
  StartReviewExecution,
  StartReviewExecutionStatus,
  createEmptyReviewExecutionStream,
  assessReviewRequestedClaim,
  claimReviewRequestedIntent,
  decideExecutionPreparation,
  decideExecutionPreparationReplay,
  ExecutionPreparationReplayDecisionStatus,
  decideReviewRequestedRegistration,
  ReviewRequestedRegistrationDecisionStatus,
  prepareWorkSlots,
  validatePublicationPermit,
  type ClockPort,
  type CurrentReviewRevisionPort,
  type PrepareReviewExecutionCommand,
  type ReviewExecutionAuthorizationFacts,
  type ReviewExecutionAuthorizationFactsPort,
  type ReviewExecutionLimits,
  type ReviewExecutionScope,
  type ReviewRequestedIntent,
  type ReviewRevision,
  type Sha256DigestPort,
} from "../index";
import {
  InMemoryReviewExecutionStore,
  InMemoryReviewRequestedIntentStore,
  MonotonicBigIntFencingTokenSource,
} from "../testing/index";
import { reviewExecutionsContractDescriptor } from "../contract-source/index";

const baseTime = new Date("2026-07-22T10:00:00.000Z");
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
const limits: ReviewExecutionLimits = {
  profileId: "limits-v1",
  maxWorkSlots: 8,
  maxAttemptBudget: 4,
  maxProjectionBytes: 32_000,
  maxFindingCount: 100,
  maxLeaseDurationMs: 60_000,
  maxResultReportDurationMs: 120_000,
};

describe("review execution domain", () => {
  it("exposes a frozen declarative protocol descriptor including durable ingress", () => {
    expect(Object.isFrozen(reviewExecutionsContractDescriptor)).toBe(true);
    expect(reviewExecutionsContractDescriptor.fencingTokenWireType).toBe(
      "unsigned_decimal_string",
    );
    expect(reviewExecutionsContractDescriptor.requestedIntentStates).toContain(
      ReviewRequestedIntentState.PendingDispatch,
    );
  });

  it("rejects duplicate semantic slots and budgets above the server ceiling", () => {
    const slot = slotFixture("slot-1", true, 1);
    expect(() =>
      prepareWorkSlots([slot, { ...slot, workSlotId: "slot-2" }], limits),
    ).toThrowError("review_execution_duplicate_work_slot_semantics");
    expect(() =>
      prepareWorkSlots(
        [{ ...slot, attemptBudget: limits.maxAttemptBudget + 1 }],
        limits,
      ),
    ).toThrowError("review_execution_attempt_budget_out_of_bounds");
  });

  it("uses bigint fencing tokens beyond Number.MAX_SAFE_INTEGER without reuse", () => {
    const source = new MonotonicBigIntFencingTokenSource(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(source.next()).toBe(9_007_199_254_740_992n);
    expect(source.next()).toBe(9_007_199_254_740_993n);
  });

  it("returns immutable domain decisions for preparation and request coalescing", () => {
    const preparation = decideExecutionPreparation({
      stream: createEmptyReviewExecutionStream(scope, baseTime),
      priorPrepared: null,
      ...prepareCommand(),
    });
    expect(preparation.execution.state).toBe(ReviewExecutionState.Planned);
    expect(preparation.stream.preparedExecutionId).toBe("execution-1");

    const first = intentCandidate("request-1", "1", scope, revision);
    const pending = decideReviewRequestedRegistration({
      candidate: first,
      existingByDelivery: null,
      existingByRequestId: null,
      preAdmissionInScope: null,
    });
    expect(pending.status).toBe(
      ReviewRequestedRegistrationDecisionStatus.Register,
    );
    if (pending.status !== ReviewRequestedRegistrationDecisionStatus.Register) {
      throw new Error("expected_registered_intent");
    }
    const next = decideReviewRequestedRegistration({
      candidate: intentCandidate("request-2", "2", scope, nextRevision),
      existingByDelivery: null,
      existingByRequestId: null,
      preAdmissionInScope: pending.intent,
    });
    expect(next.status).toBe(
      ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede,
    );
    if (
      next.status !==
      ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede
    ) {
      throw new Error("expected_coalesced_intent");
    }
    expect(next.supersededIntent?.state).toBe(
      ReviewRequestedIntentState.Superseded,
    );
    expect(pending.intent.state).toBe(
      ReviewRequestedIntentState.PendingDispatch,
    );
  });

  it("keeps a newer same-scope request pending when an older ingress arrives late", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    const newerCreatedAt = plus(10_000);
    const newer = {
      ...intentCandidate(
        "request-newer-manual",
        "81",
        scope,
        revision,
        newerCreatedAt,
      ),
      triggerKind: ReviewRequestedTriggerKind.ManualCommand,
      createdAt: newerCreatedAt,
      retainUntil: plus(3_610_000),
    };
    await intents.registerIntent({ candidate: newer });

    const older = intentCandidate(
      "request-older-webhook",
      "82",
      scope,
      revision,
    );
    const registered = await intents.registerIntent({ candidate: older });

    expect(registered).toMatchObject({
      status: ReviewRequestedRegisterStatus.Registered,
      intent: {
        requestId: older.requestId,
        state: ReviewRequestedIntentState.Superseded,
        supersededByRequestId: newer.requestId,
      },
    });
    await expect(intents.findPendingByScope(scope)).resolves.toMatchObject({
      requestId: newer.requestId,
      state: ReviewRequestedIntentState.PendingDispatch,
    });
  });

  it("reconciles a timeout-after-success without issuing a second POST", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-dispatch", "31", scope, revision),
    });
    let now = baseTime;
    let submitCalls = 0;
    let lookupCalls = 0;
    const gateway = {
      async prepare() {
        return {
          async submit() {
            submitCalls += 1;
            throw new Error("timeout_after_success");
          },
        };
      },
      async findByRequestIdentity() {
        lookupCalls += 1;
        if (lookupCalls < 3) {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        }
        return {
          status: ReviewRequestedDispatchLookupStatus.Found as const,
          sourceRunId: "12345",
          sourceRunAttempt: "1",
        };
      },
      async inspectKnownRun() {
        return { status: ReviewRequestedDispatchRunStatus.Pending };
      },
      async cancelKnownRun() {},
    };
    const policy = {
      claimDurationMs: 1_000,
      dispatchResolutionDelayMs: 1_000,
      dispatchResolutionTimeoutMs: 5_000,
      authorizationResolutionDelayMs: 1_000,
      authorizationResolutionTimeoutMs: 5_000,
      retryDelayMs: 1_000,
      retentionMs: 86_400_000,
      maxDispatchAttempts: 3,
    };
    const dispatcher = new DispatchDueReviewRequestedIntents(
      intents,
      intents,
      gateway,
      { now: () => now },
      {
        nextClaimId: () => `claim-${submitCalls + 1}`,
        nextRequestId: () => "request-retry",
      },
      {
        digestUtf8: async (value) =>
          createHash("sha256").update(value).digest("hex"),
      },
      policy,
    );

    const failed = await dispatcher.execute({
      ownerIdHash: hash("d"),
      limit: 10,
    });
    expect(failed).toMatchObject({ claimed: 1, dispatched: 0, failed: 1 });

    expect(submitCalls).toBe(1);
    const notRedispatched = await dispatcher.execute({
      ownerIdHash: hash("d"),
      limit: 10,
    });
    expect(notRedispatched.scanned).toBe(0);
    expect(submitCalls).toBe(1);

    now = new Date(baseTime.getTime() + 1_001);
    const recovery = new RecoverReviewRequestedDispatches(
      intents,
      intents,
      gateway,
      { now: () => now },
      {
        ids: { nextRequestId: () => "request-retry" },
        digest: {
          digestUtf8: async (value) =>
            createHash("sha256").update(value).digest("hex"),
        },
      },
      policy,
    );
    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      pending: 1,
      recovered: 0,
      failed: 0,
    });
    now = new Date(baseTime.getTime() + 2_002);
    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      pending: 1,
      recovered: 0,
      failed: 0,
    });
    now = new Date(baseTime.getTime() + 3_003);
    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(lookupCalls).toBe(3);
    expect(submitCalls).toBe(1);
    expect(await intents.findByRequestId("request-dispatch")).toMatchObject({
      state: ReviewRequestedIntentState.AwaitingAuthorization,
      sourceRunId: "12345",
      sourceRunAttempt: "1",
    });
  });

  it("retries failed transport preparation before entering unknown outcome", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-prepare", "311", scope, revision),
    });
    let now = baseTime;
    let prepareCalls = 0;
    let submitCalls = 0;
    const dispatcher = new DispatchDueReviewRequestedIntents(
      intents,
      intents,
      {
        async prepare() {
          prepareCalls += 1;
          if (prepareCalls === 1) throw new Error("installation_unavailable");
          return {
            async submit() {
              submitCalls += 1;
              return {
                status:
                  ReviewRequestedDispatchSubmissionStatus.Accepted as const,
                sourceRunId: "12346",
                sourceRunAttempt: "1",
              };
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return { status: ReviewRequestedDispatchRunStatus.Pending };
        },
        async cancelKnownRun() {},
      },
      { now: () => now },
      {
        nextClaimId: () => `claim-prepare-${prepareCalls + 1}`,
        nextRequestId: () => "not-used",
      },
      {
        digestUtf8: async (value) =>
          createHash("sha256").update(value).digest("hex"),
      },
      testDispatchPolicy(),
    );

    expect(
      await dispatcher.execute({ ownerIdHash: hash("a"), limit: 10 }),
    ).toMatchObject({ failed: 1, dispatched: 0 });
    expect(submitCalls).toBe(0);
    expect(await intents.findByRequestId("request-prepare")).toMatchObject({
      state: ReviewRequestedIntentState.Dispatching,
      submissionStartedAt: null,
    });

    now = plus(testDispatchPolicy().claimDurationMs + 1);
    expect(
      await dispatcher.execute({ ownerIdHash: hash("a"), limit: 10 }),
    ).toMatchObject({ failed: 0, dispatched: 1 });
    expect(prepareCalls).toBe(2);
    expect(submitCalls).toBe(1);
  });

  it("terminalizes crash-before-POST uncertainty without ever submitting", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-crash", "32", scope, revision),
    });
    const claimed = await intents.claimIntent(
      claimIntent("request-crash", "claim-crash", "owner-crash"),
    );
    const policy = testDispatchPolicy();
    const begun = await intents.beginSubmission({
      requestId: "request-crash",
      claimId: claimed.intent!.claim!.claimId,
      ownerIdHash: claimed.intent!.claim!.ownerIdHash,
      fencingToken: claimed.intent!.claim!.fencingToken,
      now: baseTime,
      nextResolutionAt: plus(policy.dispatchResolutionDelayMs),
      resolutionDeadlineAt: plus(policy.dispatchResolutionTimeoutMs),
    });
    expect(begun.status).toBe(ReviewRequestedTransitionStatus.Applied);
    let submitCalls = 0;
    const recovery = new RecoverReviewRequestedDispatches(
      intents,
      intents,
      {
        async prepare() {
          return {
            async submit() {
              submitCalls += 1;
              throw new Error("must_not_submit");
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return { status: ReviewRequestedDispatchRunStatus.Pending };
        },
        async cancelKnownRun() {},
      },
      { now: () => plus(policy.dispatchResolutionTimeoutMs + 1) },
      {
        ids: { nextRequestId: () => "must-not-retry" },
        digest: {
          digestUtf8: async () => {
            throw new Error("must_not_hash");
          },
        },
      },
      policy,
    );

    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(submitCalls).toBe(0);
    expect(await intents.findByRequestId("request-crash")).toMatchObject({
      state: ReviewRequestedIntentState.Terminal,
      terminalReason:
        ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown,
    });
  });

  it("retries only proven no-effect submissions within the attempt budget", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-no-effect", "33", scope, revision),
    });
    let now = baseTime;
    let submitCalls = 0;
    let retryIds = 0;
    const policy = {
      ...testDispatchPolicy(),
      retryDelayMs: 1_000,
      maxDispatchAttempts: 2,
    };
    const dispatcher = new DispatchDueReviewRequestedIntents(
      intents,
      intents,
      {
        async prepare() {
          return {
            async submit() {
              submitCalls += 1;
              return {
                status:
                  ReviewRequestedDispatchSubmissionStatus.DefinitelyNoEffect as const,
              };
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return { status: ReviewRequestedDispatchRunStatus.Pending };
        },
        async cancelKnownRun() {},
      },
      { now: () => now },
      {
        nextClaimId: () => `claim-${submitCalls + 1}`,
        nextRequestId: () => `request-retry-${++retryIds}`,
      },
      {
        digestUtf8: async (value) =>
          createHash("sha256").update(value).digest("hex"),
      },
      policy,
    );

    await dispatcher.execute({ ownerIdHash: hash("e"), limit: 10 });
    expect(await intents.findPendingByScope(scope)).toMatchObject({
      requestId: "request-retry-1",
      dispatchAttempt: 2,
    });
    now = plus(1_001);
    await dispatcher.execute({ ownerIdHash: hash("e"), limit: 10 });
    expect(await intents.findByRequestId("request-retry-1")).toMatchObject({
      state: ReviewRequestedIntentState.Terminal,
      terminalReason:
        ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted,
    });
    expect(await intents.findPendingByScope(scope)).toBeNull();
    expect(
      await dispatcher.execute({ ownerIdHash: hash("e"), limit: 10 }),
    ).toMatchObject({ scanned: 0 });
    expect(submitCalls).toBe(2);
  });

  it("bounds authorization waiting, cancels the exact run, and rejects late admission", async () => {
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-auth-timeout", "34", scope, revision),
    });
    const claimed = await intents.claimIntent(
      claimIntent(
        "request-auth-timeout",
        "claim-auth-timeout",
        "owner-auth-timeout",
      ),
    );
    await beginClaimedSubmission(intents, claimed.intent!, plus(500));
    await intents.recordDispatch({
      requestId: "request-auth-timeout",
      claimId: claimed.intent!.claim!.claimId,
      ownerIdHash: claimed.intent!.claim!.ownerIdHash,
      fencingToken: claimed.intent!.claim!.fencingToken,
      sourceRunId: "98765",
      sourceRunAttempt: "1",
      now: plus(1_000),
      ...resolutionWindow(plus(1_000)),
    });
    let now = plus(2_001);
    let cancellations = 0;
    const recovery = new RecoverReviewRequestedDispatches(
      intents,
      intents,
      {
        async prepare() {
          return {
            async submit() {
              throw new Error("not_used");
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return { status: ReviewRequestedDispatchRunStatus.Pending };
        },
        async cancelKnownRun({ intent }) {
          expect(intent.sourceRunId).toBe("98765");
          cancellations += 1;
        },
      },
      { now: () => now },
      {
        ids: { nextRequestId: () => "must-not-retry" },
        digest: {
          digestUtf8: async () => {
            throw new Error("must_not_hash");
          },
        },
      },
      testDispatchPolicy(),
    );
    const beforeDeferral = await intents.findByRequestId(
      "request-auth-timeout",
    );
    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      pending: 1,
      recovered: 0,
    });
    await expect(
      intents.deferResolution({
        requestId: "request-auth-timeout",
        expectedVersion: beforeDeferral!.version,
        expectedState: ReviewRequestedIntentState.AwaitingAuthorization,
        now,
        nextResolutionAt: plus(4_000),
      }),
    ).resolves.toMatchObject({
      status: ReviewRequestedTransitionStatus.Conflict,
    });

    now = plus(61_001);
    await intents.registerIntent({
      candidate: {
        ...intentCandidate("request-after-timeout", "35", scope, revision, now),
        createdAt: now,
      },
    });
    await expect(
      intents.claimIntent({
        requestId: "request-after-timeout",
        claimId: "claim-after-timeout",
        ownerIdHash: "owner-after-timeout",
        now,
        claimUntil: plus(91_001),
      }),
    ).resolves.toMatchObject({
      status: ReviewRequestedClaimStatus.Claimed,
    });
    await expect(
      intents.linkAdmission({
        requestId: "request-auth-timeout",
        sourceRunId: "98765",
        sourceRunAttempt: "1",
        authorizationId: "authorization-late",
        executionId: "execution-late",
        revision,
        now,
      }),
    ).resolves.toMatchObject({
      status: ReviewRequestedTransitionStatus.Conflict,
    });
    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(cancellations).toBe(1);
    expect(await intents.findByRequestId("request-auth-timeout")).toMatchObject(
      {
        state: ReviewRequestedIntentState.Terminal,
        terminalReason:
          ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded,
      },
    );
  });

  it("makes preparation replay and expired claim takeover explicit domain outcomes", () => {
    const preparation = decideExecutionPreparation({
      stream: createEmptyReviewExecutionStream(scope, baseTime),
      priorPrepared: null,
      ...prepareCommand(),
    });
    expect(
      decideExecutionPreparationReplay({
        existingByStartIdentity: preparation.execution,
        canonicalStartHash: preparation.execution.canonicalStartHash,
      }).status,
    ).toBe(ExecutionPreparationReplayDecisionStatus.Restored);
    expect(
      decideExecutionPreparationReplay({
        existingByStartIdentity: preparation.execution,
        canonicalStartHash: hash("9"),
      }).status,
    ).toBe(ExecutionPreparationReplayDecisionStatus.IdempotencyConflict);

    const registered = decideReviewRequestedRegistration({
      candidate: intentCandidate("request-1", "1", scope, revision),
      existingByDelivery: null,
      existingByRequestId: null,
      preAdmissionInScope: null,
    });
    if (
      registered.status !== ReviewRequestedRegistrationDecisionStatus.Register
    ) {
      throw new Error("expected_registered_intent");
    }
    const firstClaim = claimReviewRequestedIntent({
      intent: registered.intent,
      claimId: "claim-1",
      ownerIdHash: "owner-1",
      fencingToken: 9_007_199_254_740_992n,
      now: baseTime,
      claimUntil: plus(30_000),
    });
    expect(
      assessReviewRequestedClaim({
        intent: firstClaim,
        claimId: "claim-2",
        ownerIdHash: "owner-2",
        now: plus(30_001),
        claimUntil: plus(60_000),
      }),
    ).toBe(ReviewRequestedClaimDecisionStatus.Takeover);
    const takeover = claimReviewRequestedIntent({
      intent: firstClaim,
      claimId: "claim-2",
      ownerIdHash: "owner-2",
      fencingToken: 9_007_199_254_740_993n,
      now: plus(30_001),
      claimUntil: plus(60_000),
    });
    expect(takeover.claim?.fencingToken).toBe(9_007_199_254_740_993n);
    expect(firstClaim.claim?.ownerIdHash).toBe("owner-1");
  });
});

describe("start and admission saga", () => {
  it("rejects a missing required intent before creating a planned execution", async () => {
    const executions = new InMemoryReviewExecutionStore();
    const intents = new InMemoryReviewRequestedIntentStore();
    const facts = authorizationFactsFixture(revision);
    const useCase = startUseCaseWithPorts(executions, {
      authorizationFind: async () => facts,
      revisions: [revision],
      requestedIntentAdmission: {
        queries: intents,
        commands: intents,
        required: true,
      },
    });

    expect(await useCase.execute(startInput("execution-1"))).toEqual({
      status: StartReviewExecutionStatus.RequestIntentMissing,
    });
    expect(await executions.findStream(scope)).toBeNull();
  });

  it("links the exact durable intent only after execution admission", async () => {
    const executions = new InMemoryReviewExecutionStore();
    const intents = new InMemoryReviewRequestedIntentStore();
    await intents.registerIntent({
      candidate: intentCandidate("request-start", "71", scope, revision),
    });
    const claim = await intents.claimIntent(
      claimIntent("request-start", "claim-start", "owner-start"),
    );
    await beginClaimedSubmission(intents, claim.intent!, plus(1));
    await intents.recordDispatch({
      requestId: "request-start",
      claimId: "claim-start",
      ownerIdHash: "owner-start",
      fencingToken: claim.intent!.claim!.fencingToken,
      sourceRunId: "run-1",
      sourceRunAttempt: "1",
      now: plus(2),
      ...resolutionWindow(plus(2)),
    });
    const facts = authorizationFactsFixture(revision);
    const useCase = startUseCaseWithPorts(executions, {
      authorizationFind: async () => facts,
      revisions: [revision, revision],
      requestedIntentAdmission: {
        queries: intents,
        commands: intents,
        required: true,
      },
    });

    expect((await useCase.execute(startInput("execution-1"))).status).toBe(
      StartReviewExecutionStatus.Admitted,
    );
    expect(await intents.findByRequestId("request-start")).toMatchObject({
      state: ReviewRequestedIntentState.Dispatched,
      authorizationId: "authorization-1",
      executionId: "execution-1",
    });
  });

  it("fails closed when authorization expires during the revision precheck", async () => {
    const store = new InMemoryReviewExecutionStore();
    const facts = authorizationFactsFixture(revision);
    let calls = 0;
    const useCase = startUseCaseWithPorts(store, {
      authorizationFind: async () => {
        calls += 1;
        return calls === 1
          ? facts
          : { ...facts, expiresAt: new Date(baseTime) };
      },
      revisions: [revision],
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(
      StartReviewExecutionStatus.AuthorizationRejected,
    );
    expect(await store.findExecution("execution-1")).toBeNull();
  });

  it("uses a fresh clock boundary when authorization expires during precheck", async () => {
    const store = new InMemoryReviewExecutionStore();
    const facts = {
      ...authorizationFactsFixture(revision),
      expiresAt: plus(100),
    };
    let now = new Date(baseTime);
    const useCase = startUseCaseWithPorts(store, {
      authorizationFind: async () => facts,
      revisions: [revision],
      clock: { now: () => new Date(now) },
      onRevisionResolve: () => {
        now = plus(101);
      },
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(
      StartReviewExecutionStatus.AuthorizationRejected,
    );
    expect(await store.findExecution("execution-1")).toBeNull();
  });

  it("compares an immutable authorization snapshot when a port reuses its object", async () => {
    const store = new InMemoryReviewExecutionStore();
    const mutableFacts = { ...authorizationFactsFixture(revision) };
    const useCase = startUseCaseWithPorts(store, {
      authorizationFind: async () => mutableFacts,
      revisions: [revision],
      onRevisionResolve: () => {
        mutableFacts.mutationEpoch = 2n;
      },
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(
      StartReviewExecutionStatus.AuthorizationRejected,
    );
    expect(await store.findExecution("execution-1")).toBeNull();
  });

  it("does not admit when authorization expires during the postcheck", async () => {
    const store = new InMemoryReviewExecutionStore();
    const facts = authorizationFactsFixture(revision);
    let calls = 0;
    const useCase = startUseCaseWithPorts(store, {
      authorizationFind: async () => {
        calls += 1;
        return calls < 4 ? facts : { ...facts, expiresAt: new Date(baseTime) };
      },
      revisions: [revision, revision],
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(
      StartReviewExecutionStatus.AuthorizationRejected,
    );
    expect(result.snapshot?.execution.state).toBe(ReviewExecutionState.Planned);
    expect((await store.findStream(scope))?.activeExecutionId).toBeNull();
  });

  it("uses a fresh clock boundary when authorization expires during postcheck", async () => {
    const store = new InMemoryReviewExecutionStore();
    const facts = {
      ...authorizationFactsFixture(revision),
      expiresAt: plus(100),
    };
    let now = new Date(baseTime);
    const useCase = startUseCaseWithPorts(store, {
      authorizationFind: async () => facts,
      revisions: [revision, revision],
      clock: { now: () => new Date(now) },
      onRevisionResolve: (index) => {
        if (index === 1) now = plus(101);
      },
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(
      StartReviewExecutionStatus.AuthorizationRejected,
    );
    expect(result.snapshot?.execution.state).toBe(ReviewExecutionState.Planned);
    expect((await store.findStream(scope))?.activeExecutionId).toBeNull();
  });

  it("does not allocate a generation when the fresh precheck is stale", async () => {
    const store = new InMemoryReviewExecutionStore();
    const useCase = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [nextRevision],
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(StartReviewExecutionStatus.StaleRevision);
    expect(await store.findExecution("execution-1")).toBeNull();
  });

  it("restores a prepared generation after an unavailable postcheck", async () => {
    const store = new InMemoryReviewExecutionStore();
    const first = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [revision, null],
    });
    const deferred = await first.execute(startInput("execution-1"));
    expect(deferred.status).toBe(StartReviewExecutionStatus.AdmissionDeferred);
    expect(deferred.snapshot?.execution.generation).toBe(1n);
    expect(deferred.snapshot?.execution.state).toBe(
      ReviewExecutionState.Planned,
    );

    const retry = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [revision, revision],
    });
    const admitted = await retry.execute(startInput("different-client-id"));
    expect(admitted.status).toBe(StartReviewExecutionStatus.Admitted);
    expect(admitted.snapshot?.execution.executionId).toBe("execution-1");
    expect(admitted.snapshot?.execution.generation).toBe(1n);
  });

  it("converges concurrent duplicate starts to one generation", async () => {
    const store = new InMemoryReviewExecutionStore();
    const useCase = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [revision],
    });

    const results = await Promise.all([
      useCase.execute(startInput("execution-1")),
      useCase.execute(startInput("execution-2")),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      StartReviewExecutionStatus.Admitted,
      StartReviewExecutionStatus.Restored,
    ]);
    expect(results[0]?.snapshot?.execution.executionId).toBe(
      results[1]?.snapshot?.execution.executionId,
    );
    expect(results[0]?.snapshot?.stream.lastAllocatedGeneration).toBe(1n);
  });

  it("rechecks revision and authorization after an admission CAS conflict", async () => {
    const store = new InMemoryReviewExecutionStore();
    const confirmAdmission = store.confirmAdmission.bind(store);
    const confirmSpy = vi
      .spyOn(store, "confirmAdmission")
      .mockResolvedValueOnce({
        status: ReviewExecutionAdmissionStatus.ConcurrencyConflict,
      })
      .mockImplementation(confirmAdmission);
    const useCase = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [revision, revision, revision],
    });

    const result = await useCase.execute(startInput("execution-1"));

    expect(result.status).toBe(StartReviewExecutionStatus.Admitted);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it("does not restore a running execution for a different authorization term", async () => {
    const store = new InMemoryReviewExecutionStore();
    const admitted = await prepareAndAdmit(store);

    const replay = await store.confirmAdmission({
      scope,
      expectedStreamVersion: admitted.stream.version,
      executionId: admitted.execution.executionId,
      authorizationId: "authorization-2",
      mutationEpoch: admitted.execution.mutationEpoch,
      requestedRevision: admitted.execution.revision,
      observedRevision: admitted.execution.revision,
      verdict: ReviewExecutionAdmissionVerdict.Current,
      checkedAt: plus(2),
    });

    expect(replay.status).toBe(ReviewExecutionAdmissionStatus.NotPrepared);
  });

  it("keeps the active execution running until a newer prepared execution is confirmed", async () => {
    const store = new InMemoryReviewExecutionStore();
    const first = await prepareAndAdmit(store, "execution-1", "1", revision);
    const prepared = await store.prepareExecution(
      prepareCommand({
        executionId: "execution-2",
        expectedStreamVersion: first.stream.version,
        identitySeed: "2",
        revision: nextRevision,
        now: plus(1_000),
      }),
    );
    expect(prepared.status).toBe(ReviewExecutionPrepareStatus.Prepared);
    expect((await store.findExecution("execution-1"))?.execution.state).toBe(
      ReviewExecutionState.Running,
    );

    const confirmed = await store.confirmAdmission({
      scope,
      expectedStreamVersion: prepared.snapshot!.stream.version,
      executionId: "execution-2",
      authorizationId: "authorization-1",
      mutationEpoch: 1n,
      requestedRevision: nextRevision,
      observedRevision: nextRevision,
      verdict: ReviewExecutionAdmissionVerdict.Current,
      checkedAt: plus(2_000),
    });
    expect(confirmed.status).toBe(ReviewExecutionAdmissionStatus.Admitted);
    expect((await store.findExecution("execution-1"))?.execution.state).toBe(
      ReviewExecutionState.Superseded,
    );
    expect(confirmed.snapshot?.stream.activeExecutionId).toBe("execution-2");
  });

  it("supersedes only a stale prepared execution and preserves the active one", async () => {
    const store = new InMemoryReviewExecutionStore();
    const active = await prepareAndAdmit(store, "execution-1", "1", revision);
    const prepared = await store.prepareExecution(
      prepareCommand({
        executionId: "execution-2",
        expectedStreamVersion: active.stream.version,
        identitySeed: "2",
        revision: nextRevision,
        now: plus(1_000),
      }),
    );
    const stale = await store.confirmAdmission({
      scope,
      expectedStreamVersion: prepared.snapshot!.stream.version,
      executionId: "execution-2",
      authorizationId: "authorization-1",
      mutationEpoch: 1n,
      requestedRevision: nextRevision,
      observedRevision: revision,
      verdict: ReviewExecutionAdmissionVerdict.Stale,
      checkedAt: plus(2_000),
    });
    expect(stale.status).toBe(ReviewExecutionAdmissionStatus.Superseded);
    expect(stale.snapshot?.stream.activeExecutionId).toBe("execution-1");
    expect((await store.findExecution("execution-1"))?.execution.state).toBe(
      ReviewExecutionState.Running,
    );
  });

  it("retains the empty stream fence after stale admission and allocates the next generation", async () => {
    const store = new InMemoryReviewExecutionStore();
    const staleStart = startUseCase(store, {
      authorizationRevision: revision,
      revisions: [revision, nextRevision],
    });
    expect((await staleStart.execute(startInput("execution-1"))).status).toBe(
      StartReviewExecutionStatus.StaleRevision,
    );
    expect((await store.findStream(scope))?.lastAllocatedGeneration).toBe(1n);

    const currentStart = startUseCase(store, {
      authorizationRevision: nextRevision,
      revisions: [nextRevision, nextRevision],
    });
    const admitted = await currentStart.execute(startInput("execution-2"));
    expect(admitted.status).toBe(StartReviewExecutionStatus.Admitted);
    expect(admitted.snapshot?.execution.generation).toBe(2n);
  });
});

describe("work slots and fenced invocation leases", () => {
  it("forbids planned execution leases", async () => {
    const store = new InMemoryReviewExecutionStore();
    const prepared = await store.prepareExecution(prepareCommand());
    const lease = await store.acquireLease(
      leaseCommand({
        expectedExecutionId: prepared.snapshot!.execution.executionId,
      }),
    );
    expect(lease.status).toBe(ReviewInvocationLeaseAcquireStatus.NotRunnable);
  });

  it("rejects a provider lane identity that does not match the work slot", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);

    await expect(
      store.acquireLease({
        ...leaseCommand(),
        providerVoteIdentityHash: hash("8"),
      }),
    ).rejects.toThrow("review_execution_provider_lane_identity_mismatch");
  });

  it("restores a lost acquire response without consuming budget or a new fence", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const command = leaseCommand();
    const first = await store.acquireLease(command);
    const retry = await store.acquireLease(command);

    expect(first.status).toBe(ReviewInvocationLeaseAcquireStatus.Acquired);
    expect(retry.status).toBe(ReviewInvocationLeaseAcquireStatus.Restored);
    expect(retry.lease?.fencingToken).toBe(first.lease?.fencingToken);
    expect(retry.lease?.attemptOrdinal).toBe(1);
    expect(retry.snapshot).toBeUndefined();
    expect(
      (await store.findExecution("execution-1"))?.execution.workSlots[0],
    ).toMatchObject({ nextAttemptOrdinal: 2, activeLeaseId: "lease-1" });
  });

  it("rejects a changed acquire body under the same request identity", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const command = leaseCommand();
    await store.acquireLease(command);
    const conflict = await store.acquireLease({
      ...command,
      acquireRequestHash: hash("9"),
      ownerIdHash: "owner-2",
    });
    expect(conflict.status).toBe(
      ReviewInvocationLeaseAcquireStatus.IdempotencyConflict,
    );
  });

  it("serializes concurrent owners and admits only one active lease", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const [left, right] = await Promise.all([
      store.acquireLease(leaseCommand()),
      store.acquireLease(
        leaseCommand({
          leaseId: "lease-2",
          attemptId: "attempt-2",
          requestSeed: "2",
          ownerIdHash: "owner-2",
          capabilityId: "capability-2",
        }),
      ),
    ]);
    expect([left.status, right.status].sort()).toEqual([
      ReviewInvocationLeaseAcquireStatus.Acquired,
      ReviewInvocationLeaseAcquireStatus.Busy,
    ]);
    expect(
      (await store.findExecution("execution-1"))?.activeLeases,
    ).toHaveLength(1);
  });

  it("serializes one provider identity across different pull requests", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    await prepareAndAdmit(store, "execution-2", "8", revision, 1, otherScope);
    const first = await store.acquireLease(leaseCommand());
    const second = await store.acquireLease(
      leaseCommand({
        scope: otherScope,
        expectedExecutionId: "execution-2",
        leaseId: "lease-2",
        attemptId: "attempt-2",
        requestSeed: "8",
        ownerIdHash: "owner-2",
        capabilityId: "capability-2",
      }),
    );

    expect(first.status).toBe(ReviewInvocationLeaseAcquireStatus.Acquired);
    expect(second.status).toBe(ReviewInvocationLeaseAcquireStatus.Busy);
    expect(
      (await store.findExecution("execution-2"))?.execution.workSlots[0],
    ).toMatchObject({
      state: ReviewWorkSlotState.Pending,
      nextAttemptOrdinal: 1,
    });
  });

  it("returns not-runnable before reporting a busy provider lane", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const other = await prepareAndAdmit(
      store,
      "execution-2",
      "8",
      revision,
      1,
      otherScope,
    );
    await store.acquireLease(leaseCommand());
    await store.supersedeExecution({
      scope: otherScope,
      executionId: "execution-2",
      expectedStreamVersion: other.stream.version,
      observedCurrentRevision: nextRevision,
      now: plus(2),
    });

    const result = await store.acquireLease(
      leaseCommand({
        scope: otherScope,
        expectedExecutionId: "execution-2",
        leaseId: "lease-2",
        attemptId: "attempt-2",
        requestSeed: "8",
        ownerIdHash: "owner-2",
        capabilityId: "capability-2",
      }),
    );
    expect(result.status).toBe(ReviewInvocationLeaseAcquireStatus.NotRunnable);
  });

  it("reassigns an expired lease with a new bigint fence and rejects the old owner", async () => {
    const tokens = new MonotonicBigIntFencingTokenSource(100n);
    const store = new InMemoryReviewExecutionStore(tokens);
    await prepareAndAdmit(store, "execution-1", "1", revision, 2);
    const old = await store.acquireLease(leaseCommand());
    const replacement = await store.acquireLease(
      leaseCommand({
        leaseId: "lease-2",
        attemptId: "attempt-2",
        requestSeed: "2",
        ownerIdHash: "owner-2",
        capabilityId: "capability-2",
        now: plus(31_000),
        expiresAt: plus(61_000),
        reportUntil: plus(90_000),
      }),
    );
    expect(old.lease?.fencingToken).toBe(101n);
    expect(replacement.status).toBe(
      ReviewInvocationLeaseAcquireStatus.Acquired,
    );
    expect(replacement.lease?.fencingToken).toBe(102n);

    const staleRelease = await store.releaseLease({
      leaseId: old.lease!.leaseId,
      ownerIdHash: old.lease!.ownerIdHash,
      leaseCapabilityId: old.lease!.leaseCapabilityId,
      fencingToken: old.lease!.fencingToken,
      now: plus(32_000),
    });
    expect(staleRelease.status).toBe(
      ReviewInvocationLeaseTransitionStatus.StaleTerm,
    );
    expect(
      (await store.findExecution("execution-1"))?.execution.workSlots[0],
    ).toMatchObject({
      activeLeaseId: "lease-2",
      state: ReviewWorkSlotState.Leased,
    });
  });

  it("renews without changing the fencing token and rejects deadline expansion", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const acquired = await store.acquireLease(leaseCommand());
    const term = leaseTerm(acquired.lease!);
    const renewed = await store.renewLease({
      ...term,
      renewRequestIdHash: hash("8"),
      renewRequestHash: hash("9"),
      now: plus(5_000),
      expiresAt: plus(55_000),
      resultReportUntil: plus(110_000),
      limits,
    });
    expect(renewed.status).toBe(ReviewInvocationLeaseTransitionStatus.Applied);
    expect(renewed.lease?.fencingToken).toBe(acquired.lease?.fencingToken);
    expect(renewed.lease).toMatchObject({
      leaseCapabilityId: acquired.lease?.leaseCapabilityId,
      capabilitySigningKeyId: acquired.lease?.capabilitySigningKeyId,
      renewedAt: plus(5_000),
      expiresAt: plus(55_000),
      resultReportUntil: plus(110_000),
    });
    const invalid = await store.renewLease({
      ...term,
      renewRequestIdHash: hash("a"),
      renewRequestHash: hash("b"),
      now: plus(6_000),
      expiresAt: plus(90_000),
      resultReportUntil: plus(130_000),
      limits,
    });
    expect(invalid.status).toBe(
      ReviewInvocationLeaseTransitionStatus.InvalidDeadline,
    );

    const conflictingReplay = await store.renewLease({
      ...term,
      renewRequestIdHash: hash("8"),
      renewRequestHash: hash("c"),
      now: plus(7_000),
      expiresAt: plus(55_000),
      resultReportUntil: plus(110_000),
      limits,
    });
    expect(conflictingReplay.status).toBe(
      ReviewInvocationLeaseTransitionStatus.IdempotencyConflict,
    );
  });

  it("revokes active lease ownership when a verified newer revision supersedes the execution", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const acquired = await store.acquireLease(leaseCommand());
    const stream = await store.findStream(scope);
    const superseded = await store.supersedeExecution({
      scope,
      executionId: "execution-1",
      expectedStreamVersion: stream!.version,
      observedCurrentRevision: nextRevision,
      now: plus(5_000),
    });
    expect(superseded.status).toBe(
      ReviewExecutionLifecycleTransitionStatus.Applied,
    );
    expect(superseded.snapshot?.execution.state).toBe(
      ReviewExecutionState.Superseded,
    );
    expect((await store.findLease(acquired.lease!.leaseId))?.state).toBe(
      ReviewInvocationLeaseState.Revoked,
    );
    expect(
      (
        await store.attachObservation(
          attachmentCommand(acquired.lease!, { now: plus(6_000) }),
        )
      ).status,
    ).toBe(ReviewObservationAttachmentStatus.NotRunnable);
  });

  it("fails only an expired prepared generation and leaves active work untouched", async () => {
    const store = new InMemoryReviewExecutionStore();
    const active = await prepareAndAdmit(store);
    const prepared = await store.prepareExecution(
      prepareCommand({
        executionId: "execution-2",
        expectedStreamVersion: active.stream.version,
        identitySeed: "2",
        now: plus(1_000),
      }),
    );
    const failed = await store.failAbandonedPreparedExecution({
      scope,
      executionId: "execution-2",
      expectedStreamVersion: prepared.snapshot!.stream.version,
      now: plus(61_000),
    });
    expect(failed.status).toBe(
      ReviewExecutionLifecycleTransitionStatus.Applied,
    );
    expect(failed.snapshot?.execution.state).toBe(ReviewExecutionState.Failed);
    expect(failed.snapshot?.stream.activeExecutionId).toBe("execution-1");
    expect((await store.findExecution("execution-1"))?.execution.state).toBe(
      ReviewExecutionState.Running,
    );
  });
});

describe("observation references and finalization", () => {
  it("rejects array and scalar finalization envelopes", async () => {
    const store = new InMemoryReviewExecutionStore();
    const running = await prepareAndAdmit(store);
    for (const envelope of ["[]", '"value"']) {
      const bytes = new TextEncoder().encode(envelope).byteLength;
      await expect(
        store.finalizeExecution({
          ...finalizeCommand(running),
          projectionEnvelopeJson: envelope,
          byteCount: bytes,
        }),
      ).rejects.toThrowError("review_execution_projection_envelope_not_object");
    }
  });

  it("rejects a stale owner after takeover and stores only a payload-free reference", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store, "execution-1", "1", revision, 2);
    const old = await store.acquireLease(leaseCommand());
    const replacement = await store.acquireLease(
      leaseCommand({
        leaseId: "lease-2",
        attemptId: "attempt-2",
        requestSeed: "2",
        ownerIdHash: "owner-2",
        capabilityId: "capability-2",
        now: plus(31_000),
        expiresAt: plus(61_000),
        reportUntil: plus(90_000),
      }),
    );
    const stale = await store.attachObservation(
      attachmentCommand(old.lease!, { now: plus(32_000) }),
    );
    expect(stale.status).toBe(ReviewObservationAttachmentStatus.StaleLease);

    const attached = await store.attachObservation(
      attachmentCommand(replacement.lease!, {
        observationRefId: "observation-ref-2",
        observationId: "observation-2",
        now: plus(33_000),
      }),
    );
    expect(attached.status).toBe(ReviewObservationAttachmentStatus.Attached);
    const ref = attached.snapshot!.observationRefs[0]!;
    expect(ref).toMatchObject({
      observationId: "observation-2",
      sourceLeaseId: "lease-2",
      sourceFencingToken: replacement.lease!.fencingToken,
      attachmentKind: ReviewObservationAttachmentKind.FreshLease,
    });
    expect(Object.hasOwn(ref, "payloadJson")).toBe(false);
    expect(Object.hasOwn(ref, "payload")).toBe(false);
  });

  it("restores an exact attachment and conflicts on changed payload", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const lease = (await store.acquireLease(leaseCommand())).lease!;
    const command = attachmentCommand(lease);
    const first = await store.attachObservation(command);
    const retry = await store.attachObservation(command);
    const conflict = await store.attachObservation({
      ...command,
      payloadHash: hash("8"),
    });
    expect(first.status).toBe(ReviewObservationAttachmentStatus.Attached);
    expect(retry.status).toBe(ReviewObservationAttachmentStatus.Restored);
    expect(conflict.status).toBe(ReviewObservationAttachmentStatus.Conflict);
  });

  it("forbids same-execution reuse and permits policy-fenced cross-execution reuse", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const same = reusableAttachmentCommand({
      sourceExecutionId: "execution-1",
    });
    expect((await store.attachReusableObservation(same)).status).toBe(
      ReviewObservationAttachmentStatus.Ineligible,
    );
    const cross = await store.attachReusableObservation(
      reusableAttachmentCommand({ sourceExecutionId: "older-execution" }),
    );
    expect(cross.status).toBe(ReviewObservationAttachmentStatus.Attached);
    expect(cross.snapshot?.observationRefs[0]).toMatchObject({
      reuseSafetyDecisionHash: hash("7"),
      sourceLeaseId: null,
      sourceFencingToken: null,
    });
  });

  it("adopts an accepted same-execution observation under a fresh fenced term without consuming budget", async () => {
    const tokens = new MonotonicBigIntFencingTokenSource();
    const store = new InMemoryReviewExecutionStore(tokens);
    await prepareAndAdmit(store, "execution-1", "1", revision, 2);
    const source = (await store.acquireLease(leaseCommand())).lease!;
    const adoptionTarget = (await store.findExecution("execution-1"))!;
    const before = adoptionTarget.execution.workSlots[0]!;
    const adopted = await store.adoptObservation({
      scope,
      executionId: "execution-1",
      expectedStreamVersion: adoptionTarget.stream.version,
      expectedExecutionVersion: adoptionTarget.execution.version,
      workSlotId: "slot-1",
      sourceLeaseId: source.leaseId,
      sourceFencingToken: source.fencingToken,
      sourceObservationId: "observation-1",
      observationRefId: "observation-ref-1",
      providerInvocationKey: source.providerInvocationKey,
      providerVoteIdentityHash: hash("1"),
      payloadHash: hash("6"),
      byteCount: 100,
      findingCount: 1,
      eligibilityPolicyVersion: "eligibility-v1",
      adoptionLeaseId: "adoption-lease-1",
      adoptionAcquireRequestIdHash: hash("2"),
      adoptionAcquireRequestHash: hash("3"),
      ownerIdHash: "owner-adoption",
      leaseCapabilityId: "capability-adoption",
      capabilitySigningKeyId: "signing-key-1",
      leaseSafetyDecisionHash: hash("4"),
      now: plus(6_000),
      retainUntil: plus(300_000),
    });
    expect(adopted.status).toBe(ReviewObservationAttachmentStatus.Attached);
    expect(adopted.snapshot?.execution.workSlots[0]?.nextAttemptOrdinal).toBe(
      before.nextAttemptOrdinal,
    );
    expect((await store.findLease("adoption-lease-1"))?.fencingToken).toBe(2n);
    expect((await store.findLease(source.leaseId))?.state).toBe(
      ReviewInvocationLeaseState.Released,
    );
  });

  it("keeps the source lease active when an adoption CAS fence is stale", async () => {
    const store = new InMemoryReviewExecutionStore(
      new MonotonicBigIntFencingTokenSource(),
    );
    await prepareAndAdmit(store, "execution-1", "1", revision, 2);
    const source = (await store.acquireLease(leaseCommand())).lease!;
    const target = (await store.findExecution("execution-1"))!;

    const stale = await store.adoptObservation({
      scope,
      executionId: "execution-1",
      expectedStreamVersion: target.stream.version + 1n,
      expectedExecutionVersion: target.execution.version,
      workSlotId: "slot-1",
      sourceLeaseId: source.leaseId,
      sourceFencingToken: source.fencingToken,
      sourceObservationId: "observation-1",
      observationRefId: "observation-ref-stale",
      providerInvocationKey: source.providerInvocationKey,
      providerVoteIdentityHash: hash("1"),
      payloadHash: hash("6"),
      byteCount: 100,
      findingCount: 1,
      eligibilityPolicyVersion: "eligibility-v1",
      adoptionLeaseId: "adoption-lease-stale",
      adoptionAcquireRequestIdHash: hash("2"),
      adoptionAcquireRequestHash: hash("3"),
      ownerIdHash: "owner-adoption",
      leaseCapabilityId: "capability-adoption",
      capabilitySigningKeyId: "signing-key-1",
      leaseSafetyDecisionHash: hash("4"),
      now: plus(6_000),
      retainUntil: plus(300_000),
    });

    expect(stale.status).toBe(ReviewObservationAttachmentStatus.Ineligible);
    expect(await store.findLease(source.leaseId)).toMatchObject({
      state: ReviewInvocationLeaseState.Active,
    });
    expect(await store.findLease("adoption-lease-stale")).toBeNull();
    expect(
      (await store.findExecution("execution-1"))?.execution.workSlots[0]
        ?.activeLeaseId,
    ).toBe(source.leaseId);
  });

  it("derives completed coverage from persisted required slots and issues an immutable permit", async () => {
    const store = new InMemoryReviewExecutionStore();
    await prepareAndAdmit(store);
    const lease = (await store.acquireLease(leaseCommand())).lease!;
    const attached = await store.attachObservation(attachmentCommand(lease));
    const command = finalizeCommand(attached.snapshot!);
    const result = await store.finalizeExecution(command);
    expect(result.status).toBe(ReviewExecutionFinalizeStatus.Finalized);
    expect(result.artifact).toMatchObject({
      coverageState: ReviewCoverageState.Completed,
      reviewedHeadSha: revision.headSha,
      reviewRevisionHash: revision.reviewRevisionHash,
      publicationPermit: {
        executionId: "execution-1",
        generation: 1n,
        reviewedHeadSha: revision.headSha,
        projectionHash: hash("5"),
      },
    });
    expect(result.snapshot?.execution.state).toBe(
      ReviewExecutionState.Completed,
    );
    expect(result.snapshot?.execution.finalizedArtifactId).toBe("artifact-1");

    const restored = await store.finalizeExecution(command);
    expect(restored.status).toBe(ReviewExecutionFinalizeStatus.Restored);
    const conflict = await store.finalizeExecution({
      ...command,
      artifactHash: hash("9"),
    });
    expect(conflict.status).toBe(ReviewExecutionFinalizeStatus.Conflict);

    const current = validatePublicationPermit({
      permit: result.artifact!.publicationPermit,
      stream: result.snapshot!.stream,
      projectionHash: result.artifact!.projectionHash,
      lifecycleStateHash: result.artifact!.lifecycleStateHash,
      commandLedgerWatermark: result.artifact!.commandLedgerWatermark,
      authorizationActive: true,
      producerReleaseActive: true,
      now: plus(6_000),
    });
    expect(current).toBe(PublicationPermitValidationStatus.Current);
    expect(
      validatePublicationPermit({
        permit: result.artifact!.publicationPermit,
        stream: {
          ...result.snapshot!.stream,
          lastAllocatedGeneration:
            result.snapshot!.stream.lastAllocatedGeneration + 1n,
        },
        projectionHash: result.artifact!.projectionHash,
        lifecycleStateHash: result.artifact!.lifecycleStateHash,
        commandLedgerWatermark: result.artifact!.commandLedgerWatermark,
        authorizationActive: true,
        producerReleaseActive: true,
        now: plus(6_000),
      }),
    ).toBe(PublicationPermitValidationStatus.Superseded);
  });

  it("cannot claim completed coverage while a required slot is unsatisfied", async () => {
    const store = new InMemoryReviewExecutionStore();
    const running = await prepareAndAdmit(store);
    const denied = await store.finalizeExecution({
      ...finalizeCommand(running),
      allowPartial: false,
    });
    expect(denied.status).toBe(
      ReviewExecutionFinalizeStatus.RequiredCoverageIncomplete,
    );
    expect((await store.findExecution("execution-1"))?.artifact).toBeNull();
    expect((await store.findExecution("execution-1"))?.execution.state).toBe(
      ReviewExecutionState.Running,
    );

    const partial = await store.finalizeExecution({
      ...finalizeCommand(running),
      allowPartial: true,
    });
    expect(partial.status).toBe(ReviewExecutionFinalizeStatus.Finalized);
    expect(partial.artifact?.coverageState).toBe(ReviewCoverageState.Partial);
    expect(partial.snapshot?.execution.state).toBe(
      ReviewExecutionState.Partial,
    );
  });

  it("returns detached snapshots that cannot mutate stored aggregate state", async () => {
    const store = new InMemoryReviewExecutionStore();
    const running = await prepareAndAdmit(store);
    Reflect.set(
      running.execution.workSlots[0]!,
      "state",
      ReviewWorkSlotState.Satisfied,
    );
    expect(
      (await store.findExecution("execution-1"))?.execution.workSlots[0]?.state,
    ).toBe(ReviewWorkSlotState.Pending);
  });
});

describe("durable ReviewRequested ingress", () => {
  it("restores an exact delivery and conflicts on changed canonical content", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    const candidate = intentCandidate("request-1", "1", scope, revision);
    const registered = await store.registerIntent({ candidate });
    const restored = await store.registerIntent({
      candidate: { ...candidate, requestId: "ignored-retry-id" },
    });
    const conflict = await store.registerIntent({
      candidate: {
        ...candidate,
        requestId: "conflicting-id",
        canonicalRequestHash: hash("9"),
      },
    });
    expect(registered.status).toBe(ReviewRequestedRegisterStatus.Registered);
    expect(restored.status).toBe(ReviewRequestedRegisterStatus.Restored);
    expect(restored.intent.requestId).toBe("request-1");
    expect(conflict.status).toBe(
      ReviewRequestedRegisterStatus.IdempotencyConflict,
    );
  });

  it("coalesces concurrent pending heads per PR without touching another PR", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    const [first, second, other] = await Promise.all([
      store.registerIntent({
        candidate: intentCandidate("request-1", "1", scope, revision),
      }),
      store.registerIntent({
        candidate: intentCandidate("request-2", "2", scope, nextRevision),
      }),
      store.registerIntent({
        candidate: intentCandidate("request-3", "3", otherScope, revision),
      }),
    ]);
    expect(first.status).toBe(ReviewRequestedRegisterStatus.Registered);
    expect(second.status).toBe(ReviewRequestedRegisterStatus.Registered);
    expect(other.status).toBe(ReviewRequestedRegisterStatus.Registered);
    expect((await store.findByRequestId("request-1"))?.state).toBe(
      ReviewRequestedIntentState.Superseded,
    );
    expect((await store.findPendingByScope(scope))?.requestId).toBe(
      "request-2",
    );
    expect((await store.findPendingByScope(otherScope))?.requestId).toBe(
      "request-3",
    );
  });

  it("keeps a dispatching intent and accepts a distinct same-SHA manual rerun as pending", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate("request-1", "1", scope, revision),
    });
    await store.claimIntent(claimIntent("request-1", "claim-1", "owner-1"));
    const rerun = await store.registerIntent({
      candidate: {
        ...intentCandidate("request-2", "2", scope, revision),
        triggerKind: ReviewRequestedTriggerKind.ManualCommand,
      },
    });
    expect(rerun.status).toBe(ReviewRequestedRegisterStatus.Registered);
    expect((await store.findByRequestId("request-1"))?.state).toBe(
      ReviewRequestedIntentState.Dispatching,
    );
    expect((await store.findPendingByScope(scope))?.requestId).toBe(
      "request-2",
    );
  });

  it("supersedes stale pre-admission work when a newer revision arrives", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate("request-old", "81", scope, revision),
    });
    const claim = await store.claimIntent(
      claimIntent("request-old", "claim-old", "owner-old"),
    );
    await beginClaimedSubmission(store, claim.intent!, plus(1));
    await store.recordDispatch({
      requestId: "request-old",
      claimId: "claim-old",
      ownerIdHash: "owner-old",
      fencingToken: claim.intent!.claim!.fencingToken,
      sourceRunId: "8001",
      sourceRunAttempt: "1",
      now: plus(2),
      ...resolutionWindow(plus(2)),
    });

    await store.registerIntent({
      candidate: intentCandidate("request-new", "82", scope, nextRevision),
    });

    expect(await store.findByRequestId("request-old")).toMatchObject({
      state: ReviewRequestedIntentState.Superseded,
      supersededByRequestId: "request-new",
    });
    expect((await store.findPendingByScope(scope))?.requestId).toBe(
      "request-new",
    );
  });

  it("restores a lost claim, fences takeover, and rejects the stale dispatcher acknowledgement", async () => {
    const tokens = new MonotonicBigIntFencingTokenSource(500n);
    const store = new InMemoryReviewRequestedIntentStore(tokens);
    await store.registerIntent({
      candidate: intentCandidate("request-1", "1", scope, revision),
    });
    const claim = claimIntent("request-1", "claim-1", "owner-1");
    const first = await store.claimIntent(claim);
    const retry = await store.claimIntent(claim);
    expect(first.status).toBe(ReviewRequestedClaimStatus.Claimed);
    expect(retry.status).toBe(ReviewRequestedClaimStatus.Restored);
    expect(first.intent?.claim?.fencingToken).toBe(501n);

    const takeover = await store.claimIntent({
      ...claimIntent("request-1", "claim-2", "owner-2"),
      now: plus(31_000),
      claimUntil: plus(61_000),
    });
    expect(takeover.status).toBe(ReviewRequestedClaimStatus.Claimed);
    expect(takeover.intent?.claim?.fencingToken).toBe(502n);
    await beginClaimedSubmission(store, takeover.intent!, plus(32_000));

    const staleAck = await store.recordDispatch({
      requestId: "request-1",
      claimId: "claim-1",
      ownerIdHash: "owner-1",
      fencingToken: 501n,
      sourceRunId: "run-old",
      sourceRunAttempt: "1",
      now: plus(32_000),
      ...resolutionWindow(plus(32_000)),
    });
    expect(staleAck.status).toBe(ReviewRequestedTransitionStatus.StaleClaim);
    const applied = await store.recordDispatch({
      requestId: "request-1",
      claimId: "claim-2",
      ownerIdHash: "owner-2",
      fencingToken: 502n,
      sourceRunId: "run-new",
      sourceRunAttempt: "1",
      now: plus(33_000),
      ...resolutionWindow(plus(33_000)),
    });
    expect(applied.status).toBe(ReviewRequestedTransitionStatus.Applied);
    expect(applied.intent?.state).toBe(
      ReviewRequestedIntentState.AwaitingAuthorization,
    );
  });

  it("links one exact authorization/execution admission and rejects drift", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate("request-1", "1", scope, revision),
    });
    const claimed = await store.claimIntent(
      claimIntent("request-1", "claim-1", "owner-1"),
    );
    await beginClaimedSubmission(store, claimed.intent!, plus(500));
    await store.recordDispatch({
      requestId: "request-1",
      claimId: "claim-1",
      ownerIdHash: "owner-1",
      fencingToken: claimed.intent!.claim!.fencingToken,
      sourceRunId: "run-1",
      sourceRunAttempt: "1",
      now: plus(1_000),
      ...resolutionWindow(plus(1_000)),
    });
    const command = {
      requestId: "request-1",
      sourceRunId: "run-1",
      sourceRunAttempt: "1",
      authorizationId: "authorization-1",
      executionId: "execution-1",
      revision,
      now: plus(2_000),
    };
    const linked = await store.linkAdmission(command);
    const restored = await store.linkAdmission(command);
    const conflict = await store.linkAdmission({
      ...command,
      executionId: "execution-2",
    });
    expect(linked.status).toBe(ReviewRequestedTransitionStatus.Applied);
    expect(restored.status).toBe(ReviewRequestedTransitionStatus.Restored);
    expect(conflict.status).toBe(ReviewRequestedTransitionStatus.Conflict);
  });

  it("replaces a terminal pre-admission run with a fresh request identity", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate("request-old", "61", scope, revision),
    });
    const claimed = await store.claimIntent(
      claimIntent("request-old", "claim-old", "owner-old"),
    );
    await beginClaimedSubmission(store, claimed.intent!, plus(500));
    await store.recordDispatch({
      requestId: "request-old",
      claimId: "claim-old",
      ownerIdHash: "owner-old",
      fencingToken: claimed.intent!.claim!.fencingToken,
      sourceRunId: "9001",
      sourceRunAttempt: "1",
      now: plus(1_000),
      ...resolutionWindow(plus(1_000)),
    });
    const recovery = new RecoverReviewRequestedDispatches(
      store,
      store,
      {
        async prepare() {
          return {
            async submit() {
              return {
                status:
                  ReviewRequestedDispatchSubmissionStatus.Accepted as const,
                sourceRunId: "not-used",
                sourceRunAttempt: "1",
              };
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return {
            status: ReviewRequestedDispatchRunStatus.TerminalCurrentRevision,
          };
        },
        async cancelKnownRun() {},
      },
      { now: () => plus(10_000) },
      {
        ids: { nextRequestId: () => "request-retry" },
        digest: {
          digestUtf8: async (value) =>
            createHash("sha256").update(value).digest("hex"),
        },
      },
      testDispatchPolicy(),
    );

    expect(await recovery.execute({ limit: 10 })).toEqual({
      scanned: 1,
      pending: 0,
      recovered: 1,
      failed: 0,
    });
    expect(await store.findByRequestId("request-old")).toMatchObject({
      state: ReviewRequestedIntentState.Superseded,
      supersededByRequestId: "request-retry",
      sourceRunId: "9001",
    });
    expect(await store.findPendingByScope(scope)).toMatchObject({
      requestId: "request-retry",
      state: ReviewRequestedIntentState.PendingDispatch,
      sourceRunId: null,
    });
  });

  it("terminalizes a stale-revision run without dispatching the old SHA again", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate("request-stale", "91", scope, revision),
    });
    const claimed = await store.claimIntent(
      claimIntent("request-stale", "claim-stale", "owner-stale"),
    );
    await beginClaimedSubmission(store, claimed.intent!, plus(500));
    await store.recordDispatch({
      requestId: "request-stale",
      claimId: "claim-stale",
      ownerIdHash: "owner-stale",
      fencingToken: claimed.intent!.claim!.fencingToken,
      sourceRunId: "9002",
      sourceRunAttempt: "1",
      now: plus(1_000),
      ...resolutionWindow(plus(1_000)),
    });
    const recovery = new RecoverReviewRequestedDispatches(
      store,
      store,
      {
        async prepare() {
          return {
            async submit() {
              return {
                status:
                  ReviewRequestedDispatchSubmissionStatus.Accepted as const,
                sourceRunId: "not-used",
                sourceRunAttempt: "1",
              };
            },
          };
        },
        async findByRequestIdentity() {
          return {
            status: ReviewRequestedDispatchLookupStatus.Absent as const,
          };
        },
        async inspectKnownRun() {
          return {
            status: ReviewRequestedDispatchRunStatus.TerminalStaleRevision,
          };
        },
        async cancelKnownRun() {},
      },
      { now: () => plus(10_000) },
      {
        ids: { nextRequestId: () => "must-not-be-used" },
        digest: {
          digestUtf8: async () => {
            throw new Error("must_not_hash_retry");
          },
        },
      },
      testDispatchPolicy(),
    );

    expect(await recovery.execute({ limit: 10 })).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(await store.findByRequestId("request-stale")).toMatchObject({
      state: ReviewRequestedIntentState.Superseded,
      supersededByRequestId: null,
    });
    expect(await store.findPendingByScope(scope)).toBeNull();
  });

  it("orders and bounds due intents", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    await store.registerIntent({
      candidate: intentCandidate(
        "request-1",
        "1",
        scope,
        revision,
        plus(20_000),
      ),
    });
    await store.registerIntent({
      candidate: intentCandidate(
        "request-2",
        "2",
        otherScope,
        revision,
        plus(10_000),
      ),
    });
    expect(await store.listDue({ now: plus(9_000), limit: 10 })).toHaveLength(
      0,
    );
    expect(
      (await store.listDue({ now: plus(30_000), limit: 1 })).map(
        (intent) => intent.requestId,
      ),
    ).toEqual(["request-2"]);
  });
});

function prepareCommand(
  overrides: {
    readonly executionId?: string;
    readonly expectedStreamVersion?: bigint;
    readonly identitySeed?: string;
    readonly revision?: ReviewRevision;
    readonly now?: Date;
    readonly attemptBudget?: number;
    readonly scope?: ReviewExecutionScope;
  } = {},
): PrepareReviewExecutionCommand {
  const now = overrides.now ?? baseTime;
  return {
    scope: overrides.scope ?? scope,
    expectedStreamVersion: overrides.expectedStreamVersion ?? 0n,
    executionId: overrides.executionId ?? "execution-1",
    authorizationId: "authorization-1",
    producerReleaseId: "producer-release-1",
    mutationEpoch: 1n,
    revision: overrides.revision ?? revision,
    startIdentityHash: hash(overrides.identitySeed ?? "1"),
    canonicalStartHash: hash(overrides.identitySeed ?? "2"),
    admissionSafetyDecisionHash: hash("3"),
    compatibilityKey: "compatibility-v1",
    planHash: hash("4"),
    workSlots: [slotFixture("slot-1", true, overrides.attemptBudget ?? 1)],
    limits,
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    now,
    admissionDeadlineAt: new Date(now.getTime() + 60_000),
    executionDeadlineAt: new Date(now.getTime() + 600_000),
    retainUntil: new Date(now.getTime() + 3_600_000),
  };
}

async function prepareAndAdmit(
  store: InMemoryReviewExecutionStore,
  executionId = "execution-1",
  identitySeed = "1",
  requestedRevision = revision,
  attemptBudget = 1,
  requestedScope = scope,
) {
  const prepared = await store.prepareExecution(
    prepareCommand({
      executionId,
      identitySeed,
      revision: requestedRevision,
      attemptBudget,
      scope: requestedScope,
    }),
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

function leaseCommand(
  overrides: {
    readonly expectedExecutionId?: string;
    readonly leaseId?: string;
    readonly attemptId?: string;
    readonly requestSeed?: string;
    readonly ownerIdHash?: string;
    readonly capabilityId?: string;
    readonly now?: Date;
    readonly expiresAt?: Date;
    readonly reportUntil?: Date;
    readonly scope?: ReviewExecutionScope;
  } = {},
) {
  return {
    scope: overrides.scope ?? scope,
    executionId: overrides.expectedExecutionId ?? "execution-1",
    workSlotId: "slot-1",
    purpose: ReviewInvocationLeasePurpose.ProviderExecution,
    providerInvocationKey: hash("5"),
    preparedManifestCanonicalJson: '{"manifestVersion":1}',
    preparedManifestKey: hash("9"),
    providerVoteIdentityHash: hash("1"),
    leaseId: overrides.leaseId ?? "lease-1",
    attemptId: overrides.attemptId ?? "attempt-1",
    sourceObservationId: null,
    acquireRequestIdHash: hash(overrides.requestSeed ?? "6"),
    acquireRequestHash: hash(overrides.requestSeed ?? "7"),
    ownerIdHash: overrides.ownerIdHash ?? "owner-1",
    leaseCapabilityId: overrides.capabilityId ?? "capability-1",
    capabilitySigningKeyId: "signing-key-1",
    leaseSafetyDecisionHash: hash("8"),
    now: overrides.now ?? plus(2),
    expiresAt: overrides.expiresAt ?? plus(30_000),
    resultReportUntil: overrides.reportUntil ?? plus(60_000),
    retainUntil: plus(300_000),
    limits,
  } as const;
}

function attachmentCommand(
  lease: {
    readonly leaseId: string;
    readonly ownerIdHash: string;
    readonly leaseCapabilityId: string;
    readonly fencingToken: bigint;
    readonly providerInvocationKey: string;
  },
  overrides: {
    readonly observationRefId?: string;
    readonly observationId?: string;
    readonly now?: Date;
  } = {},
) {
  return {
    scope,
    executionId: "execution-1",
    workSlotId: "slot-1",
    observationRefId: overrides.observationRefId ?? "observation-ref-1",
    observationId: overrides.observationId ?? "observation-1",
    providerInvocationKey: lease.providerInvocationKey,
    providerVoteIdentityHash: hash("1"),
    payloadHash: hash("6"),
    byteCount: 100,
    findingCount: 1,
    eligibilityPolicyVersion: "eligibility-v1",
    leaseId: lease.leaseId,
    ownerIdHash: lease.ownerIdHash,
    leaseCapabilityId: lease.leaseCapabilityId,
    fencingToken: lease.fencingToken,
    now: overrides.now ?? plus(3),
  };
}

function reusableAttachmentCommand(input: {
  readonly sourceExecutionId: string;
}) {
  return {
    scope,
    executionId: "execution-1",
    workSlotId: "slot-1",
    sourceExecutionId: input.sourceExecutionId,
    observationRefId: "observation-ref-1",
    observationId: "observation-1",
    providerInvocationKey: hash("5"),
    providerVoteIdentityHash: hash("1"),
    payloadHash: hash("6"),
    byteCount: 100,
    findingCount: 1,
    attachmentKind: ReviewObservationAttachmentKind.ExactRevisionReuse,
    eligibilityPolicyVersion: "eligibility-v1",
    reuseSafetyDecisionHash: hash("7"),
    now: plus(3),
  } as const;
}

function finalizeCommand(snapshot: {
  readonly stream: { readonly version: bigint };
  readonly execution: { readonly version: bigint };
}) {
  const envelope = JSON.stringify({ findings: [] });
  return {
    scope,
    executionId: "execution-1",
    expectedStreamVersion: snapshot.stream.version,
    expectedExecutionVersion: snapshot.execution.version,
    artifactId: "artifact-1",
    artifactHash: hash("4"),
    projectionEnvelopeVersion: 1,
    projectionEnvelopeJson: envelope,
    projectionHash: hash("5"),
    byteCount: new TextEncoder().encode(envelope).byteLength,
    findingCount: 0,
    lifecycleStateHash: hash("6"),
    commandLedgerWatermark: 3n,
    projectionPolicyVersion: "projection-v1",
    publicationSafetyDecisionHash: hash("7"),
    publicationNotAfter: plus(120_000),
    permitEpoch: 1n,
    allowPartial: false,
    limits,
    now: plus(5_000),
    retainUntil: plus(300_000),
  };
}

function intentCandidate(
  requestId: string,
  seed: string,
  requestedScope: ReviewExecutionScope,
  requestedRevision: ReviewRevision,
  notBefore = baseTime,
) {
  return {
    ...requestedScope,
    requestId,
    revision: requestedRevision,
    triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
    deliveryIdentityHash: hash(seed),
    canonicalRequestHash: hash(String(Number(seed) + 4)),
    notBefore,
    createdAt: baseTime,
    retainUntil: plus(3_600_000),
  };
}

function claimIntent(requestId: string, claimId: string, ownerIdHash: string) {
  return {
    requestId,
    claimId,
    ownerIdHash,
    now: baseTime,
    claimUntil: plus(30_000),
  };
}

async function beginClaimedSubmission(
  store: InMemoryReviewRequestedIntentStore,
  intent: ReviewRequestedIntent,
  now: Date,
) {
  const claim = intent.claim;
  if (claim === null) throw new Error("test_claim_missing");
  return store.beginSubmission({
    requestId: intent.requestId,
    claimId: claim.claimId,
    ownerIdHash: claim.ownerIdHash,
    fencingToken: claim.fencingToken,
    now,
    ...resolutionWindow(now),
  });
}

function resolutionWindow(now: Date) {
  return {
    nextResolutionAt: new Date(now.getTime() + 1_000),
    resolutionDeadlineAt: new Date(now.getTime() + 60_000),
  };
}

function testDispatchPolicy() {
  return {
    claimDurationMs: 30_000,
    dispatchResolutionDelayMs: 1_000,
    dispatchResolutionTimeoutMs: 60_000,
    authorizationResolutionDelayMs: 1_000,
    authorizationResolutionTimeoutMs: 60_000,
    retryDelayMs: 2_000,
    retentionMs: 86_400_000,
    maxDispatchAttempts: 3,
  };
}

function leaseTerm(lease: {
  readonly leaseId: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
}) {
  return {
    leaseId: lease.leaseId,
    ownerIdHash: lease.ownerIdHash,
    leaseCapabilityId: lease.leaseCapabilityId,
    fencingToken: lease.fencingToken,
  };
}

function slotFixture(id: string, required: boolean, attemptBudget: number) {
  return {
    workSlotId: id,
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    providerVoteIdentityHash: hash("1"),
    shardKey: "shard-1",
    required,
    attemptBudget,
    retryPolicyVersion: "retry-v1",
  };
}

function startInput(executionId: string) {
  return {
    scope,
    executionId,
    authorizationId: "authorization-1",
    compatibilityKey: "compatibility-v1",
    planHash: hash("4"),
    workSlots: [slotFixture("slot-1", true, 1)],
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    admissionDeadlineAt: plus(60_000),
    executionDeadlineAt: plus(600_000),
    retainUntil: plus(3_600_000),
  };
}

function startUseCase(
  store: InMemoryReviewExecutionStore,
  input: {
    readonly authorizationRevision: ReviewRevision;
    readonly revisions: readonly (ReviewRevision | null)[];
  },
) {
  const facts = authorizationFactsFixture(input.authorizationRevision);
  return startUseCaseWithPorts(store, {
    authorizationFind: async (authorizationId) =>
      authorizationId === facts.authorizationId ? facts : null,
    revisions: input.revisions,
  });
}

function authorizationFactsFixture(
  authorizationRevision: ReviewRevision,
): ReviewExecutionAuthorizationFacts {
  return {
    authorizationId: "authorization-1",
    scope,
    revision: authorizationRevision,
    producerReleaseId: "producer-release-1",
    mutationEpoch: 1n,
    admissionSafetyDecisionHash: hash("3"),
    limits,
    expiresAt: plus(3_600_000),
    active: true,
  };
}

function startUseCaseWithPorts(
  store: InMemoryReviewExecutionStore,
  input: {
    readonly authorizationFind: ReviewExecutionAuthorizationFactsPort["find"];
    readonly revisions: readonly (ReviewRevision | null)[];
    readonly clock?: ClockPort;
    readonly onRevisionResolve?: (index: number) => void;
    readonly requestedIntentAdmission?: {
      readonly queries: InMemoryReviewRequestedIntentStore;
      readonly commands: InMemoryReviewRequestedIntentStore;
      readonly required: boolean;
    };
  },
) {
  const authorizationPort: ReviewExecutionAuthorizationFactsPort = {
    find: input.authorizationFind,
  };
  let revisionIndex = 0;
  const revisionPort: CurrentReviewRevisionPort = {
    resolve: async () => {
      input.onRevisionResolve?.(revisionIndex);
      const value =
        input.revisions[Math.min(revisionIndex, input.revisions.length - 1)] ??
        null;
      revisionIndex += 1;
      return value
        ? { status: CurrentReviewRevisionStatus.Found, revision: value }
        : { status: CurrentReviewRevisionStatus.Unavailable };
    },
  };
  const digest: Sha256DigestPort = {
    digestUtf8: async (value) =>
      createHash("sha256").update(value, "utf8").digest("hex"),
  };
  const clock: ClockPort =
    input.clock ?? ({ now: () => new Date(baseTime) } satisfies ClockPort);
  return new StartReviewExecution(
    authorizationPort,
    revisionPort,
    store,
    store,
    digest,
    clock,
    input.requestedIntentAdmission,
  );
}

function revisionFixture(
  base: string,
  mergeBase: string,
  head: string,
  digest: string,
): ReviewRevision {
  return {
    baseSha: base.repeat(40),
    mergeBaseSha: mergeBase.repeat(40),
    headSha: head.repeat(40),
    reviewRevisionHash: hash(digest),
  };
}

function plus(milliseconds: number): Date {
  return new Date(baseTime.getTime() + milliseconds);
}

function hash(character: string): string {
  return character.repeat(64).slice(0, 64);
}
