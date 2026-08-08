import { describe, expect, it, vi } from "vitest";
import {
  RequestReviewPublicationStatus,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationRole,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  type ReviewPublicationGatewayObject,
  type ReviewPublicationOperationPlan,
  type ReviewPublicationPermitIdentity,
} from "@reviewrouter/features-review-publishing/v2";
import { createReviewPublicationV2Application } from "@reviewrouter/features-review-publishing/v2/composition";
import {
  InMemoryReviewPublicationRepository,
  MutableReviewPublicationClock,
  allowingReviewPublicationDecisionPorts,
} from "@reviewrouter/features-review-publishing/v2/testing";
import { ExecuteReviewV2PublicationOperation } from "./review-v2-publication-executor";
import {
  ReviewV2PublicationCompensationDecision,
  ReviewV2PublicationExecutionStatus,
  ReviewV2PublicationEffectGateDecision,
  ReviewV2PublicationFreshnessReadStatus,
  ReviewV2ScmCredentialPurpose,
  ReviewV2ScmMutationError,
  ReviewV2ScmMutationFailureOutcome,
  ReviewV2ScmProvider,
  type ReviewV2PublicationFreshnessRead,
} from "./review-v2-publication-ports";
import type { ReviewV2ProviderPublicationClientPort } from "./review-v2-publication-gateways";
import {
  productionReviewV2AdjudicationEvidence,
  productionReviewV2PublicationCapabilities,
} from "./review-v2-production-runtime";

const initialTime = at("2026-07-23T12:00:00.000Z");
const ownerIdHash = hash("e");

