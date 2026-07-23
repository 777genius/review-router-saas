import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReviewRequestedIntentStore } from "@reviewrouter/features-review-executions/testing";
import {
  ReviewRequestIngressCommandKind,
  ReviewRequestedIntentService,
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
  reviewRequestIngressEventType,
  reviewRequestIngressEventVersion,
} from "@reviewrouter/features-review-executions";
import { CanonicalReviewRevisionResolutionStatus } from "@reviewrouter/features-review-run-control";
import type { OutboxEvent } from "@reviewrouter/features-outbox";
import {
  ReviewRequestEligibilityStatus,
  createReviewRequestIngressHandler,
} from "./review-v2-request-ingress-handler";

const now = new Date("2026-07-23T10:00:00.000Z");

describe("review request ingress handler", () => {
  it("resolves current facts and registers one canonical intent", async () => {
    const fixture = createFixture();

    await fixture.handler.handle(event());
    await fixture.handler.handle(event());

    await expect(
      fixture.store.findByRequestId(`review-request-${"d".repeat(64)}`),
    ).resolves.toMatchObject({
      state: ReviewRequestedIntentState.PendingDispatch,
      revision: { reviewRevisionHash: "e".repeat(64) },
    });
  });

  it("does not resurrect an ingress event for an older head", async () => {
    const fixture = createFixture({ currentHeadSha: "f".repeat(40) });

    await fixture.handler.handle(event());

    await expect(
      fixture.store.findByRequestId(`review-request-${"d".repeat(64)}`),
    ).resolves.toBeNull();
  });

  it("cancels every pre-admission intent when the pull request closes", async () => {
    const fixture = createFixture();
    await fixture.handler.handle(event());
    fixture.current.state = "closed";

    await fixture.handler.handle(
      event({
        id: "outbox-cancel",
        idempotencyKey: "cancel",
        payload: {
          ...basePayload(),
          commandKind: ReviewRequestIngressCommandKind.Cancel,
          deliveryIdentityHash: "a".repeat(64),
        },
      }),
    );

    await expect(
      fixture.store.findByRequestId(`review-request-${"d".repeat(64)}`),
    ).resolves.toMatchObject({ state: ReviewRequestedIntentState.Superseded });
  });

  it("retries unavailable eligibility facts without creating an intent", async () => {
    const fixture = createFixture({ unavailable: true });

    await expect(fixture.handler.handle(event())).rejects.toMatchObject({
      code: "review_request_eligibility_unavailable",
      retryable: true,
    });
  });
});

function createFixture(
  input: {
    readonly currentHeadSha?: string;
    readonly unavailable?: boolean;
  } = {},
) {
  const store = new InMemoryReviewRequestedIntentStore();
  const current = {
    state: "open" as "open" | "closed",
    draft: false,
    baseSha: "a".repeat(40),
    headSha: input.currentHeadSha ?? "b".repeat(40),
    headRepositoryFullName: "777genius/agent-teams-ai",
    authorType: "User",
  };
  return {
    store,
    current,
    handler: createReviewRequestIngressHandler({
      intents: new ReviewRequestedIntentService(store, store),
      revisions: {
        resolve: async () => ({
          status: CanonicalReviewRevisionResolutionStatus.Resolved,
          pullRequestNumber: 42,
          baseSha: current.baseSha,
          mergeBaseSha: "c".repeat(40),
          headSha: current.headSha,
          reviewRevisionHash: "e".repeat(64),
        }),
      },
      eligibility: {
        load: async () =>
          input.unavailable
            ? { status: ReviewRequestEligibilityStatus.Unavailable }
            : { status: ReviewRequestEligibilityStatus.Current, ...current },
      },
      digest: {
        digestUtf8: async (value) =>
          createHash("sha256").update(value).digest("hex"),
      },
      clock: { now: () => now },
      reviewDrafts: () => false,
    }),
  };
}

function basePayload() {
  return {
    protocolVersion: 1 as const,
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 42,
    githubInstallationId: "123",
    repositoryFullName: "777genius/agent-teams-ai",
  };
}

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "outbox-1",
    type: reviewRequestIngressEventType,
    version: reviewRequestIngressEventVersion,
    idempotencyKey: "request",
    workspaceId: "workspace-1",
    repositoryId: "connection-1",
    aggregateId: "scope-1",
    payload: {
      ...basePayload(),
      commandKind: ReviewRequestIngressCommandKind.Request,
      deliveryIdentityHash: "d".repeat(64),
      requestId: `review-request-${"d".repeat(64)}`,
      triggerKind: ReviewRequestedTriggerKind.ManualCommand,
      expectedBaseSha: "a".repeat(40),
      expectedHeadSha: "b".repeat(40),
      quietPeriodMs: 0,
      retentionMs: 86_400_000,
    },
    status: "processing",
    attempts: 1,
    maxAttempts: 20,
    nextAttemptAt: null,
    claimId: "claim-1",
    claimVersion: 1n,
    claimOwnerHash: "owner-1",
    claimUntil: new Date("2026-07-23T10:01:00.000Z"),
    occurredAt: now,
    ...overrides,
  };
}
