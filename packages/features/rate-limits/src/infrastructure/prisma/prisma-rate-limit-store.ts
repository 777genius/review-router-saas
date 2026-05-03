import type { PrismaClient } from "@prisma/client";
import { createRateLimitDecision } from "../../domain/rate-limit";
import type {
  ConsumeFixedWindowRateLimitInput,
  RateLimitStorePort,
} from "../../application/ports/rate-limit-store-port";

type RateLimitRow = {
  readonly count: number;
  readonly limit: number;
  readonly windowEndsAt: Date;
};

export class PrismaRateLimitStore implements RateLimitStorePort {
  constructor(private readonly prisma: PrismaClient) {}

  async consumeFixedWindow(
    input: ConsumeFixedWindowRateLimitInput,
  ): Promise<ReturnType<typeof createRateLimitDecision>> {
    const rows = await this.prisma.$queryRaw<RateLimitRow[]>`
      INSERT INTO "RateLimitBucket" (
        "key",
        "count",
        "limit",
        "windowStart",
        "windowEndsAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${input.key},
        1,
        ${input.limit},
        ${input.windowStart},
        ${input.windowEndsAt},
        ${input.now},
        ${input.now}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitBucket"."windowEndsAt" <= ${input.now} THEN 1
          ELSE "RateLimitBucket"."count" + 1
        END,
        "limit" = ${input.limit},
        "windowStart" = CASE
          WHEN "RateLimitBucket"."windowEndsAt" <= ${input.now} THEN ${input.windowStart}
          ELSE "RateLimitBucket"."windowStart"
        END,
        "windowEndsAt" = CASE
          WHEN "RateLimitBucket"."windowEndsAt" <= ${input.now} THEN ${input.windowEndsAt}
          ELSE "RateLimitBucket"."windowEndsAt"
        END,
        "updatedAt" = ${input.now}
      RETURNING "count", "limit", "windowEndsAt"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("rate_limit_store_failed");
    }
    return createRateLimitDecision({
      key: input.key,
      limit: row.limit,
      count: row.count,
      resetAt: row.windowEndsAt,
    });
  }
}
