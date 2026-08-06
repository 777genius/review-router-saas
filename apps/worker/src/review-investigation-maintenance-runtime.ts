import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import { investigationRetentionMaintenanceEnabledEnvironmentVariable } from "@reviewrouter/features-review-investigations/composition";
import {
  ReviewInvestigationPruneError,
  ReviewInvestigationPruneFailureCode,
  reviewInvestigationMaxPruneBatchSize,
  type PruneReviewInvestigationsPort,
  type ReviewInvestigationPruneOutcome,
} from "./review-investigation-maintenance-adapter";

export const reviewInvestigationMaintenanceEnabledEnv =
  investigationRetentionMaintenanceEnabledEnvironmentVariable;
export const reviewInvestigationMaintenanceLockKey =
  "review-investigations:retention";

export enum ReviewInvestigationMaintenanceStatus {
  Disabled = "disabled",
  IntervalNotElapsed = "interval_not_elapsed",
  LockContended = "lock_contended",
  Completed = "completed",
  Failed = "failed",
}

export enum ReviewInvestigationMaintenanceRuntimeFailureCode {
  Clock = "review_investigation_maintenance_clock_invalid",
  Lease = "review_investigation_maintenance_lease_failed",
}

export type ReviewInvestigationMaintenanceFailureCode =
  | ReviewInvestigationPruneFailureCode
  | ReviewInvestigationMaintenanceRuntimeFailureCode;

export type ReviewInvestigationMaintenanceResult =
  ReviewInvestigationPruneOutcome &
    Readonly<{
      status: ReviewInvestigationMaintenanceStatus;
      failureCode: ReviewInvestigationMaintenanceFailureCode | null;
    }>;

export type ReviewInvestigationMaintenanceRuntime = Readonly<{
  runMaintenance(): Promise<ReviewInvestigationMaintenanceResult>;
}>;

export type ReviewInvestigationMaintenanceFeature =
  ReviewInvestigationMaintenanceRuntime &
    Readonly<{
      enabled: boolean;
    }>;

export type ReviewInvestigationMaintenanceConfig = Readonly<{
  intervalMs: number;
  privateMaterialLimit: number;
  investigationLimit: number;
  shadowEvidenceLimit: number;
  lockTtlMs: number;
}>;

export function createReviewInvestigationMaintenanceFeature(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createEnabledRuntime?: () => ReviewInvestigationMaintenanceRuntime;
}): ReviewInvestigationMaintenanceFeature {
  if (input.env[reviewInvestigationMaintenanceEnabledEnv] !== "1") {
    return {
      enabled: false,
      runMaintenance: async () =>
        maintenanceResult(ReviewInvestigationMaintenanceStatus.Disabled),
    };
  }
  if (!input.createEnabledRuntime) {
    throw new Error("review_investigation_maintenance_composition_missing");
  }
  const runtime = input.createEnabledRuntime();
  return {
    enabled: true,
    runMaintenance: () => runtime.runMaintenance(),
  };
}

export function createReviewInvestigationMaintenanceRuntime(
  config: ReviewInvestigationMaintenanceConfig,
  dependencies: Readonly<{
    clock: Clock;
    lock: DistributedLock;
    prune: PruneReviewInvestigationsPort;
    logger: Pick<Logger, "info" | "warn">;
  }>,
): ReviewInvestigationMaintenanceRuntime {
  assertPositiveInteger(
    config.intervalMs,
    "review_investigation_maintenance_interval_invalid",
  );
  assertPruneLimit(config.privateMaterialLimit);
  assertPruneLimit(config.investigationLimit);
  assertPruneLimit(config.shadowEvidenceLimit);
  assertPositiveInteger(
    config.lockTtlMs,
    "review_investigation_maintenance_lock_ttl_invalid",
  );

  let lastAttemptAtMs: number | null = null;

  return {
    async runMaintenance(): Promise<ReviewInvestigationMaintenanceResult> {
      const now = dependencies.clock.now();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) {
        const result = maintenanceResult(
          ReviewInvestigationMaintenanceStatus.Failed,
          ReviewInvestigationMaintenanceRuntimeFailureCode.Clock,
        );
        logFailure(dependencies.logger, result);
        return result;
      }
      if (
        lastAttemptAtMs !== null &&
        nowMs - lastAttemptAtMs < config.intervalMs
      ) {
        return maintenanceResult(
          ReviewInvestigationMaintenanceStatus.IntervalNotElapsed,
        );
      }
      lastAttemptAtMs = nowMs;

      try {
        const outcome = await dependencies.lock.withLock(
          reviewInvestigationMaintenanceLockKey,
          config.lockTtlMs,
          () =>
            dependencies.prune.execute({
              asOf: now,
              privateMaterialLimit: config.privateMaterialLimit,
              investigationLimit: config.investigationLimit,
              shadowEvidenceLimit: config.shadowEvidenceLimit,
            }),
        );
        const result = maintenanceResult(
          ReviewInvestigationMaintenanceStatus.Completed,
          null,
          outcome,
        );
        dependencies.logger.info(
          "ReviewRouter review investigation retention maintenance completed",
          safeLogContext(result),
        );
        return result;
      } catch (error: unknown) {
        if (isReviewInvestigationMaintenanceLockContention(error)) {
          const result = maintenanceResult(
            ReviewInvestigationMaintenanceStatus.LockContended,
          );
          dependencies.logger.info(
            "ReviewRouter review investigation retention lease contended",
            safeLogContext(result),
          );
          return result;
        }
        const result =
          error instanceof ReviewInvestigationPruneError
            ? maintenanceResult(
                ReviewInvestigationMaintenanceStatus.Failed,
                error.code,
                error.outcome,
              )
            : maintenanceResult(
                ReviewInvestigationMaintenanceStatus.Failed,
                ReviewInvestigationMaintenanceRuntimeFailureCode.Lease,
              );
        logFailure(dependencies.logger, result);
        return result;
      }
    },
  };
}

export function isReviewInvestigationMaintenanceLockContention(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `distributed_lock_not_acquired:${reviewInvestigationMaintenanceLockKey}`
  );
}

function maintenanceResult(
  status: ReviewInvestigationMaintenanceStatus,
  failureCode: ReviewInvestigationMaintenanceFailureCode | null = null,
  outcome: ReviewInvestigationPruneOutcome = {
    recoveredActiveTurnCount: 0,
    expiredPrivateMaterialCount: 0,
    prunedInvestigationCount: 0,
    prunedShadowEvidenceCount: 0,
  },
): ReviewInvestigationMaintenanceResult {
  return { status, failureCode, ...outcome };
}

function safeLogContext(
  result: ReviewInvestigationMaintenanceResult,
): Record<string, unknown> {
  return {
    status: result.status,
    failureCode: result.failureCode,
    recoveredActiveTurnCount: result.recoveredActiveTurnCount,
    expiredPrivateMaterialCount: result.expiredPrivateMaterialCount,
    prunedInvestigationCount: result.prunedInvestigationCount,
    prunedShadowEvidenceCount: result.prunedShadowEvidenceCount,
  };
}

function logFailure(
  logger: Pick<Logger, "warn">,
  result: ReviewInvestigationMaintenanceResult,
): void {
  logger.warn(
    "ReviewRouter review investigation retention maintenance failed",
    safeLogContext(result),
  );
}

function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(code);
  }
}

function assertPruneLimit(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > reviewInvestigationMaxPruneBatchSize
  ) {
    throw new Error("review_investigation_maintenance_prune_limit_invalid");
  }
}