describe("protocol v2 publication executor", () => {
  it("completes the publication lifecycle with the production capability set", async () => {
    const fixture = await createFixture();

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.credentials.purposes).toEqual([
      ReviewV2ScmCredentialPurpose.Mutate,
    ]);
    expect(fixture.freshness.reads).toBeGreaterThanOrEqual(6);
    const view = await fixture.repository.findById("publication-1");
    expect(view).toMatchObject({
      attempt: {
        state: "terminal",
        terminalOutcome: "succeeded",
      },
      effects: [
        {
          effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
          externalObjectId: "object-1",
        },
      ],
      receipts: [
        {
          canonicalExternalObjectId: "object-1",
          status: ReviewPublicationReceiptStatus.Succeeded,
        },
      ],
    });

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.AlreadyCompleted,
        safeReason: "publication_operation_already_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("reconciles every marker page before retry and does not duplicate an ambiguous write", async () => {
    const fixture = await createFixture();
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "scm_timeout",
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);

    fixture.gateway.applyError = null;
    fixture.gateway.pages = [
      { objects: [], nextCursor: "page-2" },
      { objects: [gatewayObject("object-recovered")], nextCursor: null },
    ];
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.credentials.purposes).toEqual([
      ReviewV2ScmCredentialPurpose.Mutate,
      ReviewV2ScmCredentialPurpose.ReconcileOnly,
    ]);
    expect(fixture.gateway.requestedCursors).toContain("page-2");
  });

  it("publishes the current mutable singleton when stale marker inventory exists", async () => {
    const fixture = await createFixture();
    const staleObject = {
      ...gatewayObject("stale-summary"),
      bodyHash: hash("9"),
      observedObjectHash: hash("4"),
    };
    fixture.gateway.pages = [{ objects: [staleObject], nextCursor: null }];
    fixture.gateway.postApplyObjects = [staleObject];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );

    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      effects: [{ externalObjectId: "object-1" }],
      receipts: [
        {
          canonicalExternalObjectId: "object-1",
          status: ReviewPublicationReceiptStatus.Succeeded,
        },
      ],
    });
  });

  it("removes an obsolete pending review before creating its replacement", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [
          {
            ...gatewayObject("review:7"),
            bodyHash: hash("9"),
            observedObjectHash: hash("4"),
          },
        ],
        nextCursor: null,
      },
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );

    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.effectGate.calls).toBe(2);
  });

  it("reconciles the current pending review without deleting or recreating it", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      { objects: [gatewayObject("review:7")], nextCursor: null },
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );

    expect(fixture.gateway.compensationCalls).toBe(0);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("does not remove a stale pending review when the effect gate is unavailable", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
        nextCursor: null,
      },
    ];
    fixture.effectGate.decision =
      ReviewV2PublicationEffectGateDecision.Unavailable;

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_unavailable",
      },
    );

    expect(fixture.gateway.compensationCalls).toBe(0);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("does not report no-effect when freshness changes after stale pending cleanup", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
        nextCursor: null,
      },
    ];
    fixture.freshness.sequence = [
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      changedFreshness(),
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_live_facts_changed",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("retries instead of reporting no-effect when the create gate closes after cleanup", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
        nextCursor: null,
      },
    ];
    fixture.effectGate.decisions = [
      ReviewV2PublicationEffectGateDecision.Allowed,
      ReviewV2PublicationEffectGateDecision.Disabled,
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_disabled",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("recovers cleanup ambiguity from persisted operation state after a worker retry", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
        nextCursor: null,
      },
    ];
    fixture.effectGate.decisions = [
      ReviewV2PublicationEffectGateDecision.Allowed,
      ReviewV2PublicationEffectGateDecision.Unavailable,
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_unavailable",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(0);

    fixture.effectGate.decision =
      ReviewV2PublicationEffectGateDecision.Disabled;
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_disabled",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("does not report no-effect when credential freshness changes after a persisted mutation attempt", async () => {
    const fixture = await createFixture();
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "github_mutation_http_422",
      ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "github_mutation_http_422",
      },
    );

    fixture.gateway.applyError = null;
    fixture.freshness.sequence = [
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      changedFreshness(),
    ];
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_live_facts_changed",
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("persists no-effect proof before terminalizing a nonretryable definitely-no-effect mutation", async () => {
    const fixture = await createFixture();
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "github_mutation_http_422",
      ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
      false,
    );

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Terminalized,
        safeReason: "scm_mutation_rejected_no_effect",
        terminalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
      },
    );
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "terminal",
        terminalOutcome: "failed_no_effect",
      },
      operationAttempts: [
        {
          state: "no_effect_proven",
          noEffectProofId: expect.any(String),
          noEffectProofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          noEffectReason: "definitely_no_effect:github_mutation_http_422",
          noEffectProvenAt: initialTime,
        },
      ],
      tombstones: [
        {
          finalReason: "scm_mutation_rejected_no_effect",
          lastErrorCode: "github_mutation_http_422",
        },
      ],
    });
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("replays a persisted no-effect proof without repeating the SCM mutation", async () => {
    const fixture = await createFixture({ claimDurationMs: 1_000 });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "github_mutation_http_422",
      ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
      false,
    );
    const terminalization = vi
      .spyOn(fixture.application, "terminalizeUnknown")
      .mockRejectedValueOnce(new Error("terminalization_ack_lost"));

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_terminal_outcome_ack_unknown",
      },
    );
    fixture.gateway.applyError = null;
    fixture.clock.set(at("2026-07-23T12:00:02.000Z"));
    fixture.freshness.current = changedFreshness();
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Terminalized,
        safeReason: "scm_mutation_rejected_no_effect",
        terminalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
      },
    );
    expect(terminalization).toHaveBeenCalledTimes(2);
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("does not report no-effect when freshness changes before cleanup after a persisted mutation attempt", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "github_mutation_http_422",
      ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "github_mutation_http_422",
      },
    );

    fixture.gateway.applyError = null;
    fixture.gateway.inventorySnapshots = [
      [],
      [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
    ];
    fixture.freshness.sequence = [
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      changedFreshness(),
    ];
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_live_facts_changed",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(0);
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("recovers when a stale pending review races replacement creation", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.pages = [
      {
        objects: [{ ...gatewayObject("review:7"), bodyHash: hash("9") }],
        nextCursor: null,
      },
    ];
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "github_mutation_http_422",
      ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect,
      true,
    );
    fixture.gateway.objectsOnApplyError = [
      { ...gatewayObject("review:8"), bodyHash: hash("8") },
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "github_mutation_http_422",
      },
    );

    fixture.gateway.applyError = null;
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(2);
    expect(fixture.gateway.applyCalls).toBe(2);
  });

  it("never acquires an SCM credential when the pre-mutation facts are stale", async () => {
    const fixture = await createFixture();
    fixture.freshness.current = changedFreshness();

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Terminalized,
        safeReason: "publication_live_facts_superseded",
        terminalOutcome: "superseded_no_effect",
      },
    );
    expect(fixture.credentials.purposes).toEqual([]);
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("rechecks the effect gate immediately before the SCM mutation", async () => {
    const fixture = await createFixture();
    fixture.effectGate.decision =
      ReviewV2PublicationEffectGateDecision.Disabled;

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_disabled",
      },
    );
    expect(fixture.effectGate.calls).toBe(1);
    expect(fixture.gateway.applyCalls).toBe(0);
    expect(
      (await fixture.repository.findById("publication-1"))?.attempt
        .terminalOutcome,
    ).toBeNull();
  });

  it("fails closed without retrying internally when the effect gate is unavailable", async () => {
    const unavailable = await createFixture();
    unavailable.effectGate.decision =
      ReviewV2PublicationEffectGateDecision.Unavailable;

    await expect(
      unavailable.executor.execute(executionCommand()),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Retryable,
      safeReason: "publication_effect_gate_unavailable",
    });
    expect(unavailable.effectGate.calls).toBe(1);
    expect(unavailable.gateway.applyCalls).toBe(0);

    const rejected = await createFixture();
    rejected.effectGate.error = new Error("rollout_store_unavailable");
    await expect(
      rejected.executor.execute(executionCommand()),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Retryable,
      safeReason: "publication_effect_gate_unavailable",
    });
    expect(rejected.effectGate.calls).toBe(1);
    expect(rejected.gateway.applyCalls).toBe(0);
  });

  it("re-reads the effect gate immediately before duplicate cleanup", async () => {
    const fixture = await createFixture();
    const staleObject = {
      ...gatewayObject("stale-summary"),
      bodyHash: hash("9"),
      observedObjectHash: hash("4"),
    };
    fixture.gateway.pages = [{ objects: [staleObject], nextCursor: null }];
    fixture.gateway.postApplyObjects = [staleObject];
    fixture.effectGate.decisions = [
      ReviewV2PublicationEffectGateDecision.Allowed,
      ReviewV2PublicationEffectGateDecision.Unavailable,
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_unavailable",
      },
    );

    expect(fixture.effectGate.calls).toBe(2);
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.gateway.compensationCalls).toBe(0);
  });

  it("re-reads the effect gate immediately before stale-effect compensation", async () => {
    const fixture = await createFixture();
    fixture.freshness.sequence = [
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      changedFreshness(),
      changedFreshness(),
    ];
    fixture.compensation.decision =
      ReviewV2PublicationCompensationDecision.Allowed;
    fixture.effectGate.decisions = [
      ReviewV2PublicationEffectGateDecision.Allowed,
      ReviewV2PublicationEffectGateDecision.Unavailable,
    ];

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_effect_gate_unavailable",
      },
    );

    expect(fixture.effectGate.calls).toBe(2);
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.gateway.compensationCalls).toBe(0);
  });

  it("records an acknowledged late effect, compensates by policy, and persists the exact terminal outcome", async () => {
    const reconcileUntil = at("2026-07-23T12:00:30.000Z");
    const fixture = await createFixture({ reconcileUntil });
    fixture.freshness.sequence = [
      currentFreshness(),
      currentFreshness(),
      currentFreshness(),
      changedFreshness(),
      changedFreshness(),
      changedFreshness(),
    ];
    fixture.compensation.decision =
      ReviewV2PublicationCompensationDecision.Allowed;
    fixture.freshness.onRead = (readCount) => {
      if (readCount === 4) fixture.clock.set(reconcileUntil);
    };

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Terminalized,
        safeReason: "stale_effect_compensated",
        terminalOutcome: "stale_compensated",
      },
    );
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: { terminalOutcome: "stale_compensated" },
      effects: [{ externalObjectId: "object-1" }],
      tombstones: [
        {
          finalOutcome: "stale_compensated",
          lastErrorCode: "post_mutation_freshness_changed",
        },
      ],
    });
  });

  it("terminalizes an unproven outcome after owner expiry without reopening SCM past the reconcile window", async () => {
    const fixture = await createFixture({
      reconcileUntil: at("2026-07-23T12:05:00.000Z"),
      claimDurationMs: 1_000,
    });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "scm_timeout",
      },
    );

    fixture.clock.set(at("2026-07-23T12:06:00.000Z"));
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.TerminalUnknown,
        safeReason: "publication_terminal_unknown_manual_review_required",
      },
    );
    expect(fixture.gateway.applyCalls).toBe(1);
    expect(fixture.credentials.purposes).toEqual([
      ReviewV2ScmCredentialPurpose.Mutate,
    ]);
  });

  it("fails closed on marker identity conflicts and pagination cursor cycles", async () => {
    const markerConflict = await createFixture();
    markerConflict.gateway.pages = [
      {
        objects: [{ ...gatewayObject("foreign"), markerHash: hash("9") }],
        nextCursor: null,
      },
    ];
    await expect(
      markerConflict.executor.execute(executionCommand()),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.ManualRequired,
      safeReason: "publication_marker_inventory_invalid",
    });
    expect(markerConflict.gateway.applyCalls).toBe(0);

    const cursorCycle = await createFixture();
    cursorCycle.gateway.pages = [
      { objects: [], nextCursor: "same" },
      { objects: [], nextCursor: "same" },
    ];
    await expect(
      cursorCycle.executor.execute(executionCommand()),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.ManualRequired,
      safeReason: "publication_marker_inventory_invalid",
    });
    expect(cursorCycle.gateway.applyCalls).toBe(0);
  });

  it("fences a claim takeover immediately before apply", async () => {
    const fixture = await createFixture();
    fixture.freshness.onRead = (readCount) => {
      if (readCount === 3) {
        fixture.clock.set(at("2026-07-23T12:02:00.000Z"));
      }
    };

    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Busy,
        safeReason: "publication_claim_fenced_before_mutation",
      },
    );
    expect(fixture.gateway.applyCalls).toBe(0);
  });

  it("starts a current operation attempt after reconciling work from an expired claim", async () => {
    const fixture = await createFixture({ claimDurationMs: 1_000 });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "scm_timeout",
      },
    );

    fixture.clock.set(at("2026-07-23T12:00:02.000Z"));
    fixture.gateway.applyError = null;
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );

    const view = await fixture.repository.findById("publication-1");
    expect(view?.operationAttempts.map(({ state }) => state).sort()).toEqual([
      "completed",
      "stale",
    ]);
    expect(fixture.gateway.applyCalls).toBe(2);
  });

  it("does not report no-effect when takeover cannot begin its current operation attempt", async () => {
    const fixture = await createFixture({ claimDurationMs: 1_000 });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "scm_timeout",
      },
    );

    fixture.clock.set(at("2026-07-23T12:00:02.000Z"));
    vi.spyOn(fixture.application, "beginOperation").mockRejectedValueOnce(
      new Error("begin unavailable"),
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "publication_begin_gate_rejected",
      },
    );

    const view = await fixture.repository.findById("publication-1");
    expect(view?.attempt.terminalOutcome).toBeNull();
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("keeps sibling no-effect terminalization retryable after an ambiguous operation", async () => {
    const fixture = await createFixture({
      claimDurationMs: 1_000,
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Retryable,
        safeReason: "scm_timeout",
      },
    );

    fixture.clock.set(at("2026-07-23T12:00:02.000Z"));
    fixture.freshness.current = changedFreshness();
    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Retryable,
      safeReason: "publication_live_facts_changed",
    });

    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "publishing",
        terminalOutcome: null,
        operations: [
          { publicationOperationId: "operation-1", state: "reconciling" },
          { publicationOperationId: "operation-2", state: "planned" },
        ],
      },
      tombstones: [],
    });
  });

  it("executes the requested planned operation when a completed sibling is still current", async () => {
    const fixture = await createFixture({
      operations: independentOperationPlans(),
    });
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    fixture.gateway.pages = [{ objects: [], nextCursor: null }];

    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Completed,
      safeReason: "publication_operation_completed",
      receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
    });
    expect(fixture.gateway.applyCalls).toBe(2);
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "terminal",
        terminalOutcome: "succeeded",
        operations: [
          { publicationOperationId: "operation-1", state: "completed" },
          { publicationOperationId: "operation-2", state: "completed" },
        ],
      },
      receipts: [
        { publicationOperationId: "operation-1" },
        { publicationOperationId: "operation-2" },
      ],
    });
  });

  it("keeps a planned operation untouched when freshness changes after aggregate routing", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );
    fixture.freshness.sequence = [currentFreshness(), changedFreshness()];

    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Retryable,
      safeReason: "publication_live_facts_changed",
    });
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "publishing",
        terminalOutcome: null,
        operations: [
          { publicationOperationId: "operation-1", state: "completed" },
          { publicationOperationId: "operation-2", state: "planned" },
        ],
      },
      tombstones: [],
    });
    expect(fixture.gateway.applyCalls).toBe(1);
  });

  it("reconciles and compensates a completed sibling before closing the attempt", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    await expect(fixture.executor.execute(executionCommand())).resolves.toEqual(
      {
        status: ReviewV2PublicationExecutionStatus.Completed,
        safeReason: "publication_operation_completed",
        receiptStatus: ReviewPublicationReceiptStatus.Succeeded,
      },
    );

    fixture.compensation.decision =
      ReviewV2PublicationCompensationDecision.Allowed;
    fixture.freshness.current = changedFreshness();
    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Terminalized,
      safeReason: "stale_effect_compensated",
      terminalOutcome: ReviewPublicationTerminalOutcome.StaleCompensated,
    });

    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "terminal",
        terminalOutcome: "stale_compensated",
        operations: [
          { publicationOperationId: "operation-1", state: "stale_compensated" },
          {
            publicationOperationId: "operation-2",
            state: "superseded_no_effect",
          },
        ],
      },
      tombstones: [
        {
          publicationOperationId: "operation-1",
          finalOutcome: "stale_compensated",
        },
        {
          publicationOperationId: "operation-2",
          finalOutcome: "superseded_no_effect",
        },
      ],
      operationAttempts: [
        {
          publicationOperationId: "operation-1",
          state: "completed",
        },
      ],
    });
    expect(fixture.gateway.compensationCalls).toBe(1);
    expect(fixture.credentials.purposes.at(-1)).toBe(
      ReviewV2ScmCredentialPurpose.ReconcileOnly,
    );
    expect(fixture.gateway.applyCalls).toBe(1);
    const aggregateReplay = {
      status: ReviewV2PublicationExecutionStatus.Terminalized,
      safeReason: "publication_stale_compensated",
      terminalOutcome: ReviewPublicationTerminalOutcome.StaleCompensated,
    } as const;
    await expect(
      fixture.executor.execute(executionCommand("operation-1")),
    ).resolves.toEqual(aggregateReplay);
    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual(aggregateReplay);
  });

  it("terminalizes completed sibling ambiguity after the reconcile deadline", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans().map((operation) => ({
        ...operation,
        reconcileUntil: at("2026-07-23T12:00:11.000Z"),
      })),
    });
    await fixture.executor.execute(executionCommand());
    fixture.clock.set(at("2026-07-23T12:00:12.000Z"));
    fixture.freshness.current = changedFreshness();

    await expect(
      fixture.executor.execute(executionCommand("operation-2")),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.TerminalUnknown,
      safeReason: "publication_terminal_unknown_manual_review_required",
    });
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: {
        state: "terminal",
        terminalOutcome: "terminal_unknown",
        operations: [
          { publicationOperationId: "operation-1", state: "terminal_unknown" },
          {
            publicationOperationId: "operation-2",
            state: "superseded_no_effect",
          },
        ],
      },
      tombstones: [
        {
          publicationOperationId: "operation-1",
          finalOutcome: "terminal_unknown",
        },
        {
          publicationOperationId: "operation-2",
          finalOutcome: "superseded_no_effect",
        },
      ],
    });
  });

  it("keeps a sibling retryable while another replica owns the active claim", async () => {
    const fixture = await createFixture({
      operations: pendingReviewOperationPlans(),
    });
    fixture.gateway.applyError = new ReviewV2ScmMutationError(
      "scm_timeout",
      ReviewV2ScmMutationFailureOutcome.EffectMayExist,
      true,
    );
    await fixture.executor.execute(executionCommand());

    await expect(
      fixture.executor.execute(executionCommand("operation-2", hash("9"))),
    ).resolves.toEqual({
      status: ReviewV2PublicationExecutionStatus.Busy,
      safeReason: "publication_claim_owned_elsewhere",
    });
    expect(await fixture.repository.findById("publication-1")).toMatchObject({
      attempt: { state: "publishing", terminalOutcome: null },
      tombstones: [],
    });
  });
});

