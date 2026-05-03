import type {
  DeleteExpiredRateLimitBucketsResult,
  RateLimitCleanupStorePort,
} from "../ports/rate-limit-store-port";

export type PruneExpiredRateLimitBucketsInput = {
  readonly expiredBefore: Date;
  readonly limit: number;
};

export async function pruneExpiredRateLimitBuckets(
  input: PruneExpiredRateLimitBucketsInput,
  dependencies: {
    readonly rateLimits: RateLimitCleanupStorePort;
  },
): Promise<DeleteExpiredRateLimitBucketsResult> {
  if (Number.isNaN(input.expiredBefore.getTime())) {
    throw new Error("rate_limit_prune_expired_before_invalid");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("rate_limit_prune_limit_invalid");
  }
  return dependencies.rateLimits.deleteExpiredBuckets(input);
}
