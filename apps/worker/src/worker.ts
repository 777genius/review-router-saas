import { config as loadDotenv } from "dotenv";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
} from "@reviewrouter/features-outbox";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";

loadDotenv({ path: "../../.env.local", override: false });
loadDotenv({ path: "../../.env", override: false });
loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const logger = new ConsoleLogger();
logger.info("ReviewRouter worker booted", {
  mode: process.env.NODE_ENV ?? "development",
});

if (process.env.REVIEW_ROUTER_WORKER_ONCE === "1") {
  const prisma = createPrismaClient();
  try {
    const result = await processOutboxBatch(
      {
        limit: Number(process.env.REVIEW_ROUTER_OUTBOX_BATCH_SIZE ?? 25),
        handlers: [],
      },
      {
        outbox: new PrismaOutboxEventRepository(prisma),
        clock: new SystemClock(),
      },
    );
    logger.info("ReviewRouter worker processed one outbox batch", result);
  } finally {
    await prisma.$disconnect();
  }
}