async function createFixture(
  input: {
    readonly reconcileUntil?: Date;
    readonly claimDurationMs?: number;
    readonly operations?: readonly ReviewPublicationOperationPlan[];
  } = {},
) {
  const permit = permitIdentity();
  const repository = new InMemoryReviewPublicationRepository();
  const clock = new MutableReviewPublicationClock(initialTime);
  const application = createReviewPublicationV2Application({
    clock,
    decisions: allowingReviewPublicationDecisionPorts(permit),
    attempts: repository,
    idempotency: repository,
    adjudicationEvidence: productionReviewV2AdjudicationEvidence,
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
    enabledCapabilities: productionReviewV2PublicationCapabilities(),
  });
  const requested = await application.request({
    publicationAttemptId: "publication-1",
    requestIdHash: hash("1"),
    requestHash: hash("2"),
    permit,
    operations: input.operations ?? [operationPlan(input.reconcileUntil)],
    createdAt: initialTime,
    retainUntil: at("2026-08-23T12:00:00.000Z"),
  });
  if (requested.status !== RequestReviewPublicationStatus.Applied) {
    throw new Error("fixture_publication_request_failed");
  }
  const freshness = new MutableFreshness(currentFreshness());
  const gateway = new FakeGateway();
  const credentials = new FakeCredentials(gateway);
  const compensation = {
    decision: ReviewV2PublicationCompensationDecision.ManualOnly,
    async decide() {
      return this.decision;
    },
  };
  const effectGate = new MutableEffectGate();
  const executor = new ExecuteReviewV2PublicationOperation(
    {
      attempts: repository,
      application,
      freshness,
      compensation,
      operationCapabilities: {
        async issue({ capability }) {
          return {
            token: "test-signed-operation-capability",
            capabilityId: capability.capabilityId,
            signingKeyId: capability.capabilitySigningKeyId,
            expiresAt: capability.effectReportUntil,
          };
        },
      },
      credentials,
      capabilityIdentity: {
        async activeSigningKeyId() {
          return "test-signing-key";
        },
      },
      effectGate,
      clock,
    },
    {
      claimDurationMs: input.claimDurationMs ?? 60_000,
      minimumMutationLeaseMs: Math.min(500, input.claimDurationMs ?? 60_000),
      maxMarkerPages: 10,
    },
  );
  return {
    application,
    clock,
    compensation,
    credentials,
    effectGate,
    executor,
    freshness,
    gateway,
    permit,
    repository,
  };
}

