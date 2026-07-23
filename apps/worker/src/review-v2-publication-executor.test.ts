import { describe, expect, it } from "vitest";
import {
  RequestReviewPublicationStatus,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationRole,
  ReviewPublicationReceiptStatus,
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

  it("uses a reconciliation-only claim after owner expiry and terminalizes an unproven outcome", async () => {
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
    expect(fixture.credentials.purposes.at(-1)).toBe(
      ReviewV2ScmCredentialPurpose.ReconcileOnly,
    );
  });

  it("fails closed on marker identity conflicts and pagination cursor cycles", async () => {
    const markerConflict = await createFixture();
    markerConflict.gateway.pages = [
      {
        objects: [{ ...gatewayObject("foreign"), bodyHash: hash("9") }],
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
});

async function createFixture(
  input: {
    readonly reconcileUntil?: Date;
    readonly claimDurationMs?: number;
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
    operations: [operationPlan(input.reconcileUntil)],
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
  applyCalls = 0;
  compensationCalls = 0;
  readonly requestedCursors: Array<string | null> = [];

  async findAllByMarker(input: { readonly cursor: string | null }) {
    this.requestedCursors.push(input.cursor);
    const index = input.cursor === null ? 0 : 1;
    return this.pages[index] ?? { objects: [], nextCursor: null };
  }

  async applyOperation() {
    this.applyCalls += 1;
    if (this.applyError) throw this.applyError;
    const object = gatewayObject("object-1");
    this.pages = [{ objects: [object], nextCursor: null }];
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

function executionCommand() {
  return {
    publicationAttemptId: "publication-1",
    publicationOperationId: "operation-1",
    provider: ReviewV2ScmProvider.GitHub,
    ownerIdHash,
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
