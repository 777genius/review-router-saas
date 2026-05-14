import { config as loadDotenv } from "dotenv";
import { App } from "@octokit/app";
import {
  PrismaActionOidcReplayNonceStore,
  pruneExpiredActionOidcReplayNonces,
} from "@reviewrouter/features-action-control-plane";
import {
  OctokitConflictReviewGitHubGateway,
  PrismaConflictReviewRepository,
} from "@reviewrouter/features-conflict-review";
import { createConflictReviewDetectionRequestedHandler } from "@reviewrouter/features-conflict-review/outbox";
import { PrismaAuditLogRepository } from "@reviewrouter/features-audit-log";
import {
  OctokitOrgRulesetSetupGateway,
  PrismaOrgRulesetProvisioningRepository,
} from "@reviewrouter/features-org-ruleset-provisioning";
import { createOrgRulesetProvisioningRequestedHandler } from "@reviewrouter/features-org-ruleset-provisioning/outbox";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  PrismaRateLimitStore,
  pruneExpiredRateLimitBuckets,
} from "@reviewrouter/features-rate-limits";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
} from "@reviewrouter/features-repositories";
import { createInstallationSyncRequestedHandler } from "@reviewrouter/features-repositories/outbox";
import { createPrismaClient } from "@reviewrouter/platform-db";
import {
  isConflictReviewFallbackAllowedForRepository,
  isConflictReviewFallbackEnabled,
  readGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
} from "@reviewrouter/platform-config";
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
    const pruneRateLimits = createRateLimitMaintenance(prisma, clock);
    const pruneActionOidcReplayNonces = createActionOidcReplayNonceMaintenance(
      prisma,
      clock,
    );
    const limit = readPositiveIntegerEnv("REVIEW_ROUTER_OUTBOX_BATCH_SIZE", 25);
    const processingStaleAfterMs = readPositiveIntegerEnv(
      "REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS",
      15 * 60 * 1000,
    );
    const processBatch = async () => {
      const result = await processOutboxBatch(
        { limit, handlers, processingStaleAfterMs },
        {
          outbox,
          clock,
        },
      );
      await pruneRateLimits();
      await pruneActionOidcReplayNonces();
      return result;
    };

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
  const privateKey = readGitHubAppPrivateKey();
  if (!appId || !privateKey) {
    logger.warn("GitHub App credentials missing; installation sync disabled");
    return [];
  }

  const handlers: OutboxHandler[] = [
    createInstallationSyncRequestedHandler({
      github: new OctokitGitHubRepositorySource({
        appId,
        privateKey,
      }),
      repositories: new PrismaRepositoryConnectionRepository(prisma),
      clock,
      syncPolicy: {
        maxRepositories: readPositiveIntegerEnv(
          "REVIEW_ROUTER_MAX_REPOSITORIES_PER_SYNC",
          250,
        ),
      },
    }),
    createOrgRulesetProvisioningRequestedHandler({
      provisioning: new PrismaOrgRulesetProvisioningRepository(prisma),
      createSetupGateway: createOrgRulesetSetupGatewayFactory({
        appId,
        privateKey,
      }),
      auditLog: new PrismaAuditLogRepository(prisma),
      clock,
      actionRef: resolveReviewRouterActionRef(),
      apiUrl: resolveWorkflowPublicApiUrl(),
      runtimeConfigMode: "oidc",
    }),
  ];
  if (isConflictReviewFallbackEnabled()) {
    const conflictReviewRolloutPolicy = {
      isConflictReviewFallbackAllowed(input: {
        readonly repositoryFullName: string;
      }) {
        return isConflictReviewFallbackAllowedForRepository(
          input.repositoryFullName,
        );
      },
    };
    handlers.push(
      createConflictReviewDetectionRequestedHandler({
        repositories: new PrismaConflictReviewRepository(prisma),
        github: new OctokitConflictReviewGitHubGateway({
          appId,
          privateKey,
        }),
        rolloutPolicy: conflictReviewRolloutPolicy,
        clock,
        logger,
      }),
    );
  }
  return handlers;
}

function createOrgRulesetSetupGatewayFactory(input: {
  readonly appId: string;
  readonly privateKey: string;
}): (githubInstallationId: string) => Promise<OctokitOrgRulesetSetupGateway> {
  const app = new App({
    appId: input.appId,
    privateKey: input.privateKey,
  });
  return async (githubInstallationId) =>
    new OctokitOrgRulesetSetupGateway(
      await app.getInstallationOctokit(Number(githubInstallationId)),
    );
}

function resolveWorkflowPublicApiUrl(): string {
  const raw =
    process.env.REVIEW_ROUTER_PUBLIC_API_URL ||
    process.env.REVIEW_ROUTER_API_URL ||
    "http://localhost:4000";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("invalid_workflow_api_url");
  }
  return url.toString().replace(/\/$/, "");
}

function createRateLimitMaintenance(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  const rateLimits = new PrismaRateLimitStore(prisma);
  const limit = readPositiveIntegerEnv(
    "REVIEW_ROUTER_RATE_LIMIT_PRUNE_BATCH_SIZE",
    500,
  );
  const intervalMs = readPositiveIntegerEnv(
    "REVIEW_ROUTER_RATE_LIMIT_PRUNE_INTERVAL_MS",
    5 * 60 * 1000,
  );
  let lastAttemptAtMs = 0;

  return async () => {
    const now = clock.now();
    if (now.getTime() - lastAttemptAtMs < intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      const result = await pruneExpiredRateLimitBuckets(
        { expiredBefore: now, limit },
        { rateLimits },
      );
      if (result.deleted > 0) {
        logger.info("ReviewRouter pruned expired rate limit buckets", result);
      }
    } catch (error: unknown) {
      logger.warn("ReviewRouter rate limit maintenance failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
    }
  };
}

function createActionOidcReplayNonceMaintenance(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  const replayNonces = new PrismaActionOidcReplayNonceStore(prisma);
  const limit = readPositiveIntegerEnv(
    "REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_BATCH_SIZE",
    500,
  );
  const intervalMs = readPositiveIntegerEnv(
    "REVIEW_ROUTER_ACTION_OIDC_REPLAY_NONCE_PRUNE_INTERVAL_MS",
    5 * 60 * 1000,
  );
  let lastAttemptAtMs = 0;

  return async () => {
    const now = clock.now();
    if (now.getTime() - lastAttemptAtMs < intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      const result = await pruneExpiredActionOidcReplayNonces(
        { expiredBefore: now, limit },
        { replayNonces },
      );
      if (result.deleted > 0) {
        logger.info("ReviewRouter pruned expired action OIDC replay nonces", {
          deleted: result.deleted,
        });
      }
    } catch (error: unknown) {
      logger.warn("ReviewRouter action OIDC replay nonce maintenance failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
    }
  };
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