class MutableFreshness {
  reads = 0;
  sequence: ReviewV2PublicationFreshnessRead[] = [];
  onRead: ((readCount: number) => void) | null = null;

  constructor(public current: ReviewV2PublicationFreshnessRead) {}

  async read(): Promise<ReviewV2PublicationFreshnessRead> {
    this.reads += 1;
    this.onRead?.(this.reads);
    return this.sequence.shift() ?? this.current;
  }
}

class MutableEffectGate {
  calls = 0;
  decision = ReviewV2PublicationEffectGateDecision.Allowed;
  decisions: ReviewV2PublicationEffectGateDecision[] = [];
  error: Error | null = null;

  async authorize(): Promise<ReviewV2PublicationEffectGateDecision> {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.decisions.shift() ?? this.decision;
  }
}

class FakeCredentials {
  readonly purposes: ReviewV2ScmCredentialPurpose[] = [];

  constructor(private readonly gateway: FakeGateway) {}

  async acquire(input: { readonly purpose: ReviewV2ScmCredentialPurpose }) {
    this.purposes.push(input.purpose);
    if (input.purpose === ReviewV2ScmCredentialPurpose.Mutate) {
      return {
        purpose: input.purpose,
        gateway: this.gateway,
        async close() {},
      } as const;
    }
    return {
      purpose: input.purpose,
      gateway: {
        findAllByMarker: this.gateway.findAllByMarker.bind(this.gateway),
        markStaleOrDelete: this.gateway.markStaleOrDelete.bind(this.gateway),
      },
      async close() {},
    } as const;
  }
}

