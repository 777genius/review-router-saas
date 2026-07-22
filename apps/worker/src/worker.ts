import { createHash, randomUUID } from "node:crypto";
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
import { createMemoryOutboxHandlers } from "@reviewrouter/features-memory/outbox";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
  type ProcessOutboxBatchResult,
  type OutboxHandler,
  type OutboxHandlerDefinition,
} from "@reviewrouter/features-outbox";
import {
  PrismaMemoryItemRepository,
  PrismaMemorySuggestionRepository,
  PrismaMemoryUsageEventRepository,
  PrismaMemorySearchIndex,
  PrismaMemoryTransaction,
} from "@reviewrouter/features-memory";
import {
  PrismaRateLimitStore,
  pruneExpiredRateLimitBuckets,
} from "@reviewrouter/features-rate-limits";
import {
  PrismaReviewSnapshotRepository,
  pruneExpiredReviewSnapshots,
} from "@reviewrouter/features-review-snapshots";
import {
  PrismaReviewExecutionCheckpointRepository,
  pruneExpiredReviewExecutionCheckpoints,
} from "@reviewrouter/features-review-execution-checkpoints";
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
import { PostgresLeaseLock } from "@reviewrouter/platform-locks";
import { SystemClock } from "@reviewrouter/shared";
import {
  createMemoryItemExpiryMaintenance,
  createMemorySuggestionExpiryMaintenance,
  createMemoryTerminalItemPruneMaintenance,
  createMemoryUsageTelemetryMaintenance,
} from "./memory-maintenance";
import {
  runOutboxWorkerLoop,
  safeWorkerErrorSummary,
  sleep,
} from "./outbox-worker-loop";
import {
  createReviewV2WorkerFeature,
  reviewExecutionFinalizedEventType,
  reviewExecutionFinalizedEventVersion,
} from "./review-v2-worker-runtime";
import { createProductionReviewV2WorkerRuntime } from "./review-v2-production-runtime";

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
    const reviewV2Worker = createReviewV2WorkerFeature({
      env: process.env,
      createEnabledRuntime: () => {
        const githubAppId = process.env.GITHUB_APP_ID?.trim();
        const githubPrivateKey = readGitHubAppPrivateKey();
        if (!githubAppId || !githubPrivateKey) {
          throw new Error("review_v2_worker_github_app_credentials_missing");
        }
        return createProductionReviewV2WorkerRuntime({
          prisma,
          clock,
          env: process.env,
          githubAppId,
          githubPrivateKey,
        });
      },
    });
    const handlers = [
      ...createOutboxHandlers(prisma, clock),
      ...reviewV2Worker.handlers,
    ];
    if (handlers.length === 0) {
      logger.warn(
        "ReviewRouter worker has no outbox handlers; maintenance tasks still enabled",
      );
    }

    const outbox = new PrismaOutboxEventRepository(prisma);
    const pruneRateLimits = createRateLimitMaintenance(prisma, clock);
    const pruneActionOidcReplayNonces = createActionOidcReplayNonceMaintenance(
      prisma,
      clock,
    );
    const pruneReviewSnapshots = createReviewSnapshotMaintenance(prisma, clock);
    const pruneReviewExecutionCheckpoints =
      createReviewExecutionCheckpointMaintenance(prisma, clock);
    const expirePendingMemorySuggestions =
      createMemorySuggestionExpiryMaintenanceRunner(prisma, clock);
    const expireActiveMemoryItems = createMemoryItemExpiryMaintenanceRunner(
      prisma,
      clock,
    );
    const pruneTerminalMemoryItems =
      createMemoryTerminalItemPruneMaintenanceRunner(prisma, clock);
    const pruneMemoryUsageTelemetry =
      createMemoryUsageTelemetryMaintenanceRunner(prisma, clock);
    const limit = readPositiveIntegerEnv("REVIEW_ROUTER_OUTBOX_BATCH_SIZE", 25);
    const processingStaleAfterMs = readPositiveIntegerEnv(
      "REVIEW_ROUTER_OUTBOX_PROCESSING_STALE_MS",
      15 * 60 * 1000,
    );
    const heartbeatIntervalMs = readPositiveIntegerEnv(
      "REVIEW_ROUTER_OUTBOX_HEARTBEAT_MS",
      Math.max(1_000, Math.floor(processingStaleAfterMs / 3)),
    );
    const claimOwnerHash = createHash("sha256")
      .update(randomUUID())
      .digest("hex");
    const takeoverEnabled =
      process.env.REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED === "1";
    const processBatch = async () => {
      const result =
        handlers.length > 0
          ? await processOutboxBatch(
              {
                limit,
                handlers,
                knownHandlers: knownOutboxHandlers,
                claimOwnerHash,
                processingLeaseMs: processingStaleAfterMs,
                heartbeatIntervalMs,
                takeoverEnabled,
              },
              {
                outbox,
                clock,
              },
            )
          : emptyOutboxBatchResult();
      await pruneRateLimits();
      await pruneActionOidcReplayNonces();
      await pruneReviewSnapshots();
      await pruneReviewExecutionCheckpoints();
      await expirePendingMemorySuggestions();
      await expireActiveMemoryItems();
      await pruneTerminalMemoryItems();
      await pruneMemoryUsageTelemetry();
      await reviewV2Worker.runMaintenance();
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

const knownOutboxHandlers = [
  {
    type: reviewExecutionFinalizedEventType,
    version: reviewExecutionFinalizedEventVersion,
  },
  { type: "installation.sync_requested", version: 1 },
  { type: "org_ruleset.provision_requested", version: 1 },
  { type: "conflict_review.detection_requested", version: 1 },
  { type: "memory.item.created", version: 1 },
  { type: "memory.item.deleted", version: 1 },
  { type: "memory.item.disabled", version: 1 },
  { type: "memory.item.edited", version: 1 },
  { type: "memory.item.expired", version: 1 },
  { type: "memory.suggestion.created", version: 1 },
  { type: "memory.suggestion.confirmed", version: 1 },
  { type: "memory.suggestion.rejected", version: 1 },
  { type: "memory.embedding.reindex.requested", version: 1 },
  { type: "memory.embedding.delete.requested", version: 1 },
] as const satisfies readonly OutboxHandlerDefinition[];

function createOutboxHandlers(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): readonly OutboxHandler[] {
  const memoryHandlers = createMemoryOutboxHandlers({
    memoryItems: new PrismaMemoryItemRepository(prisma),
    searchIndex: new PrismaMemorySearchIndex(prisma),
  });
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = readGitHubAppPrivateKey();
  if (!appId || !privateKey) {
    logger.warn("GitHub App credentials missing; installation sync disabled");
    return memoryHandlers;
  }

  const handlers: OutboxHandler[] = [
    ...memoryHandlers,
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

function createReviewSnapshotMaintenance(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  const snapshots = new PrismaReviewSnapshotRepository(prisma);
  const limit = readPositiveIntegerEnv(
    "REVIEW_ROUTER_REVIEW_SNAPSHOT_PRUNE_BATCH_SIZE",
    500,
  );
  const intervalMs = readPositiveIntegerEnv(
    "REVIEW_ROUTER_REVIEW_SNAPSHOT_PRUNE_INTERVAL_MS",
    5 * 60 * 1000,
  );
  let lastAttemptAtMs = 0;

  return async () => {
    const now = clock.now();
    if (now.getTime() - lastAttemptAtMs < intervalMs) return;
    lastAttemptAtMs = now.getTime();

    try {
      const result = await pruneExpiredReviewSnapshots(
        { expiredBefore: now, limit },
        { snapshots },
      );
      if (result.deleted > 0) {
        logger.info("ReviewRouter pruned expired review snapshots", result);
      }
    } catch (error: unknown) {
      logger.warn("ReviewRouter review snapshot maintenance failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
    }
  };
}

function createReviewExecutionCheckpointMaintenance(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  const checkpoints = new PrismaReviewExecutionCheckpointRepository(prisma);
  const limit = readPositiveIntegerEnv(
    "REVIEW_ROUTER_REVIEW_EXECUTION_CHECKPOINT_PRUNE_BATCH_SIZE",
    500,
  );
  const intervalMs = readPositiveIntegerEnv(
    "REVIEW_ROUTER_REVIEW_EXECUTION_CHECKPOINT_PRUNE_INTERVAL_MS",
    5 * 60 * 1000,
  );
  let lastAttemptAtMs = 0;

  return async () => {
    const now = clock.now();
    if (now.getTime() - lastAttemptAtMs < intervalMs) return;
    lastAttemptAtMs = now.getTime();

    try {
      const result = await pruneExpiredReviewExecutionCheckpoints(
        { expiredBefore: now, limit },
        { checkpoints },
      );
      if (result.deleted > 0) {
        logger.info(
          "ReviewRouter pruned expired review execution checkpoints",
          result,
        );
      }
    } catch (error: unknown) {
      logger.warn(
        "ReviewRouter review execution checkpoint maintenance failed",
        { safeErrorSummary: safeWorkerErrorSummary(error) },
      );
    }
  };
}

function createMemoryUsageTelemetryMaintenanceRunner(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  return createMemoryUsageTelemetryMaintenance(
    {
      limit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_USAGE_EVENT_PRUNE_BATCH_SIZE",
        1000,
      ),
      retentionDays: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_USAGE_EVENT_RETENTION_DAYS",
        180,
      ),
      intervalMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_USAGE_EVENT_PRUNE_INTERVAL_MS",
        60 * 60 * 1000,
      ),
      lockTtlMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_USAGE_EVENT_PRUNE_LOCK_TTL_MS",
        5 * 60 * 1000,
      ),
    },
    {
      clock,
      usageEvents: new PrismaMemoryUsageEventRepository(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger,
    },
  );
}

function createMemorySuggestionExpiryMaintenanceRunner(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  return createMemorySuggestionExpiryMaintenance(
    {
      workspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_SUGGESTION_EXPIRE_WORKSPACE_BATCH_SIZE",
        50,
      ),
      perWorkspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_SUGGESTION_EXPIRE_PER_WORKSPACE_BATCH_SIZE",
        100,
      ),
      intervalMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_SUGGESTION_EXPIRE_INTERVAL_MS",
        15 * 60 * 1000,
      ),
      lockTtlMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_SUGGESTION_EXPIRE_LOCK_TTL_MS",
        5 * 60 * 1000,
      ),
    },
    {
      clock,
      memorySuggestions: new PrismaMemorySuggestionRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger,
    },
  );
}

