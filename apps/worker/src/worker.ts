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
import {
  runOutboxWorkerLoop,
  safeWorkerErrorSummary,
  sleep,
} from "./outbox-worker-loop";

loadDotenv({ path: "../../.env.local", override: false });
loadDotenv({ path: "../../.env", override: false });
loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const logger = new ConsoleLogger();

async function main(): Promise<void> {
  logger.info("ReviewRouter worker booted", {
    mode: process.env.NODE_ENV ?? "development",
  });

  const prisma = createPrismaClient();
  try {
    const clock = new SystemClock();
    const handlers = createOutboxHandlers(prisma, clock);
    if (handlers.length === 0) {
      logger.warn(
        "ReviewRouter worker has no outbox handlers; exiting without claiming events",
      );
      return;
    }

    const outbox = new PrismaOutboxEventRepository(prisma);
    const limit = readPositiveIntegerEnv("REVIEW_ROUTER_OUTBOX_BATCH_SIZE", 25);
    const processBatch = () =>
      processOutboxBatch(
        { limit, handlers },
        {
          outbox,
          clock,
        },
      );

    if (process.env.REVIEW_ROUTER_WORKER_ONCE === "1") {
      const result = await processBatch();
      logger.info("ReviewRouter worker processed one outbox batch", result);
      return;
    }

    const summary = await runOutboxWorkerLoop(
      {
        signal: createShutdownSignal(),
        idleDelayMs: readPositiveIntegerEnv(
          "REVIEW_ROUTER_WORKER_IDLE_MS",
          5000,
        ),
        busyDelayMs: readPositiveIntegerEnv(
          "REVIEW_ROUTER_WORKER_BUSY_MS",
          250,
        ),
        errorDelayMs: readPositiveIntegerEnv(
          "REVIEW_ROUTER_WORKER_ERROR_MS",
          5000,
        ),
      },
      {
        processor: { processBatch },
        logger,
        sleep,
      },
    );
    logger.info("ReviewRouter worker stopped", summary);
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
    logger.warn("GitHub App credentials missing; installation sync disabled");
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

function createShutdownSignal(): AbortSignal {
  const controller = new AbortController();
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("ReviewRouter worker shutdown requested", { signal });
    controller.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return controller.signal;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

await main().catch((error: unknown) => {
  logger.error("ReviewRouter worker failed", {
    safeErrorSummary: safeWorkerErrorSummary(error),
  });
  process.exitCode = 1;
});
