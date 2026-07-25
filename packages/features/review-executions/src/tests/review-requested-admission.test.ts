import { describe, expect, it } from "vitest";
import {
  createReviewRequestedIntent,
  decideReviewRequestedAdmission,
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedTriggerKind,
  type ReviewRequestedIntent,
} from "../index";

const now = new Date("2026-07-25T08:00:00.000Z");

describe("review requested admission", () => {
  it("admits the exact cap and preserves the awaiting-authorization state", () => {
    const intent = awaitingIntent();

    const decision = decideReviewRequestedAdmission({
      intent,
      expectedVersion: intent.version,
      changedLines: 250_000,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "1".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now,
    });

    expect(decision).toMatchObject({
      status: ReviewRequestedTransitionDecisionStatus.Applied,
      intent: {
        state: ReviewRequestedIntentState.AwaitingAuthorization,
        version: 5n,
        admission: {
          state: ReviewRequestAdmissionState.Admitted,
          changedLines: 250_000,
          maxChangedLines: 250_000,
        },
      },
    });
  });

  it("terminalizes an oversized intent before authorization", () => {
    const intent = awaitingIntent();

    const decision = decideReviewRequestedAdmission({
      intent,
      expectedVersion: intent.version,
      changedLines: 250_001,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "2".repeat(64),
      verdict: ReviewRequestAdmissionState.Rejected,
      now,
    });

    expect(decision).toMatchObject({
      status: ReviewRequestedTransitionDecisionStatus.Applied,
      intent: {
        state: ReviewRequestedIntentState.Terminal,
        terminalReason:
          ReviewRequestedIntentTerminalReason.MaxChangedLinesExceeded,
        authorizationId: null,
        executionId: null,
        admission: {
          state: ReviewRequestAdmissionState.Rejected,
        },
      },
    });
  });

  it("restores only the exact durable decision", () => {
    const first = decideReviewRequestedAdmission({
      intent: awaitingIntent(),
      expectedVersion: 4n,
      changedLines: 100,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "3".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now,
    });
    if (first.status !== ReviewRequestedTransitionDecisionStatus.Applied) {
      throw new Error("test_admission_not_applied");
    }

    const restored = decideReviewRequestedAdmission({
      intent: first.intent,
      expectedVersion: 4n,
      changedLines: 100,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "3".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now,
    });
    const conflicting = decideReviewRequestedAdmission({
      intent: first.intent,
      expectedVersion: 4n,
      changedLines: 101,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "4".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now,
    });
    const expired = decideReviewRequestedAdmission({
      intent: first.intent,
      expectedVersion: 4n,
      changedLines: 100,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:test",
      decisionHash: "3".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now: new Date(now.getTime() + 60_001),
    });

    expect(restored.status).toBe(
      ReviewRequestedTransitionDecisionStatus.Restored,
    );
    expect(conflicting.status).toBe(
      ReviewRequestedTransitionDecisionStatus.Conflict,
    );
    expect(expired.status).toBe(
      ReviewRequestedTransitionDecisionStatus.Conflict,
    );
  });

  it("rejects a verdict that does not match the measured line count", () => {
    const intent = awaitingIntent();

    expect(() =>
      decideReviewRequestedAdmission({
        intent,
        expectedVersion: intent.version,
        changedLines: 250_001,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:test",
        decisionHash: "5".repeat(64),
        verdict: ReviewRequestAdmissionState.Admitted,
        now,
      }),
    ).toThrow("review_request_admission_verdict_invalid");
  });

  it("does not admit after the persisted authorization deadline", () => {
    const intent = awaitingIntent();

    expect(
      decideReviewRequestedAdmission({
        intent: {
          ...intent,
          resolutionDeadlineAt: new Date(now.getTime() - 1),
        },
        expectedVersion: intent.version,
        changedLines: 100,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:test",
        decisionHash: "6".repeat(64),
        verdict: ReviewRequestAdmissionState.Admitted,
        now,
      }).status,
    ).toBe(ReviewRequestedTransitionDecisionStatus.Conflict);
  });

  it("requires a minimum durable handoff window before admission", () => {
    const intent = awaitingIntent();

    expect(
      decideReviewRequestedAdmission({
        intent: {
          ...intent,
          resolutionDeadlineAt: new Date(now.getTime() + 29_999),
        },
        expectedVersion: intent.version,
        changedLines: 100,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:test",
        decisionHash: "7".repeat(64),
        verdict: ReviewRequestAdmissionState.Admitted,
        now,
      }).status,
    ).toBe(ReviewRequestedTransitionDecisionStatus.Conflict);
  });
});

function awaitingIntent(): ReviewRequestedIntent {
  return {
    ...createReviewRequestedIntent({
      workspaceId: "workspace_1",
      repositoryConnectionId: "repository_1",
      scmRepositoryIdentityId: "scm_1",
      pullRequestNumber: 252,
      requestId: "review-request-1",
      revision: {
        baseSha: "a".repeat(40),
        mergeBaseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        reviewRevisionHash: "d".repeat(64),
      },
      triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
      deliveryIdentityHash: "e".repeat(64),
      canonicalRequestHash: "f".repeat(64),
      notBefore: now,
      createdAt: now,
      retainUntil: new Date("2026-08-25T08:00:00.000Z"),
    }),
    version: 4n,
    state: ReviewRequestedIntentState.AwaitingAuthorization,
    nextResolutionAt: new Date(now.getTime() + 1_000),
    resolutionDeadlineAt: new Date(now.getTime() + 60_000),
    sourceRunId: "30150048512",
    sourceRunAttempt: "1",
  };
}
