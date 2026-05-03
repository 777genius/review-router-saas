import type { Clock } from "@reviewrouter/shared";
import {
  createFixedWindow,
  normalizeRateLimitRule,
  RateLimitExceededError,
  type RateLimitDecision,
  type RateLimitRule,
} from "../../domain/rate-limit";
import type { RateLimitStorePort } from "../ports/rate-limit-store-port";

export async function assertRateLimit(
  rule: RateLimitRule,
  dependencies: {
    readonly rateLimits: RateLimitStorePort;
    readonly clock: Clock;
  },
): Promise<RateLimitDecision> {
  const normalized = normalizeRateLimitRule(rule);
  const now = dependencies.clock.now();
  const window = createFixedWindow({
    now,
    windowMs: normalized.windowMs,
  });
  const decision = await dependencies.rateLimits.consumeFixedWindow({
    key: normalized.key,
    limit: normalized.limit,
    windowStart: window.windowStart,
    windowEndsAt: window.windowEndsAt,
    now,
  });
  if (!decision.allowed) {
    throw new RateLimitExceededError(decision);
  }
  return decision;
}
