import { describe, expect, it } from "vitest";
import {
  AdjudicateReviewPublicationOutcomeStatus,
  BeginReviewPublicationOperationStatus,
  ClaimReviewPublicationStatus,
  CompleteReviewPublicationOperationStatus,
  CurrentMutationAuthorityStatus,
  CurrentPublicationLifecycleStatus,
  CurrentPublicationPermitStatus,
  CurrentReviewPublicationFact,
  CurrentReviewRevisionStatus,
  CurrentReviewSafetyDecisionStatus,
  RecordReviewExternalEffectStatus,
  RequestReviewPublicationStatus,
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationCapabilityDisabledError,
  ReviewPublicationCorrectionReason,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationGateRejectedError,
  ReviewPublicationGateRejectionReason,
  ReviewPublicationKind,
  ReviewPublicationOperationAttemptState,
  ReviewPublicationOperationState,
  ReviewPublicationOperationRole,
  ReviewPublicationRunControlStatus,
  ReviewPublicationTerminalOutcome,
  TerminalizeUnknownReviewPublicationStatus,
  effectiveReviewPublicationOutcome,
  type ReviewPublicationAttempt,
  type ReviewPublicationClaimTerm,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationOperationPlan,
  type ReviewPublicationPermitIdentity,
  type ReviewPublicationProvenReceipt,
} from "../index";
import { createReviewPublicationV2Application } from "../composition";
import {
  InMemoryReviewPublicationRepository,
  MutableReviewPublicationClock,
  allowingReviewPublicationDecisionPorts,
} from "../testing";

const at = (value: string): Date => new Date(value);
const hash = (character: string): string => character.repeat(64);
const initialTime = at("2026-07-22T12:00:00.000Z");