class FakeGateway implements ReviewV2ProviderPublicationClientPort {
  pages: Array<{
    readonly objects: readonly ReviewPublicationGatewayObject[];
    readonly nextCursor: string | null;
  }> = [{ objects: [], nextCursor: null }];
  applyError: Error | null = null;
  objectsOnApplyError: readonly ReviewPublicationGatewayObject[] = [];
  postApplyObjects: readonly ReviewPublicationGatewayObject[] = [];
  inventorySnapshots: Array<readonly ReviewPublicationGatewayObject[]> = [];
  applyCalls = 0;
  compensationCalls = 0;
  readonly requestedCursors: Array<string | null> = [];

  async findAllByMarker(input: { readonly cursor: string | null }) {
    this.requestedCursors.push(input.cursor);
    if (input.cursor === null && this.inventorySnapshots.length > 0) {
      return {
        objects: this.inventorySnapshots.shift() ?? [],
        nextCursor: null,
      };
    }
    const index = input.cursor === null ? 0 : 1;
    return this.pages[index] ?? { objects: [], nextCursor: null };
  }

  async applyOperation(input: {
    readonly operation: ReviewPublicationOperationPlan;
  }) {
    this.applyCalls += 1;
    if (this.applyError) {
      this.pages = [{ objects: this.objectsOnApplyError, nextCursor: null }];
      throw this.applyError;
    }
    const object = {
      ...gatewayObject("object-1"),
      markerHash: input.operation.markerHash,
      bodyHash: input.operation.bodyHash,
    };
    this.pages = [
      { objects: [...this.postApplyObjects, object], nextCursor: null },
    ];
    return object;
  }

