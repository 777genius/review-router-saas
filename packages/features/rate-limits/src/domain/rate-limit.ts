export type RateLimitRule = {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
};

export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly key: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
};

export class RateLimitExceededError extends Error {
  constructor(readonly decision: RateLimitDecision) {
    super(`rate_limit_exceeded:${decision.key}`);
    this.name = "RateLimitExceededError";
  }
}

export function normalizeRateLimitRule(rule: RateLimitRule): RateLimitRule {
  const key = rule.key.trim();
  if (!key) {
    throw new Error("rate_limit_key_required");
  }
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new Error("rate_limit_limit_invalid");
  }
  if (!Number.isInteger(rule.windowMs) || rule.windowMs <= 0) {
    throw new Error("rate_limit_window_invalid");
  }
  return { key, limit: rule.limit, windowMs: rule.windowMs };
}

export function createFixedWindow(input: {
  readonly now: Date;
  readonly windowMs: number;
}): { readonly windowStart: Date; readonly windowEndsAt: Date } {
  const windowStartMs =
    Math.floor(input.now.getTime() / input.windowMs) * input.windowMs;
  const windowStart = new Date(windowStartMs);
  return {
    windowStart,
    windowEndsAt: new Date(windowStartMs + input.windowMs),
  };
}

export function createRateLimitDecision(input: {
  readonly key: string;
  readonly limit: number;
  readonly count: number;
  readonly resetAt: Date;
}): RateLimitDecision {
  const allowed = input.count <= input.limit;
  return {
    allowed,
    key: input.key,
    limit: input.limit,
    remaining: Math.max(input.limit - input.count, 0),
    resetAt: input.resetAt,
  };
}