function createMemoryItemExpiryMaintenanceRunner(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  return createMemoryItemExpiryMaintenance(
    {
      workspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_ITEM_EXPIRE_WORKSPACE_BATCH_SIZE",
        50,
      ),
      perWorkspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_ITEM_EXPIRE_PER_WORKSPACE_BATCH_SIZE",
        100,
      ),
      intervalMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_ITEM_EXPIRE_INTERVAL_MS",
        15 * 60 * 1000,
      ),
      lockTtlMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_ITEM_EXPIRE_LOCK_TTL_MS",
        5 * 60 * 1000,
      ),
    },
    {
      clock,
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger,
    },
  );
}

function createMemoryTerminalItemPruneMaintenanceRunner(
  prisma: ReturnType<typeof createPrismaClient>,
  clock: SystemClock,
): () => Promise<void> {
  return createMemoryTerminalItemPruneMaintenance(
    {
      retentionDays: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_TERMINAL_ITEM_PRUNE_RETENTION_DAYS",
        30,
      ),
      workspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_TERMINAL_ITEM_PRUNE_WORKSPACE_BATCH_SIZE",
        50,
      ),
      perWorkspaceLimit: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_TERMINAL_ITEM_PRUNE_PER_WORKSPACE_BATCH_SIZE",
        100,
      ),
      intervalMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_TERMINAL_ITEM_PRUNE_INTERVAL_MS",
        60 * 60 * 1000,
      ),
      lockTtlMs: readPositiveIntegerEnv(
        "REVIEW_ROUTER_MEMORY_TERMINAL_ITEM_PRUNE_LOCK_TTL_MS",
        5 * 60 * 1000,
      ),
    },
    {
      clock,
      memoryItems: new PrismaMemoryItemRepository(prisma),
      memoryTransaction: new PrismaMemoryTransaction(prisma),
      lock: new PostgresLeaseLock(prisma),
      logger,
    },
  );
}

function emptyOutboxBatchResult(): ProcessOutboxBatchResult {
  return {
    recoveredStale: 0,
    claimed: 0,
    processed: 0,
    retried: 0,
    deadLettered: 0,
    staleClaims: 0,
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