  async markStaleOrDelete(input: { readonly compensateCanonical: boolean }) {
    this.compensationCalls += 1;
    if (input.compensateCanonical) {
      this.pages = [{ objects: [], nextCursor: null }];
    }
    return ReviewPublicationReceiptStatus.Succeeded;
  }
}

function executionCommand(
  publicationOperationId = "operation-1",
  commandOwnerIdHash = ownerIdHash,
) {
  return {
    publicationAttemptId: "publication-1",
    publicationOperationId,
    provider: ReviewV2ScmProvider.GitHub,
    ownerIdHash: commandOwnerIdHash,
  } as const;
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
    publicationNotAfter: at("2026-07-23T12:00:10.000Z"),
  };
}

function operationPlan(reconcileUntil?: Date): ReviewPublicationOperationPlan {
  return {
    publicationOperationId: "operation-1",
    publicationKind: ReviewPublicationKind.Summary,
    chunkIndex: 0,
    effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
    role: ReviewPublicationOperationRole.Standalone,
    markerHash: hash("1"),
    bodyHash: hash("2"),
    renderPolicyVersion: 1,
    targetCommitId: hash("a"),
    reviewRevisionHash: hash("b"),
    required: true,
    dependsOnOperationId: null,
    reconcileUntil: reconcileUntil ?? at("2026-07-23T12:30:00.000Z"),
  };
}

