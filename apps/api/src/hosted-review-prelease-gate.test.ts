import { describe, expect, it, vi } from "vitest";
import {
  createReviewRequestedIntent,
  decideReviewRequestedAdmission,
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedTransitionStatus,
  ReviewRequestedTriggerKind,
  type ReviewRequestedIntent,
} from "@reviewrouter/features-review-executions";
import { ProductionHostedReviewPreleaseGate } from "./hosted-review-prelease-gate.js";

const now = new Date("2026-07-25T08:00:00.000Z");
const headSha = "a".repeat(40);
const intent = {
  ...createReviewRequestedIntent({
    workspaceId: "workspace_1",
    repositoryConnectionId: "repo_1",
    scmRepositoryIdentityId: "scm_1",
    pullRequestNumber: 252,
    requestId: "review-request-1",
    revision: {
      baseSha: "b".repeat(40),
      mergeBaseSha: "c".repeat(40),
      headSha,
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
  sourceRunId: "30150048512",
  sourceRunAttempt: "1",
};
const repository = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  githubInstallationId: "789",
  fullName: "777genius/agent-teams-ai",
  owner: "777genius",
  selected: true,
  installationStatus: "active",
};

describe("ProductionHostedReviewPreleaseGate", () => {
  it("admits and persists an exact current revision below the server cap", async () => {
    const kit = buildGate({ additions: 100, deletions: 50 });

    const result = await kit.gate.evaluate(input());

    expect(result).toMatchObject({
      status: "admitted",
      decisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(kit.recordAdmissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: intent.requestId,
        changedLines: 150,
        maxChangedLines: 250_000,
        verdict: ReviewRequestAdmissionState.Admitted,
      }),
    );
  });

  it("persists an oversized rejection before OAuth lease acquisition", async () => {
    const kit = buildGate({ additions: 299_627, deletions: 47_351 });

    await expect(kit.gate.evaluate(input())).resolves.toMatchObject({
      status: "skipped",
      reason: "max_changed_lines_exceeded",
      changedLines: 346_978,
      maxChangedLines: 250_000,
      decisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(kit.recordAdmissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: ReviewRequestAdmissionState.Rejected,
      }),
    );
  });

  it("restores a matching durable decision after a concurrent CAS race", async () => {
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      transitionStatus: ReviewRequestedTransitionStatus.StaleClaim,
    });

    await expect(kit.gate.evaluate(input())).resolves.toMatchObject({
      status: "admitted",
    });
    expect(kit.findIntent).toHaveBeenCalledTimes(2);
  });

  it("fails closed when GitHub reports a different head", async () => {
    const kit = buildGate({
      additions: 10,
      deletions: 5,
      resolvedHeadSha: "9".repeat(40),
    });

    await expect(kit.gate.evaluate(input())).rejects.toThrow(
      "review_request_revision_moved",
    );
    expect(kit.recordAdmissionDecision).not.toHaveBeenCalled();
  });

  it("does not apply review policy to refresh runs without a durable intent", async () => {
    const kit = buildGate({ additions: 10, deletions: 5, noIntent: true });

    await expect(kit.gate.evaluate(input())).resolves.toEqual({
      status: "not_applicable",
    });
    expect(kit.resolvePullRequest).not.toHaveBeenCalled();
  });
});

function input() {
  return {
    repository,
    sourceRunId: "30150048512",
    sourceRunAttempt: "1",
    now,
  };
}

function buildGate(options: {
  readonly additions: number;
  readonly deletions: number;
  readonly resolvedHeadSha?: string;
  readonly transitionStatus?: ReviewRequestedTransitionStatus;
  readonly noIntent?: boolean;
}) {
  let persisted: ReviewRequestedIntent | null = options.noIntent
    ? null
    : intent;
  const findIntent = vi.fn(async () => persisted);
  const recordAdmissionDecision = vi.fn(async (command) => {
    const decision = decideReviewRequestedAdmission({
      intent,
      ...command,
    });
    if (
      decision.status !== ReviewRequestedTransitionDecisionStatus.Applied &&
      decision.status !== ReviewRequestedTransitionDecisionStatus.Restored
    ) {
      throw new Error("unexpected_test_decision");
    }
    persisted = decision.intent;
    if (
      options.transitionStatus &&
      options.transitionStatus !== ReviewRequestedTransitionStatus.Applied
    ) {
      return { status: options.transitionStatus };
    }
    return {
      status: ReviewRequestedTransitionStatus.Applied,
      intent: decision.intent,
    };
  });
  const resolvePullRequest = vi.fn().mockResolvedValue({
    pullRequestNumber: 252,
    headSha: options.resolvedHeadSha ?? headSha,
    additions: options.additions,
    deletions: options.deletions,
  });
  return {
    findIntent,
    gate: new ProductionHostedReviewPreleaseGate({
      requestedIntentQueries: {
        findByRepositorySourceRunIdentity: findIntent,
      } as never,
      requestedIntentCommands: {
        recordAdmissionDecision,
      } as never,
      pullRequests: { resolve: resolvePullRequest },
      maxChangedLines: 250_000,
    }),
    recordAdmissionDecision,
    resolvePullRequest,
  };
}
