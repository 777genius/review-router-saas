import { config as loadDotenv } from "dotenv";
import {
  assertRateLimit,
  PrismaRateLimitStore,
  RateLimitExceededError,
} from "../../../packages/features/rate-limits/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";

loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}

const prisma = createPrismaClient({ databaseUrl });
const rateLimits = new PrismaRateLimitStore(prisma);
const key = `rate-limit-e2e:${Date.now()}`;
const rule = { key, limit: 2, windowMs: 60_000 };
let now = new Date("2026-05-03T12:00:30.000Z");
const clock = { now: () => now };

try {
  const first = await assertRateLimit(rule, { rateLimits, clock });
  const second = await assertRateLimit(rule, { rateLimits, clock });
  if (!first.allowed || first.remaining !== 1) {
    throw new Error(`unexpected first decision: ${JSON.stringify(first)}`);
  }
  if (!second.allowed || second.remaining !== 0) {
    throw new Error(`unexpected second decision: ${JSON.stringify(second)}`);
  }

  try {
    await assertRateLimit(rule, { rateLimits, clock });
    throw new Error("expected third decision to be rate limited");
  } catch (error) {
    if (!(error instanceof RateLimitExceededError)) {
      throw error;
    }
  }

  now = new Date("2026-05-03T12:01:00.000Z");
  const afterReset = await assertRateLimit(rule, { rateLimits, clock });
  if (!afterReset.allowed || afterReset.remaining !== 1) {
    throw new Error(`unexpected reset decision: ${JSON.stringify(afterReset)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        key,
        first,
        second,
        afterReset,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.rateLimitBucket.deleteMany({ where: { key } });
  await prisma.$disconnect();
}