function pendingReviewOperationPlans(): readonly ReviewPublicationOperationPlan[] {
  const create: ReviewPublicationOperationPlan = {
    ...operationPlan(),
    publicationKind: ReviewPublicationKind.PendingReviewCreate,
    effectStrategy: ReviewPublicationEffectStrategy.PendingThenSubmit,
    role: ReviewPublicationOperationRole.PendingReviewCreate,
  };
  return [
    create,
    {
      ...create,
      publicationOperationId: "operation-2",
      publicationKind: ReviewPublicationKind.PendingReviewSubmit,
      role: ReviewPublicationOperationRole.PendingReviewSubmit,
      markerHash: hash("5"),
      bodyHash: hash("6"),
      dependsOnOperationId: create.publicationOperationId,
    },
  ];
}

function independentOperationPlans(): readonly ReviewPublicationOperationPlan[] {
  const first = operationPlan();
  return [
    first,
    {
      ...first,
      publicationOperationId: "operation-2",
      chunkIndex: 1,
      markerHash: hash("5"),
      bodyHash: hash("6"),
    },
  ];
}

function gatewayObject(
  externalObjectId: string,
): ReviewPublicationGatewayObject {
  return {
    externalObjectId,
    effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
    markerHash: hash("1"),
    bodyHash: hash("2"),
    observedObjectHash: hash("3"),
    observedAt: initialTime,
  };
}

