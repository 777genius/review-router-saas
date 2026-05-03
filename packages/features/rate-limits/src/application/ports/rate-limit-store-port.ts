import type { RateLimitDecision } from "../../domain/rate-limit";

export type ConsumeFixedWindowRateLimitInput = {
  readonly key: string;
  readonly limit: number;
  readonly windowStart: Date;
  readonly windowEndsAt: Date;
  readonly now: Date;
};

export type DeleteExpiredRateLimitBucketsInput = {
  readonly expiredBefore: Date;
  readonly limit: number;
};

export type DeleteExpiredRateLimitBucketsResult = {
  readonly deleted: number;
};

export interface RateLimitStorePort {
  consumeFixedWindow(
    input: ConsumeFixedWindowRateLimitInput,
  ): Promise<RateLimitDecision>;
}

export interface RateLimitCleanupStorePort {
  deleteExpiredBuckets(
    input: DeleteExpiredRateLimitBucketsInput,
  ): Promise<DeleteExpiredRateLimitBucketsResult>;
}
