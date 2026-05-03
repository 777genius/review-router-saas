import { config as loadDotenv } from "dotenv";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { PostgresLeaseLock } from "../../../packages/platform/locks/src/index.ts";

loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}

const prisma = createPrismaClient({ databaseUrl });
const lock = new PostgresLeaseLock(prisma);
const key = `distributed-lock-e2e:${Date.now()}`;
const expiredKey = `${key}:expired`;

try {
  let releaseFirst!: () => void;
  let firstEntered = false;
  const first = lock.withLock(
    key,
    10_000,
    () =>
      new Promise<void>((resolve) => {
        firstEntered = true;
        releaseFirst = resolve;
      }),
  );

  await waitUntil(() => firstEntered, "first lock did not start");

  let contentionFailed = false;
  try {
    await lock.withLock(key, 10_000, async () => undefined);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("distributed_lock_not_acquired:")
    ) {
      contentionFailed = true;
    } else {
      throw error;
    }
  }
  if (!contentionFailed) {
    throw new Error("expected active lease contention to fail");
  }

  releaseFirst();
  await first;

  let reacquired = false;
  await lock.withLock(key, 10_000, async () => {
    reacquired = true;
  });
  if (!reacquired) {
    throw new Error("expected released lease to be reacquired");
  }

  const now = new Date();
  await prisma.$executeRaw`
    INSERT INTO "DistributedLock" (
      "key",
      "owner",
      "expiresAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${expiredKey},
      'stale-owner',
      ${new Date(now.getTime() - 1_000)},
      ${now},
      ${now}
    )
  `;

  let expiredReclaimed = false;
  await lock.withLock(expiredKey, 10_000, async () => {
    expiredReclaimed = true;
  });
  if (!expiredReclaimed) {
    throw new Error("expected expired lease to be reclaimed");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        key,
        contentionFailed,
        reacquired,
        expiredReclaimed,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$executeRaw`
    DELETE FROM "DistributedLock"
    WHERE "key" IN (${key}, ${expiredKey})
  `;
  await prisma.$disconnect();
}

async function waitUntil(
  condition: () => boolean,
  errorMessage: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error(errorMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
