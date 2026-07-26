import { describe, expect, it, vi } from "vitest";
import {
  createReviewRequestedIntent,
  decideReviewRequestedRerunRegistration,
  decideReviewRequestedAdmission,
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedRerunEnsureStatus,
  ReviewRequestedRerunRegistrationDecisionStatus,
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
  nextResolutionAt: new Date("2026-07-25T08:00:05.000Z"),
  resolutionDeadlineAt: new Date("2026-07-25T08:05:00.000Z"),
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
    expect(kit.recordAdmissionDecision).toHaveBeenCalledTimes(2);
  });

  it("revalidates an admitted durable decision through the command CAS", async () => {
    const admitted = decideReviewRequestedAdmission({
      intent,
      expectedVersion: intent.version,
      changedLines: 150,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:persisted",
      decisionHash: "8".repeat(64),
      verdict: ReviewRequestAdmissionState.Admitted,
      now,
    });
    if (admitted.status !== ReviewRequestedTransitionDecisionStatus.Applied) {
      throw new Error("test_admission_not_applied");
    }
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      initialIntent: admitted.intent,
    });

    await expect(kit.gate.evaluate(input())).resolves.toEqual({
      status: "admitted",
      decisionHash: "8".repeat(64),
    });
    expect(kit.recordAdmissionDecision).toHaveBeenCalledOnce();
    expect(kit.resolvePullRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the handoff budget expires during identity polling", async () => {
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      missingIntentAttempts: 2,
      clockNow: new Date("2026-07-25T08:04:31.000Z"),
    });

    await expect(kit.gate.evaluate(input())).rejects.toThrow(
      "review_request_admission_transition_conflict",
    );
    expect(kit.findIntent).toHaveBeenCalledTimes(4);
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

    await expect(kit.gate.evaluate(input(false))).resolves.toEqual({
      status: "not_applicable",
    });
    expect(kit.resolvePullRequest).not.toHaveBeenCalled();
    expect(kit.sleep).not.toHaveBeenCalled();
  });

  it("waits for a required workflow run identity to be durably bound", async () => {
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      missingIntentAttempts: 2,
    });

    await expect(kit.gate.evaluate(input())).resolves.toMatchObject({
      status: "admitted",
    });
    expect(kit.findIntent).toHaveBeenCalledTimes(3);
    expect(kit.sleep).toHaveBeenCalledTimes(2);
  });

  it("creates and admits a fresh durable intent for a GitHub rerun attempt", async () => {
    const prior = dispatchedIntent();
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      initialIntent: prior,
    });

    await expect(kit.gate.evaluate(input(true, "2"))).resolves.toMatchObject({
      status: "admitted",
      decisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(kit.findIntent).toHaveBeenCalledOnce();
    expect(kit.listIntents).toHaveBeenCalled();
    expect(kit.ensureRerunIntent).toHaveBeenCalledOnce();
    expect(kit.resolvePullRequest).toHaveBeenCalledOnce();
  });

  it("fails a rerun closed when the current pull request head moved", async () => {
    const kit = buildGate({
      additions: 100,
      deletions: 50,
      initialIntent: dispatchedIntent(),
      resolvedHeadSha: "9".repeat(40),
    });

    await expect(kit.gate.evaluate(input(true, "2"))).rejects.toThrow(
      "review_request_revision_moved",
    );
    expect(kit.ensureRerunIntent).not.toHaveBeenCalled();
    expect(kit.recordAdmissionDecision).not.toHaveBeenCalled();
  });
});

function input(intentRequired = true, sourceRunAttempt = "1") {
  return {
    repository,
    sourceRunId: "30150048512",
    sourceRunAttempt,
    intentRequired,
    now,
  };
}

function dispatchedIntent(): ReviewRequestedIntent {
  return {
    ...intent,
    version: 6n,
    state: ReviewRequestedIntentState.Dispatched,
    nextResolutionAt: null,
    authorizationId: "authorization_1",
    executionId: "execution_1",
    admission: {
      state: ReviewRequestAdmissionState.Admitted,
      changedLines: 150,
      maxChangedLines: 250_000,
      policySnapshotId: "hosted-review-size-v1:prior",
      decisionHash: "8".repeat(64),
      checkedAt: now,
    },
  };
}

