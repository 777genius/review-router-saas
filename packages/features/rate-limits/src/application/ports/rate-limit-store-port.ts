import type { RateLimitDecision } from "../../domain/rate-limit";

export type ConsumeFixedWindowRateLimitInput = {
  readonly key: string;
  readonly limit: number;
  readonly windowStart: Date;
  readonly windowEndsAt: Date;
  readonly now: Date;
};

export interface RateLimitStorePort {
  consumeFixedWindow(
    input: ConsumeFixedWindowRateLimitInput,
  ): Promise<RateLimitDecision>;
}
