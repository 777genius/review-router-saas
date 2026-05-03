import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
} from "@reviewrouter/features-repositories";
import { createInstallationSyncRequestedHandler } from "@reviewrouter/features-repositories/outbox";
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
    const clock = new SystemClock();
    const result = await processOutboxBatch(
      {
        limit: Number(process.env.REVIEW_ROUTER_OUTBOX_BATCH_SIZE ?? 25),
        handlers: createOutboxHandlers(prisma, clock),
      },
      {
        outbox: new PrismaOutboxEventRepository(prisma),
        clock,
      },
    );
    logger.info("ReviewRouter worker processed one outbox batch", result);
  } finally {
    await prisma.$disconnect();
  }
}

function createOutboxHandlers(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): readonly OutboxHandler[] {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (!appId || !privateKeyFile) {
    logger.info("GitHub App credentials missing; installation sync disabled");
    return [];
  }

  return [
    createInstallationSyncRequestedHandler({
      github: new OctokitGitHubRepositorySource({
        appId,
        privateKey: readFileSync(privateKeyFile, "utf8"),
      }),
      repositories: new PrismaRepositoryConnectionRepository(prisma),
      clock,
    }),
  ];
}