function buildGate(options: {
  readonly additions: number;
  readonly deletions: number;
  readonly resolvedHeadSha?: string;
  readonly transitionStatus?: ReviewRequestedTransitionStatus;
  readonly noIntent?: boolean;
  readonly missingIntentAttempts?: number;
  readonly initialIntent?: ReviewRequestedIntent;
  readonly clockNow?: Date;
}) {
  const persisted = new Map<string, ReviewRequestedIntent>();
  if (!options.noIntent) {
    const initial = options.initialIntent ?? intent;
    persisted.set(initial.requestId, initial);
  }
  let lookupAttempts = 0;
  let forcedTransitionConsumed = false;
  const findIntent = vi.fn(async (query) => {
    lookupAttempts += 1;
    if (lookupAttempts <= (options.missingIntentAttempts ?? 0)) return null;
    return (
      [...persisted.values()].find(
        (candidate) =>
          candidate.repositoryConnectionId === query.repositoryConnectionId &&
          candidate.sourceRunId === query.sourceRunId &&
          candidate.sourceRunAttempt === query.sourceRunAttempt,
      ) ?? null
    );
  });
  const listIntents = vi.fn(async (query) =>
    [...persisted.values()].filter(
      (candidate) =>
        candidate.repositoryConnectionId === query.repositoryConnectionId &&
        candidate.sourceRunId === query.sourceRunId,
    ),
  );
  const ensureRerunIntent = vi.fn(async (command) => {
    const decision = decideReviewRequestedRerunRegistration({
      candidate: command.candidate,
      intentsForSourceRun: await listIntents({
        repositoryConnectionId: command.candidate.repositoryConnectionId,
        sourceRunId: command.candidate.sourceRunId,
      }),
    });
    if (
      decision.status === ReviewRequestedRerunRegistrationDecisionStatus.Create
    ) {
      persisted.set(decision.intent.requestId, decision.intent);
      return {
        status: ReviewRequestedRerunEnsureStatus.Created,
        intent: decision.intent,
      };
    }
    if (
      decision.status === ReviewRequestedRerunRegistrationDecisionStatus.Restore
    ) {
      return {
        status: ReviewRequestedRerunEnsureStatus.Restored,
        intent: decision.intent,
      };
    }
    return { status: decision.status };
  });
  const sleep = vi.fn(async () => undefined);
  const recordAdmissionDecision = vi.fn(async (command) => {
    const current = persisted.get(command.requestId);
    if (!current) {
      return { status: ReviewRequestedTransitionStatus.Missing };
    }
    const decision = decideReviewRequestedAdmission({
      intent: current,
      ...command,
    });
    if (
      decision.status !== ReviewRequestedTransitionDecisionStatus.Applied &&
      decision.status !== ReviewRequestedTransitionDecisionStatus.Restored
    ) {
      return { status: ReviewRequestedTransitionStatus.Conflict };
    }
    persisted.set(decision.intent.requestId, decision.intent);
    if (
      options.transitionStatus &&
      options.transitionStatus !== ReviewRequestedTransitionStatus.Applied &&
      !forcedTransitionConsumed
    ) {
      forcedTransitionConsumed = true;
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
    listIntents,
    ensureRerunIntent,
    gate: new ProductionHostedReviewPreleaseGate({
      requestedIntentQueries: {
        findByRepositorySourceRunIdentity: findIntent,
        listByRepositorySourceRunId: listIntents,
      } as never,
      requestedIntentCommands: {
        recordAdmissionDecision,
        ensureRerunIntent,
      } as never,
      pullRequests: { resolve: resolvePullRequest },
      clock: { now: () => options.clockNow ?? now },
      maxChangedLines: 250_000,
      sleep,
    }),
    recordAdmissionDecision,
    resolvePullRequest,
    sleep,
  };
}