describe("review publication v2", () => {
  it("keeps effect-bearing capabilities disabled by default at composition", async () => {
    const harness = createHarness({ enableCapabilities: false });
    await expect(harness.application.request(requestCommand())).rejects.toEqual(
      new ReviewPublicationCapabilityDisabledError(
        ReviewPublicationCapability.Request,
      ),
    );
    expect(await harness.repository.findById("publication-1")).toBeNull();
  });

  it("restores identical publication requests and rejects request or identity drift", async () => {
    const harness = createHarness();
    const command = requestCommand();
    expect(await harness.application.request(command)).toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
      attempt: { version: 1n },
    });
    expect(await harness.application.request(command)).toMatchObject({
      status: RequestReviewPublicationStatus.Restored,
      attempt: { publicationAttemptId: "publication-1" },
    });
    expect(
      await harness.application.request({
        ...command,
        requestIdHash: hash("2"),
      }),
    ).toMatchObject({ status: RequestReviewPublicationStatus.Restored });
    expect(
      await harness.application.request({
        ...command,
        requestHash: hash("9"),
      }),
    ).toEqual({ status: RequestReviewPublicationStatus.RequestConflict });
    expect(
      await harness.application.request({
        ...command,
        publicationAttemptId: "publication-other",
        requestIdHash: hash("3"),
        requestHash: hash("8"),
      }),
    ).toEqual({ status: RequestReviewPublicationStatus.IdentityConflict });

    command.operations[0]?.reconcileUntil.setUTCFullYear(2030);
    const stored = await requiredView(harness.repository);
    expect(stored.attempt.operations[0]?.reconcileUntil).toEqual(
      at("2026-07-22T16:00:00.000Z"),
    );
  });

  it("accepts GitHub SHA-1 commit identities without weakening SHA-256 digests", async () => {
    const commitId = "a".repeat(40);
    const permit = { ...permitIdentity(), reviewedHeadSha: commitId };
    const harness = createHarness({ permit });

    await expect(
      harness.application.request(
        requestCommand({
          permit,
          operations: [operationPlan({ targetCommitId: commitId })],
        }),
      ),
    ).resolves.toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
    });
  });

  it.each([
    [
      "permit",
      {
        permits: {
          async resolve() {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "projection_replaced",
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.PermitNotCurrent,
    ],
    [
      "run control",
      {
        runControl: {
          async resolve(input: {
            authorizationId: string;
            producerReleaseId: string;
          }) {
            return {
              status: ReviewPublicationRunControlStatus.AuthorizationRevoked,
              ...input,
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.RunControlDenied,
    ],
    [
      "authority",
      {
        authority: {
          async resolve() {
            return {
              status: CurrentMutationAuthorityStatus.Inactive,
              mutationEpoch: null,
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.MutationAuthorityNotActive,
    ],
    [
      "revision",
      {
        revision: {
          async resolve() {
            return {
              status: CurrentReviewRevisionStatus.Changed,
              reviewedHeadSha: hash("f"),
              reviewRevisionHash: hash("e"),
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.RevisionNotCurrent,
    ],
    [
      "lifecycle",
      {
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Changed,
              lifecycleStateHash: hash("f"),
              commandLedgerWatermark: 2n,
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.LifecycleStatusNotCurrent,
    ],
    [
      "lifecycle missing",
      {
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Missing,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.LifecycleStatusNotCurrent,
    ],
    [
      "safety",
      {
        safety: {
          async resolve() {
            return {
              status: CurrentReviewSafetyDecisionStatus.Disabled,
              decisionHash: null,
            } as const;
          },
        },
      },
      ReviewPublicationGateRejectionReason.SafetyDenied,
    ],
  ] as const)(
    "fails closed when the %s decision is not current",
    async (_, override, reason) => {
      const harness = createHarness({ decisionOverrides: override });
      await expect(
        harness.application.request(requestCommand()),
      ).rejects.toEqual(new ReviewPublicationGateRejectedError(reason));
    },
  );

  it.each([
    [
      "permit",
      CurrentReviewPublicationFact.Permit,
      {
        permits: {
          async resolve() {
            return {
              status: CurrentPublicationPermitStatus.Unavailable,
              reason: "provider_timeout",
            } as const;
          },
        },
      },
    ],
    [
      "run control",
      CurrentReviewPublicationFact.RunControl,
      {
        runControl: {
          async resolve(input: {
            authorizationId: string;
            producerReleaseId: string;
          }) {
            return {
              status: ReviewPublicationRunControlStatus.Unavailable,
              ...input,
            } as const;
          },
        },
      },
    ],
    [
      "mutation authority",
      CurrentReviewPublicationFact.MutationAuthority,
      {
        authority: {
          async resolve() {
            return {
              status: CurrentMutationAuthorityStatus.Unavailable,
              mutationEpoch: null,
            } as const;
          },
        },
      },
    ],
    [
      "revision",
      CurrentReviewPublicationFact.Revision,
      {
        revision: {
          async resolve() {
            return {
              status: CurrentReviewRevisionStatus.Unavailable,
              reviewedHeadSha: null,
              reviewRevisionHash: null,
            } as const;
          },
        },
      },
    ],
    [
      "lifecycle",
      CurrentReviewPublicationFact.Lifecycle,
      {
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Unavailable,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
    ],
    [
      "safety",
      CurrentReviewPublicationFact.Safety,
      {
        safety: {
          async resolve() {
            return {
              status: CurrentReviewSafetyDecisionStatus.Unavailable,
              decisionHash: null,
            } as const;
          },
        },
      },
    ],
  ] as const)(
    "classifies unavailable %s facts as retryable provider-neutral capacity",
    async (_, fact, override) => {
      const harness = createHarness({ decisionOverrides: override });

      await expect(
        harness.application.request(requestCommand()),
      ).rejects.toEqual(
        new ReviewPublicationGateRejectedError(
          ReviewPublicationGateRejectionReason.PublicationFactsUnavailable,
          [fact],
        ),
      );
    },
  );

  it("reports multiple unavailable facts in canonical order", async () => {
    const harness = createHarness({
      decisionOverrides: {
        runControl: {
          async resolve(input: {
            authorizationId: string;
            producerReleaseId: string;
          }) {
            return {
              status: ReviewPublicationRunControlStatus.Unavailable,
              ...input,
            } as const;
          },
        },
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Unavailable,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
    });

    await expect(harness.application.request(requestCommand())).rejects.toEqual(
      new ReviewPublicationGateRejectedError(
        ReviewPublicationGateRejectionReason.PublicationFactsUnavailable,
        [
          CurrentReviewPublicationFact.Lifecycle,
          CurrentReviewPublicationFact.RunControl,
        ],
      ),
    );
  });

  it("canonicalizes unavailable fact diagnostics and omits them for other rejections", () => {
    expect(
      new ReviewPublicationGateRejectedError(
        ReviewPublicationGateRejectionReason.PublicationFactsUnavailable,
        [
          CurrentReviewPublicationFact.Safety,
          CurrentReviewPublicationFact.Lifecycle,
          CurrentReviewPublicationFact.Safety,
        ],
      ).unavailableFacts,
    ).toEqual([
      CurrentReviewPublicationFact.Lifecycle,
      CurrentReviewPublicationFact.Safety,
    ]);
    expect(
      new ReviewPublicationGateRejectedError(
        ReviewPublicationGateRejectionReason.PermitNotCurrent,
      ),
    ).not.toHaveProperty("unavailableFacts");
    expect(() =>
      Reflect.construct(ReviewPublicationGateRejectedError, [
        ReviewPublicationGateRejectionReason.PermitNotCurrent,
        [CurrentReviewPublicationFact.Permit],
      ]),
    ).toThrow("publication_unavailable_facts_require_unavailable_rejection");
    expect(() =>
      Reflect.construct(ReviewPublicationGateRejectedError, [
        ReviewPublicationGateRejectionReason.PublicationFactsUnavailable,
        ["unknown_fact"],
      ]),
    ).toThrow("publication_facts_unavailable_contains_unknown_fact");
  });

  it("classifies every unavailable fact before earlier generic not-current checks", async () => {
    const harness = createHarness({
      decisionOverrides: {
        permits: {
          async resolve() {
            return {
              status: CurrentPublicationPermitStatus.Stale,
              reason: "projection_replaced",
            } as const;
          },
        },
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Unavailable,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
    });

    await expect(harness.application.request(requestCommand())).rejects.toEqual(
      new ReviewPublicationGateRejectedError(
        ReviewPublicationGateRejectionReason.PublicationFactsUnavailable,
        [CurrentReviewPublicationFact.Lifecycle],
      ),
    );
  });

  it.each([
    [
      "lifecycle hash",
      {
        lifecycleStateHash: hash("f"),
        commandLedgerWatermark: 2n,
      },
      ReviewPublicationGateRejectionReason.LifecycleHashMismatch,
    ],
    [
      "lifecycle watermark",
      {
        lifecycleStateHash: hash("d"),
        commandLedgerWatermark: 3n,
      },
      ReviewPublicationGateRejectionReason.LifecycleWatermarkMismatch,
    ],
  ] as const)(
    "reports a granular stale reason when the %s changed",
    async (_, lifecycle, reason) => {
      const harness = createHarness({
        decisionOverrides: {
          lifecycle: {
            async resolve() {
              return {
                status: CurrentPublicationLifecycleStatus.Current,
                ...lifecycle,
              } as const;
            },
          },
        },
      });

      await expect(
        harness.application.request(requestCommand()),
      ).rejects.toEqual(new ReviewPublicationGateRejectedError(reason));
    },
  );

  it("rechecks every permit/release/authority/revision/lifecycle/safety port before request, claim, and begin", async () => {
    const permit = permitIdentity();
    const calls = {
      permits: 0,
      runControl: 0,
      authority: 0,
      revision: 0,
      lifecycle: 0,
      safety: 0,
    };
    const allowed = allowingReviewPublicationDecisionPorts(permit);
    const decisions = Object.fromEntries(
      Object.entries(allowed).map(([key, port]) => [
        key,
        {
          async resolve(input: never) {
            calls[key as keyof typeof calls] += 1;
            return port.resolve(input);
          },
        },
      ]),
    ) as unknown as ReviewPublicationDecisionPorts;
    const harness = createHarness({ permit, decisions });
    await harness.application.request(requestCommand({ permit }));
    const claim = await harness.application.claim(claimCommand());
    expect(claim.status).toBe(ClaimReviewPublicationStatus.Acquired);
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    await harness.application.beginOperation(
      beginCommand({
        expectedAttemptVersion: claim.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
      }),
    );
    expect(calls).toEqual({
      permits: 3,
      runControl: 3,
      authority: 3,
      revision: 3,
      lifecycle: 3,
      safety: 3,
    });
  });

  it("restores lost claim/begin acknowledgements and never reuses bigint fences", async () => {
    const harness = createHarness();
    await harness.application.request(requestCommand());
    const firstClaimCommand = claimCommand();
    const first = await harness.application.claim(firstClaimCommand);
    expect(first).toMatchObject({
      status: ClaimReviewPublicationStatus.Acquired,
      claim: { fencingToken: 1n },
    });
    harness.clock.set(at("2026-07-22T12:01:00.000Z"));
    const restored = await harness.application.claim(firstClaimCommand);
    expect(restored).toMatchObject({
      status: ClaimReviewPublicationStatus.Restored,
      claim: { fencingToken: 1n },
    });
    expect(
      await harness.application.claim({
        ...firstClaimCommand,
        requestHash: hash("9"),
      }),
    ).toEqual({ status: ClaimReviewPublicationStatus.RequestConflict });
    if (first.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    const begin = beginCommand({
      expectedAttemptVersion: first.attempt.version,
      claimId: first.claim.claimId,
      claimFencingToken: first.claim.fencingToken,
    });
    const begun = await harness.application.beginOperation(begin);
    expect(begun).toMatchObject({
      status: BeginReviewPublicationOperationStatus.Begun,
      capability: { claimFencingToken: 1n, effectReportId: "effect-report-1" },
    });
    harness.clock.set(at("2026-07-22T12:02:00.000Z"));
    expect(await harness.application.beginOperation(begin)).toMatchObject({
      status: BeginReviewPublicationOperationStatus.Restored,
      operationAttempt: { operationAttemptId: "operation-attempt-1" },
    });
    expect(
      await harness.application.beginOperation({
        ...begin,
        requestHash: hash("9"),
      }),
    ).toEqual({
      status: BeginReviewPublicationOperationStatus.RequestConflict,
    });

    harness.clock.set(at("2026-07-22T13:01:00.000Z"));
    const view = await requiredView(harness.repository);
    const takeover = await harness.application.claim(
      claimCommand({
        expectedAttemptVersion: view.attempt.version,
        claimId: "claim-2",
        requestIdHash: hash("7"),
        requestHash: hash("8"),
        expiresAt: at("2026-07-22T14:00:00.000Z"),
      }),
    );
    expect(takeover).toMatchObject({
      status: ClaimReviewPublicationStatus.Acquired,
      claim: { fencingToken: 2n },
    });
    if (takeover.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_takeover_failed");
    }
    expect(
      await harness.application.beginOperation(
        beginCommand({
          expectedAttemptVersion: takeover.attempt.version,
          claimId: first.claim.claimId,
          claimFencingToken: first.claim.fencingToken,
          ordinal: 3,
        }),
      ),
    ).toEqual({ status: BeginReviewPublicationOperationStatus.StaleClaim });
  });

  it("rejects no-effect terminalization while a sibling has execution evidence", async () => {
    const harness = createHarness();
    await harness.application.request(
      requestCommand({ operations: independentOperationPlans() }),
    );
    const claim = await harness.application.claim(claimCommand());
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    const begun = await harness.application.beginOperation(
      beginCommand({
        operationId: "operation-1",
        expectedAttemptVersion: claim.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
      }),
    );
    if (begun.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("test_begin_failed");
    }

    await expect(
      harness.application.terminalizeUnknown({
        publicationAttemptId: "publication-1",
        publicationOperationId: "operation-2",
        expectedAttemptVersion: begun.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        tombstoneId: "tombstone-operation-2",
        siblingTombstones: [],
        finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        finalReason: "operation_superseded",
        lastErrorCode: "publication_live_facts_changed",
        terminalizedBy: "worker-1",
        retainUntil: at("2026-08-22T16:01:00.000Z"),
      }),
    ).resolves.toEqual({
      status: TerminalizeUnknownReviewPublicationStatus.ExternalEffectRisk,
    });
    await expect(
      harness.application.terminalizeUnknown({
        publicationAttemptId: "publication-1",
        publicationOperationId: "operation-1",
        expectedAttemptVersion: begun.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        tombstoneId: "tombstone-operation-1",
        siblingTombstones: [],
        finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
        finalReason: "provider_rejected_without_effect",
        lastErrorCode: "provider_rejected",
        terminalizedBy: "worker-1",
        retainUntil: at("2026-08-22T16:01:00.000Z"),
      }),
    ).resolves.toEqual({
      status: TerminalizeUnknownReviewPublicationStatus.ExternalEffectRisk,
    });
    expect(await requiredView(harness.repository)).toMatchObject({
      attempt: {
        state: "publishing",
        terminalOutcome: null,
        operations: [
          { publicationOperationId: "operation-1", state: "in_flight" },
          { publicationOperationId: "operation-2", state: "planned" },
        ],
      },
      tombstones: [],
    });
  });

  it("persists and restores an exact no-effect proof and rejects later effects", async () => {
    const harness = createHarness();
    const { begun } = await requestClaimBegin(harness);
    const proofFacts = {
      capability: begun.capability,
      noEffectProofId: "no-effect-proof-1",
      noEffectReason: "provider_rejected_without_effect",
    } as const;
    const proof = proofFacts;

    const wrongFenceFacts = {
      ...proofFacts,
      capability: {
        ...proofFacts.capability,
        claimFencingToken: proofFacts.capability.claimFencingToken + 1n,
      },
      noEffectProofId: "no-effect-proof-wrong-fence",
    } as const;
    await expect(
      harness.application.proveNoEffect(wrongFenceFacts),
    ).resolves.toEqual({ status: "capability_mismatch" });

    await expect(
      harness.application.proveNoEffect(proof),
    ).resolves.toMatchObject({
      status: "proven",
      operationAttempt: {
        state: "no_effect_proven",
        noEffectProofId: proof.noEffectProofId,
        noEffectProofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        noEffectReason: proof.noEffectReason,
      },
    });
    await expect(
      harness.application.proveNoEffect(proof),
    ).resolves.toMatchObject({ status: "restored" });
    const driftedProofFacts = {
      ...proofFacts,
      noEffectReason: "different_no_effect_reason",
    } as const;
    await expect(
      harness.application.proveNoEffect(driftedProofFacts),
    ).resolves.toEqual({ status: "request_conflict" });
    await expect(
      harness.application.recordEffect(effectCommand(begun.capability)),
    ).resolves.toEqual({ status: "request_conflict" });
  });

  it("atomically terminalizes multiple proof-backed no-effect operations", async () => {
    const harness = createHarness();
    await harness.application.request(
      requestCommand({ operations: independentOperationPlans() }),
    );
    const claim = await harness.application.claim(claimCommand());
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    const first = await harness.application.beginOperation(
      beginCommand({
        expectedAttemptVersion: claim.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
      }),
    );
    if (first.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("test_begin_failed");
    }
    const second = await harness.application.beginOperation(
      beginCommand({
        operationId: "operation-2",
        expectedAttemptVersion: first.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        ordinal: 2,
      }),
    );
    if (second.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("test_begin_failed");
    }
    await harness.application.proveNoEffect({
      capability: first.capability,
      noEffectProofId: "no-effect-proof-1",
      noEffectReason: "definitely_no_effect:first_rejected",
    });
    await harness.application.proveNoEffect({
      capability: second.capability,
      noEffectProofId: "no-effect-proof-2",
      noEffectReason: "definitely_no_effect:second_rejected",
    });

    await expect(
      harness.application.terminalizeUnknown({
        publicationAttemptId: "publication-1",
        publicationOperationId: "operation-1",
        expectedAttemptVersion: second.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        tombstoneId: "tombstone-operation-1",
        siblingTombstones: [
          {
            publicationOperationId: "operation-2",
            tombstoneId: "tombstone-operation-2",
            finalOutcome:
              ReviewPublicationTerminalOutcome.FailedNoEffect as const,
          },
        ],
        finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
        finalReason: "all_operations_rejected_without_effect",
        lastErrorCode: "provider_rejected",
        terminalizedBy: "worker-1",
        retainUntil: at("2026-08-22T16:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
      attempt: {
        state: "terminal",
        terminalOutcome: "failed_no_effect",
        operations: [
          { publicationOperationId: "operation-1", state: "failed_no_effect" },
          { publicationOperationId: "operation-2", state: "failed_no_effect" },
        ],
      },
    });
    expect(
      (await requiredView(harness.repository)).operationAttempts,
    ).toMatchObject([
      { publicationOperationId: "operation-1", state: "no_effect_proven" },
      { publicationOperationId: "operation-2", state: "no_effect_proven" },
    ]);
  });

  it("atomically closes untouched planned siblings on no-effect terminalization", async () => {
    const harness = createHarness();
    await harness.application.request(
      requestCommand({ operations: independentOperationPlans() }),
    );
    const claim = await harness.application.claim(claimCommand());
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }

    const terminalCommand = {
      publicationAttemptId: "publication-1",
      publicationOperationId: "operation-1",
      expectedAttemptVersion: claim.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      tombstoneId: "tombstone-operation-1",
      siblingTombstones: [
        {
          publicationOperationId: "operation-2",
          tombstoneId: "tombstone-operation-2",
          finalOutcome:
            ReviewPublicationTerminalOutcome.SupersededNoEffect as const,
        },
      ],
      finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
      finalReason: "operation_superseded",
      lastErrorCode: "publication_live_facts_changed",
      terminalizedBy: "worker-1",
      retainUntil: at("2026-08-22T16:01:00.000Z"),
    } as const;
    await expect(
      harness.application.terminalizeUnknown(terminalCommand),
    ).resolves.toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
      attempt: {
        state: "terminal",
        terminalOutcome: "superseded_no_effect",
        operations: [
          { state: "superseded_no_effect" },
          { state: "superseded_no_effect" },
        ],
      },
    });
    expect((await requiredView(harness.repository)).tombstones).toMatchObject([
      {
        publicationOperationId: "operation-1",
        finalOutcome: "superseded_no_effect",
      },
      {
        publicationOperationId: "operation-2",
        finalOutcome: "superseded_no_effect",
      },
    ]);
    await expect(
      harness.application.terminalizeUnknown({
        ...terminalCommand,
        siblingTombstones: [],
      }),
    ).resolves.toEqual({
      status: TerminalizeUnknownReviewPublicationStatus.Conflict,
    });
  });

  it("waits for every risk operation deadline and converges their live attempts", async () => {
    const harness = createHarness();
    const operations = independentOperationPlans().map((operation, index) => ({
      ...operation,
      reconcileUntil: at(
        index === 0 ? "2026-07-22T16:00:00.000Z" : "2026-07-22T17:00:00.000Z",
      ),
    }));
    await harness.application.request(requestCommand({ operations }));
    const claim = await harness.application.claim(
      claimCommand({ expiresAt: at("2026-07-22T18:00:00.000Z") }),
    );
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    const first = await harness.application.beginOperation(
      beginCommand({
        operationId: "operation-1",
        expectedAttemptVersion: claim.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
      }),
    );
    if (first.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("test_begin_failed");
    }
    const second = await harness.application.beginOperation(
      beginCommand({
        operationId: "operation-2",
        expectedAttemptVersion: first.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        ordinal: 2,
      }),
    );
    if (second.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("test_begin_failed");
    }
    const terminalCommand = {
      publicationAttemptId: "publication-1",
      publicationOperationId: "operation-1",
      expectedAttemptVersion: second.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      tombstoneId: "tombstone-operation-1",
      siblingTombstones: [
        {
          publicationOperationId: "operation-2",
          tombstoneId: "tombstone-operation-2",
          finalOutcome:
            ReviewPublicationTerminalOutcome.TerminalUnknown as const,
        },
      ],
      finalOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      finalReason: "inventory_ambiguous",
      lastErrorCode: "scm_timeout",
      terminalizedBy: "worker-1",
      retainUntil: at("2026-08-22T17:01:00.000Z"),
    } as const;

    harness.clock.set(at("2026-07-22T16:30:00.000Z"));
    await expect(
      harness.application.terminalizeUnknown(terminalCommand),
    ).resolves.toEqual({
      status: TerminalizeUnknownReviewPublicationStatus.TooEarly,
    });
    harness.clock.set(at("2026-07-22T17:01:00.000Z"));
    await expect(
      harness.application.terminalizeUnknown(terminalCommand),
    ).resolves.toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
      attempt: {
        state: "terminal",
        operations: [
          { state: "terminal_unknown" },
          { state: "terminal_unknown" },
        ],
      },
    });
    expect((await requiredView(harness.repository)).operationAttempts).toEqual([
      expect.objectContaining({ state: "terminal_unknown" }),
      expect.objectContaining({ state: "terminal_unknown" }),
    ]);
  });

  it("enforces tombstone identity uniqueness across in-memory attempts", async () => {
    const repository = new InMemoryReviewPublicationRepository();
    const first = requestCommand();
    const secondPermit = {
      ...permitIdentity(),
      executionId: "execution-2",
      projectionHash: hash("9"),
      reviewRevisionHash: hash("8"),
    };
    const second = {
      ...requestCommand({
        permit: secondPermit,
        operations: [
          {
            ...operationPlan({ operationId: "operation-2" }),
            reviewRevisionHash: secondPermit.reviewRevisionHash,
          },
        ],
      }),
      publicationAttemptId: "publication-2",
      requestIdHash: hash("7"),
      requestHash: hash("6"),
    };
    await repository.request(first);
    await repository.request(second);
    const firstClaim = await repository.claim({
      ...claimCommand(),
      acquiredAt: initialTime,
    });
    const secondClaim = await repository.claim({
      ...claimCommand({
        claimId: "claim-2",
        requestIdHash: hash("5"),
        requestHash: hash("4"),
      }),
      publicationAttemptId: second.publicationAttemptId,
      acquiredAt: initialTime,
    });
    if (
      firstClaim.status !== ClaimReviewPublicationStatus.Acquired ||
      secondClaim.status !== ClaimReviewPublicationStatus.Acquired
    ) {
      throw new Error("test_claim_failed");
    }
    const sharedTombstoneId = "globally-unique-tombstone";
    await expect(
      repository.terminalizeUnknown({
        publicationAttemptId: first.publicationAttemptId,
        publicationOperationId: first.operations[0]!.publicationOperationId,
        expectedAttemptVersion: firstClaim.attempt.version,
        claimId: firstClaim.claim.claimId,
        claimFencingToken: firstClaim.claim.fencingToken,
        tombstoneId: sharedTombstoneId,
        siblingTombstones: [],
        finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        finalReason: "operation_superseded",
        lastErrorCode: "publication_live_facts_changed",
        terminalizedBy: "worker-1",
        terminalizedAt: initialTime,
        retainUntil: first.retainUntil,
      }),
    ).resolves.toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
    });
    await expect(
      repository.terminalizeUnknown({
        publicationAttemptId: second.publicationAttemptId,
        publicationOperationId: second.operations[0]!.publicationOperationId,
        expectedAttemptVersion: secondClaim.attempt.version,
        claimId: secondClaim.claim.claimId,
        claimFencingToken: secondClaim.claim.fencingToken,
        tombstoneId: sharedTombstoneId,
        siblingTombstones: [],
        finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        finalReason: "operation_superseded",
        lastErrorCode: "publication_live_facts_changed",
        terminalizedBy: "worker-2",
        terminalizedAt: initialTime,
        retainUntil: second.retainUntil,
      }),
    ).resolves.toEqual({
      status: TerminalizeUnknownReviewPublicationStatus.Conflict,
    });
  });

  it("models every publication effect strategy as a closed domain value", async () => {
    const operations = [
      operationPlan(),
      operationPlan({
        operationId: "append-only",
        publicationKind: ReviewPublicationKind.SubmittedReview,
        chunkIndex: 1,
        strategy: ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt,
        markerHash: hash("3"),
        bodyHash: hash("4"),
      }),
      operationPlan({
        operationId: "lifecycle",
        publicationKind: ReviewPublicationKind.ThreadLifecycle,
        chunkIndex: 2,
        strategy: ReviewPublicationEffectStrategy.ReversibleLifecycle,
        markerHash: hash("5"),
        bodyHash: hash("6"),
      }),
      ...pendingReviewOperations().map((operation, index) => ({
        ...operation,
        chunkIndex: index + 3,
      })),
    ];
    const harness = createHarness();
    const result = await harness.application.request(
      requestCommand({ operations }),
    );
    expect(result).toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
      attempt: { operations: [{}, {}, {}, {}, {}] },
    });
  });

  it("accepts an append-only late effect through effectReportUntil but only a current claim can complete", async () => {
    const harness = createHarness();
    const { claim, begun } = await requestClaimBegin(harness, {
      claimExpiresAt: at("2026-07-22T12:10:00.000Z"),
      effectReportUntil: at("2026-07-22T12:30:00.000Z"),
    });
    harness.clock.set(at("2026-07-22T12:20:00.000Z"));
    const effect = await harness.application.recordEffect(
      effectCommand(begun.capability),
    );
    expect(effect.status).toBe(RecordReviewExternalEffectStatus.Recorded);
    const afterEffect = await requiredView(harness.repository);
    expect(afterEffect.attempt.version).toBe(begun.attempt.version);
    expect(afterEffect.attempt.operations[0]?.state).toBe(
      ReviewPublicationOperationState.InFlight,
    );
    expect(afterEffect.operationAttempts[0]?.state).toBe(
      ReviewPublicationOperationAttemptState.Active,
    );
    harness.clock.set(at("2026-07-22T12:21:00.000Z"));
    expect(
      await harness.application.recordEffect(effectCommand(begun.capability)),
    ).toMatchObject({ status: RecordReviewExternalEffectStatus.Restored });

    const staleCompletion = await harness.application.completeOperation(
      completeCommand({
        expectedAttemptVersion: begun.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
      }),
    );
    expect(staleCompletion.status).toBe(
      CompleteReviewPublicationOperationStatus.StaleClaim,
    );

    const beforeTakeover = await requiredView(harness.repository);
    const takeover = await harness.application.claim(
      claimCommand({
        expectedAttemptVersion: beforeTakeover.attempt.version,
        claimId: "claim-takeover",
        requestIdHash: hash("7"),
        requestHash: hash("8"),
        expiresAt: at("2026-07-22T14:00:00.000Z"),
      }),
    );
    expect(takeover.status).toBe(ClaimReviewPublicationStatus.Acquired);
    if (takeover.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_takeover_failed");
    }
    const completed = await harness.application.completeOperation(
      completeCommand({
        expectedAttemptVersion: takeover.attempt.version,
        claimId: takeover.claim.claimId,
        claimFencingToken: takeover.claim.fencingToken,
      }),
    );
    expect(completed).toMatchObject({
      status: CompleteReviewPublicationOperationStatus.Completed,
      attempt: {
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
      },
    });
  });

  it("rejects direct reports after the bounded effect window", async () => {
    const harness = createHarness();
    const { begun } = await requestClaimBegin(harness, {
      effectReportUntil: at("2026-07-22T12:05:00.000Z"),
    });
    harness.clock.set(at("2026-07-22T12:05:00.001Z"));
    expect(
      await harness.application.recordEffect(effectCommand(begun.capability)),
    ).toEqual({ status: RecordReviewExternalEffectStatus.ReportExpired });
    expect((await requiredView(harness.repository)).effects).toHaveLength(0);
  });

  it("requires every canonical receipt before effective succeeded", async () => {
    const operations = [
      operationPlan(),
      operationPlan({
        operationId: "operation-2",
        publicationKind: ReviewPublicationKind.ManagedCheck,
        chunkIndex: 1,
        markerHash: hash("a"),
        bodyHash: hash("b"),
      }),
    ];
    const harness = createHarness();
    await harness.application.request(requestCommand({ operations }));
    const claim = await harness.application.claim(claimCommand());
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    const first = await beginAndComplete(harness, claim, "operation-1", 1);
    expect(first.attempt.terminalOutcome).toBeNull();
    const second = await beginAndComplete(
      harness,
      {
        ...claim,
        attempt: first.attempt,
      },
      "operation-2",
      2,
    );
    expect(second.attempt.terminalOutcome).toBe(
      ReviewPublicationTerminalOutcome.Succeeded,
    );
    expect((await requiredView(harness.repository)).receipts).toHaveLength(2);
  });

  it("durably orders PendingThenSubmit and binds submit to the created review ID", async () => {
    const operations = pendingReviewOperations();
    const harness = createHarness();
    await harness.application.request(requestCommand({ operations }));
    const claim = await harness.application.claim(claimCommand());
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    expect(
      await harness.application.beginOperation(
        beginCommand({
          operationId: "pending-submit",
          expectedAttemptVersion: claim.attempt.version,
          claimId: claim.claim.claimId,
          claimFencingToken: claim.claim.fencingToken,
        }),
      ),
    ).toEqual({
      status: BeginReviewPublicationOperationStatus.DependencyNotCompleted,
    });

    const create = await beginAndComplete(
      harness,
      claim,
      "pending-create",
      1,
      "review-42",
    );
    const submitBegin = await harness.application.beginOperation(
      beginCommand({
        operationId: "pending-submit",
        expectedAttemptVersion: create.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        ordinal: 2,
      }),
    );
    expect(submitBegin).toMatchObject({
      status: BeginReviewPublicationOperationStatus.Begun,
      capability: { targetExternalObjectId: "review-42" },
    });
    if (submitBegin.status !== BeginReviewPublicationOperationStatus.Begun)
      return;
    expect(
      await harness.application.recordEffect(
        effectCommand(submitBegin.capability, {
          ordinal: 2,
          externalObjectId: "review-other",
        }),
      ),
    ).toEqual({ status: RecordReviewExternalEffectStatus.CapabilityMismatch });
    await harness.application.recordEffect(
      effectCommand(submitBegin.capability, {
        ordinal: 2,
        externalObjectId: "review-42",
      }),
    );
    const submitted = await harness.application.completeOperation(
      completeCommand({
        operationId: "pending-submit",
        expectedAttemptVersion: submitBegin.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        ordinal: 2,
      }),
    );
    expect(submitted).toMatchObject({
      status: CompleteReviewPublicationOperationStatus.Completed,
      attempt: { terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded },
      receipt: { canonicalExternalObjectId: "review-42" },
    });
  });

  it("keeps terminal_unknown immutable and appends only inventory-proven corrections", async () => {
    const proof: ReviewPublicationProvenReceipt = {
      receiptId: "adjudicated-receipt",
      publicationOperationId: "operation-1",
      canonicalEffectId: "reconciled-effect",
      canonicalExternalObjectId: "summary-42",
      receiptHash: hash("e"),
      provenAt: at("2026-07-22T16:10:00.000Z"),
    };
    const harness = createHarness({ adjudicationReceipts: [proof] });
    await harness.application.request(requestCommand());
    const claim = await harness.application.claim(
      claimCommand({ expiresAt: at("2026-07-22T17:00:00.000Z") }),
    );
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("test_claim_failed");
    }
    harness.clock.set(at("2026-07-22T16:01:00.000Z"));
    const terminal = await harness.application.terminalizeUnknown({
      publicationAttemptId: "publication-1",
      publicationOperationId: "operation-1",
      expectedAttemptVersion: claim.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      tombstoneId: "tombstone-1",
      siblingTombstones: [],
      finalReason: "inventory_ambiguous",
      lastErrorCode: "scm_timeout",
      terminalizedBy: "worker-1",
      retainUntil: at("2026-08-22T16:01:00.000Z"),
    });
    expect(terminal).toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
      attempt: {
        terminalOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      },
    });
    if (
      terminal.status !== TerminalizeUnknownReviewPublicationStatus.Terminalized
    )
      return;
    harness.clock.set(at("2026-07-22T16:10:00.000Z"));
    const correctionCommand = {
      publicationAttemptId: "publication-1",
      expectedAttemptVersion: terminal.attempt.version,
      correctionId: "correction-1",
      correctionOrdinal: 1,
      correctedOutcome: ReviewPublicationTerminalOutcome.Succeeded,
      evidenceHash: hash("f"),
      safeReason: ReviewPublicationCorrectionReason.CanonicalEffectsProven,
      correctedBy: "operator-1",
      retainUntil: at("2026-08-22T16:10:00.000Z"),
    } as const;
    const corrected = await harness.application.adjudicate(correctionCommand);
    expect(corrected).toMatchObject({
      status: AdjudicateReviewPublicationOutcomeStatus.Corrected,
      attempt: {
        terminalOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      },
      correction: {
        correctedOutcome: ReviewPublicationTerminalOutcome.Succeeded,
      },
    });
    if (corrected.status !== AdjudicateReviewPublicationOutcomeStatus.Corrected)
      return;
    const view = await requiredView(harness.repository);
    expect(
      effectiveReviewPublicationOutcome({
        attempt: view.attempt,
        corrections: view.corrections,
      }),
    ).toBe(ReviewPublicationTerminalOutcome.Succeeded);
    expect(view.receipts).toMatchObject([
      { canonicalExternalObjectId: "summary-42" },
    ]);
    harness.clock.set(at("2026-07-22T16:11:00.000Z"));
    expect(
      await harness.application.adjudicate(correctionCommand),
    ).toMatchObject({
      status: AdjudicateReviewPublicationOutcomeStatus.Restored,
      correction: { correctedAt: at("2026-07-22T16:10:00.000Z") },
    });
  });
});

function createHarness(
  input: {
    permit?: ReviewPublicationPermitIdentity;
    decisions?: ReviewPublicationDecisionPorts;
    decisionOverrides?: Partial<ReviewPublicationDecisionPorts>;
    enableCapabilities?: boolean;
    adjudicationReceipts?: readonly ReviewPublicationProvenReceipt[];
  } = {},
) {
  const permit = input.permit ?? permitIdentity();
  const repository = new InMemoryReviewPublicationRepository();
  const clock = new MutableReviewPublicationClock(initialTime);
  const application = createReviewPublicationV2Application({
    clock,
    decisions:
      input.decisions ??
      allowingReviewPublicationDecisionPorts(permit, input.decisionOverrides),
    attempts: repository,
    idempotency: repository,
    adjudicationEvidence: {
      async resolve(request) {
        return {
          status: ReviewPublicationAdjudicationEvidenceStatus.Proven,
          evidenceHash: request.evidenceHash,
          provenReceipts: input.adjudicationReceipts ?? [],
        };
      },
    },
    commands: {
      requests: repository,
      claims: repository,
      claimRenewals: repository,
      operationBegins: repository,
      effects: repository,
      completions: repository,
      terminalizations: repository,
      adjudications: repository,
    },
    ...(input.enableCapabilities === false
      ? {}
      : {
          enabledCapabilities: new Set(
            Object.values(ReviewPublicationCapability),
          ),
        }),
  });
  return { application, clock, permit, repository };
}

function permitIdentity(): ReviewPublicationPermitIdentity {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-connection-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: "authorization-1",
    producerReleaseId: "release-1",
    reviewedHeadSha: hash("a"),
    reviewRevisionHash: hash("b"),
    projectionHash: hash("c"),
    lifecycleStateHash: hash("d"),
    commandLedgerWatermark: 2n,
    permitEpoch: 7n,
    publicationSafetyDecisionHash: hash("f"),
    publicationNotAfter: at("2026-07-22T15:00:00.000Z"),
  };
}

function operationPlan(
  input: {
    operationId?: string;
    publicationKind?: ReviewPublicationKind;
    chunkIndex?: number;
    strategy?: ReviewPublicationEffectStrategy;
    role?: ReviewPublicationOperationRole;
    markerHash?: string;
    bodyHash?: string;
    targetCommitId?: string;
    dependsOnOperationId?: string | null;
  } = {},
): ReviewPublicationOperationPlan {
  return {
    publicationOperationId: input.operationId ?? "operation-1",
    publicationKind: input.publicationKind ?? ReviewPublicationKind.Summary,
    chunkIndex: input.chunkIndex ?? 0,
    effectStrategy:
      input.strategy ?? ReviewPublicationEffectStrategy.MutableSingleton,
    role: input.role ?? ReviewPublicationOperationRole.Standalone,
    markerHash: input.markerHash ?? hash("1"),
    bodyHash: input.bodyHash ?? hash("2"),
    renderPolicyVersion: 1,
    targetCommitId: input.targetCommitId ?? hash("a"),
    reviewRevisionHash: hash("b"),
    required: true,
    dependsOnOperationId: input.dependsOnOperationId ?? null,
    reconcileUntil: at("2026-07-22T16:00:00.000Z"),
  };
}

function pendingReviewOperations(): readonly ReviewPublicationOperationPlan[] {
  return [
    operationPlan({
      operationId: "pending-create",
      publicationKind: ReviewPublicationKind.PendingReviewCreate,
      strategy: ReviewPublicationEffectStrategy.PendingThenSubmit,
      role: ReviewPublicationOperationRole.PendingReviewCreate,
      markerHash: hash("7"),
      bodyHash: hash("8"),
    }),
    operationPlan({
      operationId: "pending-submit",
      publicationKind: ReviewPublicationKind.PendingReviewSubmit,
      chunkIndex: 1,
      strategy: ReviewPublicationEffectStrategy.PendingThenSubmit,
      role: ReviewPublicationOperationRole.PendingReviewSubmit,
      markerHash: hash("9"),
      bodyHash: hash("a"),
      dependsOnOperationId: "pending-create",
    }),
  ];
}

function independentOperationPlans(): readonly ReviewPublicationOperationPlan[] {
  return [
    operationPlan(),
    operationPlan({
      operationId: "operation-2",
      chunkIndex: 1,
      markerHash: hash("7"),
      bodyHash: hash("8"),
    }),
  ];
}

function requestCommand(
  input: {
    permit?: ReviewPublicationPermitIdentity;
    operations?: readonly ReviewPublicationOperationPlan[];
  } = {},
) {
  return {
    publicationAttemptId: "publication-1",
    requestIdHash: hash("1"),
    requestHash: hash("2"),
    permit: input.permit ?? permitIdentity(),
    operations: input.operations ?? [operationPlan()],
    createdAt: initialTime,
    retainUntil: at("2026-08-22T12:00:00.000Z"),
  };
}

function claimCommand(
  input: {
    expectedAttemptVersion?: bigint;
    claimId?: string;
    requestIdHash?: string;
    requestHash?: string;
    expiresAt?: Date;
  } = {},
) {
  return {
    publicationAttemptId: "publication-1",
    expectedAttemptVersion: input.expectedAttemptVersion ?? 1n,
    claimId: input.claimId ?? "claim-1",
    ownerIdHash: hash("3"),
    acquireRequestIdHash: input.requestIdHash ?? hash("4"),
    requestHash: input.requestHash ?? hash("5"),
    claimCapabilityId: `${input.claimId ?? "claim-1"}-capability`,
    capabilitySigningKeyId: "signing-key-1",
    expiresAt: input.expiresAt ?? at("2026-07-22T13:00:00.000Z"),
    reportUntil: at("2026-07-22T18:00:00.000Z"),
    retainUntil: at("2026-08-22T18:00:00.000Z"),
  };
}

function beginCommand(input: {
  operationId?: string;
  expectedAttemptVersion: bigint;
  claimId: string;
  claimFencingToken: bigint;
  ordinal?: number;
  effectReportUntil?: Date;
}) {
  const ordinal = input.ordinal ?? 1;
  return {
    publicationAttemptId: "publication-1",
    publicationOperationId: input.operationId ?? "operation-1",
    expectedAttemptVersion: input.expectedAttemptVersion,
    claimId: input.claimId,
    claimFencingToken: input.claimFencingToken,
    acquireRequestIdHash: hash(String((ordinal + 4) % 10)),
    requestHash: hash(String((ordinal + 5) % 10)),
    operationAttemptId: `operation-attempt-${ordinal}`,
    operationCapabilityId: `operation-capability-${ordinal}`,
    capabilitySigningKeyId: "signing-key-1",
    effectReportId: `effect-report-${ordinal}`,
    effectReportUntil:
      input.effectReportUntil ?? at("2026-07-22T14:30:00.000Z"),
    retainUntil: at("2026-08-22T14:30:00.000Z"),
  };
}

function effectCommand(
  capability: Parameters<
    ReturnType<typeof createReviewPublicationV2Application>["recordEffect"]
  >[0]["capability"],
  input: { ordinal?: number; externalObjectId?: string } = {},
) {
  const ordinal = input.ordinal ?? 1;
  return {
    capability,
    effectId: `effect-${ordinal}`,
    reportRequestHash: hash(String((ordinal + 6) % 10)),
    externalObjectId: input.externalObjectId ?? `external-${ordinal}`,
    observedObjectHash: hash(String((ordinal + 7) % 10)),
    effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
  };
}

function completeCommand(input: {
  operationId?: string;
  expectedAttemptVersion: bigint;
  claimId: string;
  claimFencingToken: bigint;
  ordinal?: number;
}) {
  const ordinal = input.ordinal ?? 1;
  return {
    publicationAttemptId: "publication-1",
    publicationOperationId: input.operationId ?? "operation-1",
    expectedAttemptVersion: input.expectedAttemptVersion,
    claimId: input.claimId,
    claimFencingToken: input.claimFencingToken,
    completionRequestIdHash: hash(String((ordinal + 7) % 10)),
    requestHash: hash(String((ordinal + 8) % 10)),
    receiptId: `receipt-${ordinal}`,
    canonicalEffectId: `effect-${ordinal}`,
    receiptHash: hash(String((ordinal + 9) % 10)),
  };
}

async function requestClaimBegin(
  harness: ReturnType<typeof createHarness>,
  input: { claimExpiresAt?: Date; effectReportUntil?: Date } = {},
) {
  await harness.application.request(requestCommand());
  const claim = await harness.application.claim(
    claimCommand({
      ...(input.claimExpiresAt ? { expiresAt: input.claimExpiresAt } : {}),
    }),
  );
  if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
    throw new Error("test_claim_failed");
  }
  const begun = await harness.application.beginOperation(
    beginCommand({
      expectedAttemptVersion: claim.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      ...(input.effectReportUntil
        ? { effectReportUntil: input.effectReportUntil }
        : {}),
    }),
  );
  if (begun.status !== BeginReviewPublicationOperationStatus.Begun) {
    throw new Error("test_begin_failed");
  }
  return { claim, begun };
}

async function beginAndComplete(
  harness: ReturnType<typeof createHarness>,
  claim: {
    readonly attempt: ReviewPublicationAttempt;
    readonly claim: ReviewPublicationClaimTerm;
  },
  operationId: string,
  ordinal: number,
  externalObjectId = `external-${ordinal}`,
) {
  const begun = await harness.application.beginOperation(
    beginCommand({
      operationId,
      expectedAttemptVersion: claim.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      ordinal,
    }),
  );
  if (begun.status !== BeginReviewPublicationOperationStatus.Begun) {
    throw new Error("test_begin_failed");
  }
  await harness.application.recordEffect(
    effectCommand(begun.capability, { ordinal, externalObjectId }),
  );
  const completed = await harness.application.completeOperation(
    completeCommand({
      operationId,
      expectedAttemptVersion: begun.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      ordinal,
    }),
  );
  if (completed.status !== CompleteReviewPublicationOperationStatus.Completed) {
    throw new Error(`test_complete_failed:${completed.status}`);
  }
  return completed;
}

async function requiredView(repository: InMemoryReviewPublicationRepository) {
  const view = await repository.findById("publication-1");
  if (!view) throw new Error("test_publication_missing");
  return view;
}