function currentFreshness(): ReviewV2PublicationFreshnessRead {
  return {
    status: ReviewV2PublicationFreshnessReadStatus.Available,
    snapshot: {
      baseSha: hash("1"),
      mergeBaseSha: hash("2"),
      reviewedHeadSha: hash("a"),
      reviewRevisionHash: hash("b"),
      lifecycleStateHash: hash("d"),
      commandLedgerWatermark: 2n,
      authorizationId: "authorization-1",
      producerReleaseId: "release-1",
      permitEpoch: 7n,
      publicationSafetyDecisionHash: hash("f"),
      publicationNotAfter: at("2026-07-23T12:00:10.000Z"),
    },
  };
}

function changedFreshness(): ReviewV2PublicationFreshnessRead {
  return {
    status: ReviewV2PublicationFreshnessReadStatus.Available,
    snapshot: {
      baseSha: hash("1"),
      mergeBaseSha: hash("2"),
      reviewedHeadSha: hash("9"),
      reviewRevisionHash: hash("8"),
      lifecycleStateHash: hash("7"),
      commandLedgerWatermark: 3n,
      authorizationId: "authorization-1",
      producerReleaseId: "release-1",
      permitEpoch: 7n,
      publicationSafetyDecisionHash: hash("f"),
      publicationNotAfter: at("2026-07-23T12:00:10.000Z"),
    },
  };
}

function hash(character: string): string {
  return character.repeat(64);
}

function at(value: string): Date {
  return new Date(value);
}
