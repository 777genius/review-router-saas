import {
  reviewRevisionsEqual,
  type ReviewRevision,
} from "../../domain/review-execution";
import {
  ReviewRequestAdmissionState,
  type ReviewRequestedIntent,
} from "../../domain/review-requested-intent";
import {
  parseReviewRequestedSourceRunAttempt,
  type ReviewRequestedRerunIntentCandidate,
} from "../../domain/review-requested-rerun";
import type { Sha256DigestPort } from "../ports/review-execution-ports";
import {
  ReviewRequestedRerunEnsureStatus,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";

export type ReviewRequestedRerunPolicy = Readonly<{
  authorizationResolutionDelayMs: number;
  authorizationResolutionTimeoutMs: number;
  retentionMs: number;
}>;

export const defaultReviewRequestedRerunPolicy: ReviewRequestedRerunPolicy =
  Object.freeze({
    authorizationResolutionDelayMs: 30_000,
    authorizationResolutionTimeoutMs: 300_000,
    retentionMs: 2_592_000_000,
  });

export type EnsureReviewRequestedRerunIntentInput = Readonly<{
  repositoryConnectionId: string;
  sourceRunId: string;
  sourceRunAttempt: string;
  currentRevision: ReviewRevision;
  changedLines: number;
  maxChangedLines: number;
  policySnapshotId: string;
  now: Date;
}>;

export class EnsureReviewRequestedRerunIntent {
  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
    private readonly digest: Sha256DigestPort,
    private readonly policy: ReviewRequestedRerunPolicy = defaultReviewRequestedRerunPolicy,
  ) {
    validatePolicy(policy);
  }

  async execute(input: EnsureReviewRequestedRerunIntentInput) {
    const currentAttempt = parseReviewRequestedSourceRunAttempt(
      input.sourceRunAttempt,
    );
    if (currentAttempt <= 1) {
      return { status: ReviewRequestedRerunEnsureStatus.Conflict } as const;
    }
    const intents = await this.queries.listByRepositorySourceRunId({
      repositoryConnectionId: input.repositoryConnectionId,
      sourceRunId: input.sourceRunId,
    });
    const ordered = orderAndValidateAttempts(intents, currentAttempt);
    const exact = ordered.find(
      ({ attempt }) => attempt === currentAttempt,
    )?.intent;
    const predecessor = exact
      ? intents.find(
          (intent) => intent.requestId === exact.rerunPredecessorRequestId,
        )
      : ordered.filter(({ attempt }) => attempt < currentAttempt).at(-1)
          ?.intent;
    if (!predecessor) {
      return {
        status: ReviewRequestedRerunEnsureStatus.MissingPredecessor,
      } as const;
    }
    if (
      predecessor.repositoryConnectionId !== input.repositoryConnectionId ||
      predecessor.sourceRunId !== input.sourceRunId ||
      !reviewRevisionsEqual(predecessor.revision, input.currentRevision)
    ) {
      return { status: ReviewRequestedRerunEnsureStatus.Conflict } as const;
    }

    const candidate = await this.buildCandidate(input, predecessor);
    return this.commands.ensureRerunIntent({ candidate });
  }

  private async buildCandidate(
    input: EnsureReviewRequestedRerunIntentInput,
    predecessor: ReviewRequestedIntent,
  ): Promise<ReviewRequestedRerunIntentCandidate> {
    const deliveryIdentityHash = await this.digest.digestUtf8(
      [
        "rr.review-request-rerun-delivery.v1",
        input.repositoryConnectionId,
        input.sourceRunId,
        input.sourceRunAttempt,
      ].join("\0"),
    );
    const requestId = `review-request-rerun-${deliveryIdentityHash}`;
    const verdict =
      input.changedLines > input.maxChangedLines
        ? ReviewRequestAdmissionState.Rejected
        : ReviewRequestAdmissionState.Admitted;
    const canonicalRequestHash = await this.digest.digestUtf8(
      [
        "rr.review-request-rerun-canonical.v1",
        predecessor.canonicalRequestHash,
        predecessor.requestId,
        requestId,
        input.currentRevision.reviewRevisionHash,
        String(input.changedLines),
        String(input.maxChangedLines),
        input.policySnapshotId,
        verdict,
      ].join("\0"),
    );
    const admissionDecisionHash = await this.digest.digestUtf8(
      [
        "rr.review-request-rerun-admission.v1",
        predecessor.workspaceId,
        predecessor.repositoryConnectionId,
        predecessor.scmRepositoryIdentityId,
        String(predecessor.pullRequestNumber),
        requestId,
        input.currentRevision.reviewRevisionHash,
        String(input.changedLines),
        String(input.maxChangedLines),
        input.policySnapshotId,
        verdict,
      ].join("\0"),
    );
    return {
      workspaceId: predecessor.workspaceId,
      repositoryConnectionId: predecessor.repositoryConnectionId,
      scmRepositoryIdentityId: predecessor.scmRepositoryIdentityId,
      pullRequestNumber: predecessor.pullRequestNumber,
      predecessorRequestId: predecessor.requestId,
      requestId,
      revision: input.currentRevision,
      triggerKind: predecessor.triggerKind,
      deliveryIdentityHash,
      canonicalRequestHash,
      sourceRunId: input.sourceRunId,
      sourceRunAttempt: input.sourceRunAttempt,
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
      policySnapshotId: input.policySnapshotId,
      admissionDecisionHash,
      verdict,
      createdAt: new Date(input.now),
      nextResolutionAt: new Date(
        input.now.getTime() + this.policy.authorizationResolutionDelayMs,
      ),
      resolutionDeadlineAt: new Date(
        input.now.getTime() + this.policy.authorizationResolutionTimeoutMs,
      ),
      retainUntil: new Date(input.now.getTime() + this.policy.retentionMs),
    };
  }
}

function orderAndValidateAttempts(
  intents: readonly ReviewRequestedIntent[],
  currentAttempt: number,
) {
  const seen = new Set<number>();
  const ordered = intents.map((intent) => {
    if (intent.sourceRunAttempt === null) {
      throw new Error("review_requested_rerun_source_index_corrupted");
    }
    const attempt = parseReviewRequestedSourceRunAttempt(
      intent.sourceRunAttempt,
    );
    if (seen.has(attempt)) {
      throw new Error("review_requested_rerun_source_identity_corrupted");
    }
    if (attempt > currentAttempt) {
      throw new Error("review_requested_rerun_future_attempt_conflict");
    }
    seen.add(attempt);
    return { attempt, intent };
  });
  return ordered.sort(
    (left, right) =>
      left.attempt - right.attempt ||
      left.intent.requestId.localeCompare(right.intent.requestId),
  );
}

function validatePolicy(policy: ReviewRequestedRerunPolicy): void {
  for (const value of [
    policy.authorizationResolutionDelayMs,
    policy.authorizationResolutionTimeoutMs,
    policy.retentionMs,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("review_requested_rerun_policy_invalid");
    }
  }
  if (
    policy.authorizationResolutionDelayMs >
      policy.authorizationResolutionTimeoutMs ||
    policy.authorizationResolutionTimeoutMs < 30_000 ||
    policy.retentionMs < 86_400_000
  ) {
    throw new Error("review_requested_rerun_policy_invalid");
  }
}
