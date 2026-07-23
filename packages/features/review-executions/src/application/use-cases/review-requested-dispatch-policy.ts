import type { ReviewRequestedIntentCandidate } from "../../domain/review-requested-intent";
import type { ReviewRequestedIntent } from "../../domain/review-requested-intent";

export type ReviewRequestedDispatchPolicy = Readonly<{
  claimDurationMs: number;
  dispatchResolutionDelayMs: number;
  dispatchResolutionTimeoutMs: number;
  authorizationResolutionDelayMs: number;
  authorizationResolutionTimeoutMs: number;
  retryDelayMs: number;
  retentionMs: number;
  maxDispatchAttempts: number;
}>;

export type ReviewRequestedRetryDependencies = Readonly<{
  ids: { nextRequestId(): string };
  digest: { digestUtf8(value: string): Promise<string> };
}>;

export const defaultReviewRequestedDispatchPolicy: ReviewRequestedDispatchPolicy =
  Object.freeze({
    claimDurationMs: 60_000,
    dispatchResolutionDelayMs: 30_000,
    dispatchResolutionTimeoutMs: 300_000,
    authorizationResolutionDelayMs: 30_000,
    authorizationResolutionTimeoutMs: 300_000,
    retryDelayMs: 30_000,
    retentionMs: 2_592_000_000,
    maxDispatchAttempts: 3,
  });

export function validateReviewRequestedDispatchPolicy(
  policy: ReviewRequestedDispatchPolicy,
): void {
  assertDuration(
    policy.claimDurationMs,
    "review_requested_claim_duration_invalid",
  );
  assertDuration(
    policy.dispatchResolutionDelayMs,
    "review_requested_dispatch_resolution_delay_invalid",
  );
  assertDuration(
    policy.dispatchResolutionTimeoutMs,
    "review_requested_dispatch_resolution_timeout_invalid",
  );
  assertDuration(
    policy.authorizationResolutionDelayMs,
    "review_requested_authorization_resolution_delay_invalid",
  );
  assertDuration(
    policy.authorizationResolutionTimeoutMs,
    "review_requested_authorization_resolution_timeout_invalid",
  );
  assertDuration(
    policy.retryDelayMs,
    "review_requested_recovery_delay_invalid",
  );
  if (
    policy.dispatchResolutionDelayMs > policy.dispatchResolutionTimeoutMs ||
    policy.authorizationResolutionDelayMs >
      policy.authorizationResolutionTimeoutMs
  ) {
    throw new Error("review_requested_resolution_policy_invalid");
  }
  if (
    !Number.isSafeInteger(policy.retentionMs) ||
    policy.retentionMs < 86_400_000
  ) {
    throw new Error("review_requested_recovery_retention_invalid");
  }
  if (
    !Number.isSafeInteger(policy.maxDispatchAttempts) ||
    policy.maxDispatchAttempts <= 0 ||
    policy.maxDispatchAttempts > 10
  ) {
    throw new Error("review_requested_recovery_attempt_budget_invalid");
  }
}

export async function buildReviewRequestedRetryCandidate(input: {
  readonly intent: ReviewRequestedIntent;
  readonly now: Date;
  readonly identitySeed: string;
  readonly dependencies: ReviewRequestedRetryDependencies;
  readonly policy: ReviewRequestedDispatchPolicy;
}): Promise<ReviewRequestedIntentCandidate | null> {
  if (input.intent.dispatchAttempt >= input.policy.maxDispatchAttempts) {
    return null;
  }
  const deliveryIdentityHash = await input.dependencies.digest.digestUtf8(
    `rr.review-request-recovery-delivery.v2\0${input.intent.requestId}\0${input.identitySeed}`,
  );
  const canonicalRequestHash = await input.dependencies.digest.digestUtf8(
    `rr.review-request-recovery-canonical.v2\0${input.intent.canonicalRequestHash}\0${deliveryIdentityHash}`,
  );
  return {
    workspaceId: input.intent.workspaceId,
    repositoryConnectionId: input.intent.repositoryConnectionId,
    scmRepositoryIdentityId: input.intent.scmRepositoryIdentityId,
    pullRequestNumber: input.intent.pullRequestNumber,
    requestId: input.dependencies.ids.nextRequestId(),
    dispatchAttempt: input.intent.dispatchAttempt + 1,
    revision: input.intent.revision,
    triggerKind: input.intent.triggerKind,
    deliveryIdentityHash,
    canonicalRequestHash,
    notBefore: new Date(input.now.getTime() + input.policy.retryDelayMs),
    createdAt: new Date(input.now),
    retainUntil: new Date(input.now.getTime() + input.policy.retentionMs),
  };
}

function assertDuration(value: number, error: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error(error);
  }
}
