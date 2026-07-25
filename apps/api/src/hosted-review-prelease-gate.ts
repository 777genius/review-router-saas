import { createHash } from "node:crypto";
import { decidePullRequestReviewAdmission } from "@reviewrouter/features-codex-oauth-rotating";
import type {
  ActionRepositoryContext,
  HostedReviewPreleaseGatePort,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedTransitionStatus,
  type ReviewRequestedIntent,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "@reviewrouter/features-review-executions";
import type { Clock } from "@reviewrouter/shared";

export interface HostedReviewPullRequestFactsPort {
  resolve(input: {
    readonly repository: ActionRepositoryContext;
    readonly pullRequestNumber: number;
  }): Promise<{
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

export class ProductionHostedReviewPreleaseGate implements HostedReviewPreleaseGatePort {
  private static readonly intentBindingPollAttempts = 21;
  private static readonly intentBindingPollIntervalMs = 250;
  private readonly maxChangedLines: number;
  private readonly policySnapshotId: string;

  constructor(
    private readonly dependencies: {
      readonly requestedIntentQueries: ReviewRequestedIntentQueryPort;
      readonly requestedIntentCommands: ReviewRequestedIntentCommandPort;
      readonly pullRequests: HostedReviewPullRequestFactsPort;
      readonly clock: Clock;
      readonly maxChangedLines: number;
      readonly sleep?: (delayMs: number) => Promise<void>;
    },
  ) {
    if (
      !Number.isSafeInteger(dependencies.maxChangedLines) ||
      dependencies.maxChangedLines < 1
    ) {
      throw new Error("hosted_review_max_changed_lines_invalid");
    }
    this.maxChangedLines = dependencies.maxChangedLines;
    this.policySnapshotId = `hosted-review-size-v1:${digest(
      JSON.stringify({
        maxChangedLines: dependencies.maxChangedLines,
        policyVersion: 1,
      }),
    )}`;
  }

  async evaluate(
    input: Parameters<HostedReviewPreleaseGatePort["evaluate"]>[0],
  ) {
    const intent = await this.findIntentWithBoundedWait(input);
    if (!intent) return { status: "not_applicable" as const };
    const restored = await this.restorePersistedDecision(input, intent);
    if (restored) return restored;
    if (intent.state !== ReviewRequestedIntentState.AwaitingAuthorization) {
      throw new Error("review_request_intent_not_awaiting_authorization");
    }

    const facts = await this.dependencies.pullRequests.resolve({
      repository: input.repository,
      pullRequestNumber: intent.pullRequestNumber,
    });
    if (
      facts.pullRequestNumber !== intent.pullRequestNumber ||
      facts.headSha.toLowerCase() !== intent.revision.headSha
    ) {
      throw new Error("review_request_revision_moved");
    }
    const changedLines = sumChangedLines(facts.additions, facts.deletions);
    const policy = decidePullRequestReviewAdmission({
      changedLines,
      maxChangedLines: this.maxChangedLines,
    });
    const verdict =
      policy.status === "admitted"
        ? ReviewRequestAdmissionState.Admitted
        : ReviewRequestAdmissionState.Rejected;
    if (
      policy.status === "skipped" &&
      policy.reason !== "max_changed_lines_exceeded"
    ) {
      throw new Error("hosted_review_changed_lines_unavailable");
    }
    const decisionHash = admissionDecisionHash({
      intent,
      changedLines,
      maxChangedLines: this.maxChangedLines,
      policySnapshotId: this.policySnapshotId,
      verdict,
    });
    const transition =
      await this.dependencies.requestedIntentCommands.recordAdmissionDecision({
        requestId: intent.requestId,
        expectedVersion: intent.version,
        changedLines,
        maxChangedLines: this.maxChangedLines,
        policySnapshotId: this.policySnapshotId,
        decisionHash,
        verdict,
        now: this.dependencies.clock.now(),
      });
    const decidedIntent =
      transition.status === ReviewRequestedTransitionStatus.Applied ||
      transition.status === ReviewRequestedTransitionStatus.Restored
        ? transition.intent
        : await this.findIntent(input);
    const decision =
      decidedIntent === undefined || decidedIntent === null
        ? null
        : transition.status === ReviewRequestedTransitionStatus.Applied ||
            transition.status === ReviewRequestedTransitionStatus.Restored
          ? decisionFromValidatedIntent(decidedIntent)
          : await this.restorePersistedDecision(input, decidedIntent);
    if (!decision || decision.decisionHash !== decisionHash) {
      throw new Error("review_request_admission_transition_conflict");
    }
    return decision;
  }

  private findIntent(input: {
    readonly repository: ActionRepositoryContext;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }) {
    return this.dependencies.requestedIntentQueries.findByRepositorySourceRunIdentity(
      {
        repositoryConnectionId: input.repository.repositoryId,
        sourceRunId: input.sourceRunId,
        sourceRunAttempt: input.sourceRunAttempt,
      },
    );
  }

  private async findIntentWithBoundedWait(
    input: Parameters<HostedReviewPreleaseGatePort["evaluate"]>[0],
  ) {
    const attempts = input.intentRequired
      ? ProductionHostedReviewPreleaseGate.intentBindingPollAttempts
      : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const intent = await this.findIntent(input);
      if (intent || attempt === attempts) return intent;
      await (
        this.dependencies.sleep ??
        ((delayMs: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
      )(ProductionHostedReviewPreleaseGate.intentBindingPollIntervalMs);
    }
    return null;
  }

  private async restorePersistedDecision(
    input: Parameters<HostedReviewPreleaseGatePort["evaluate"]>[0],
    intent: ReviewRequestedIntent,
  ) {
    if (intent.admission.state === ReviewRequestAdmissionState.NotEvaluated) {
      return null;
    }
    if (intent.admission.state === ReviewRequestAdmissionState.Rejected) {
      return decisionFromValidatedIntent(intent);
    }
    const transition =
      await this.dependencies.requestedIntentCommands.recordAdmissionDecision({
        requestId: intent.requestId,
        expectedVersion: intent.version,
        changedLines: intent.admission.changedLines,
        maxChangedLines: intent.admission.maxChangedLines,
        policySnapshotId: intent.admission.policySnapshotId,
        decisionHash: intent.admission.decisionHash,
        verdict: ReviewRequestAdmissionState.Admitted,
        now: this.dependencies.clock.now(),
      });
    if (
      (transition.status !== ReviewRequestedTransitionStatus.Applied &&
        transition.status !== ReviewRequestedTransitionStatus.Restored) ||
      transition.intent === undefined
    ) {
      throw new Error("review_request_admission_transition_conflict");
    }
    const decision = decisionFromValidatedIntent(transition.intent);
    if (
      decision === null ||
      decision.decisionHash !== intent.admission.decisionHash
    ) {
      throw new Error("review_request_admission_transition_conflict");
    }
    return decision;
  }
}

function decisionFromValidatedIntent(intent: ReviewRequestedIntent) {
  const admission = intent.admission;
  if (admission.state === ReviewRequestAdmissionState.NotEvaluated) return null;
  if (admission.state === ReviewRequestAdmissionState.Admitted) {
    if (
      intent.state !== ReviewRequestedIntentState.AwaitingAuthorization ||
      intent.authorizationId !== null ||
      intent.executionId !== null
    ) {
      throw new Error("review_request_admission_persisted_state_invalid");
    }
    return {
      status: "admitted" as const,
      decisionHash: admission.decisionHash,
    };
  }
  if (
    intent.state !== ReviewRequestedIntentState.Terminal ||
    admission.changedLines <= admission.maxChangedLines
  ) {
    throw new Error("review_request_admission_persisted_state_invalid");
  }
  return {
    status: "skipped" as const,
    reason: "max_changed_lines_exceeded" as const,
    changedLines: admission.changedLines,
    maxChangedLines: admission.maxChangedLines,
    decisionHash: admission.decisionHash,
  };
}

function admissionDecisionHash(input: {
  readonly intent: ReviewRequestedIntent;
  readonly changedLines: number;
  readonly maxChangedLines: number;
  readonly policySnapshotId: string;
  readonly verdict:
    | ReviewRequestAdmissionState.Admitted
    | ReviewRequestAdmissionState.Rejected;
}): string {
  return digest(
    JSON.stringify({
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
      policySnapshotId: input.policySnapshotId,
      pullRequestNumber: input.intent.pullRequestNumber,
      repositoryConnectionId: input.intent.repositoryConnectionId,
      requestId: input.intent.requestId,
      reviewRevisionHash: input.intent.revision.reviewRevisionHash,
      scmRepositoryIdentityId: input.intent.scmRepositoryIdentityId,
      verdict: input.verdict,
      workspaceId: input.intent.workspaceId,
    }),
  );
}

function sumChangedLines(additions: number, deletions: number): number {
  if (
    !Number.isSafeInteger(additions) ||
    additions < 0 ||
    !Number.isSafeInteger(deletions) ||
    deletions < 0
  ) {
    throw new Error("hosted_review_changed_lines_invalid");
  }
  const changedLines = additions + deletions;
  if (!Number.isSafeInteger(changedLines)) {
    throw new Error("hosted_review_changed_lines_invalid");
  }
  return changedLines;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
