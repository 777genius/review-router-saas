import { describe, expect, it } from "vitest";
import type { InvestigationShadowEvidencePrunerPort } from "@reviewrouter/features-review-evidence";
import type { InvestigationPrunerPort } from "@reviewrouter/features-review-investigations";
import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import {
  InvestigationPrunerMaintenanceAdapter,
  ReviewInvestigationPruneFailureCode,
  type PruneReviewInvestigationsPort,
} from "./review-investigation-maintenance-adapter";
import {
  createReviewInvestigationMaintenanceFeature,
  createReviewInvestigationMaintenanceRuntime,
  reviewInvestigationMaintenanceEnabledEnv,
  reviewInvestigationMaintenanceLockKey,
  ReviewInvestigationMaintenanceStatus,
} from "./review-investigation-maintenance-runtime";

const now = new Date("2026-08-03T12:00:00.000Z");
const config = {
  intervalMs: 60_000,
  privateMaterialLimit: 100,
  investigationLimit: 25,
  shadowEvidenceLimit: 50,
  lockTtlMs: 120_000,
} as const;

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return this.value;
  }

  set(value: Date): void {
    this.value = value;
  }
}

class CapturingLogger implements Pick<Logger, "info" | "warn"> {
  readonly infoEvents: Array<{
    readonly message: string;
    readonly context: Record<string, unknown> | undefined;
  }> = [];
  readonly warnEvents: Array<{
    readonly message: string;
    readonly context: Record<string, unknown> | undefined;
  }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.infoEvents.push({ message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.warnEvents.push({ message, context });
  }
}

class ImmediateLock implements DistributedLock {
  readonly attempts: Array<{ readonly key: string; readonly ttlMs: number }> =
    [];

  async withLock<T>(
    key: string,
    ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    this.attempts.push({ key, ttlMs });
    return run();
  }
}

class ContendedLock implements DistributedLock {
  private active = false;

  async withLock<T>(
    key: string,
    _ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.active) {
      throw new Error(`distributed_lock_not_acquired:${key}`);
    }
    this.active = true;
    try {
      return await run();
    } finally {
      this.active = false;
    }
  }
}

class ConstantPrune implements PruneReviewInvestigationsPort {
  calls = 0;

  async execute(): Promise<{
    readonly expiredPrivateMaterialCount: number;
    readonly prunedInvestigationCount: number;
    readonly prunedShadowEvidenceCount: number;
  }> {
    this.calls += 1;
    return {
      expiredPrivateMaterialCount: 2,
      prunedInvestigationCount: 1,
      prunedShadowEvidenceCount: 3,
    };
  }
}

describe("review investigation maintenance runtime", () => {
  it("is dormant by default and fails closed when enabled without composition", async () => {
    let composed = false;
    const feature = createReviewInvestigationMaintenanceFeature({
      env: {},
      createEnabledRuntime: () => {
        composed = true;
        throw new Error("must_not_compose");
      },
    });

    expect(feature.enabled).toBe(false);
    await expect(feature.runMaintenance()).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.Disabled,
      expiredPrivateMaterialCount: 0,
      prunedInvestigationCount: 0,
      prunedShadowEvidenceCount: 0,
    });
    expect(composed).toBe(false);
    expect(() =>
      createReviewInvestigationMaintenanceFeature({
        env: { [reviewInvestigationMaintenanceEnabledEnv]: "1" },
      }),
    ).toThrow("review_investigation_maintenance_composition_missing");
  });

  it("runs one lease-protected batch per interval without catch-up loops", async () => {
    const clock = new MutableClock(now);
    const lock = new ImmediateLock();
    const prune = new ConstantPrune();
    const logger = new CapturingLogger();
    const runtime = createReviewInvestigationMaintenanceRuntime(config, {
      clock,
      lock,
      prune,
      logger,
    });

    await expect(runtime.runMaintenance()).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.Completed,
      expiredPrivateMaterialCount: 2,
      prunedInvestigationCount: 1,
      prunedShadowEvidenceCount: 3,
    });
    clock.set(new Date(now.getTime() + 30_000));
    await expect(runtime.runMaintenance()).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.IntervalNotElapsed,
    });
    clock.set(new Date(now.getTime() + 60_000));
    await expect(runtime.runMaintenance()).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.Completed,
    });

    expect(prune.calls).toBe(2);
    expect(lock.attempts).toEqual([
      { key: reviewInvestigationMaintenanceLockKey, ttlMs: 120_000 },
      { key: reviewInvestigationMaintenanceLockKey, ttlMs: 120_000 },
    ]);
    expect(logger.infoEvents).toHaveLength(2);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("allows only one concurrent maintenance runtime to enter the lease", async () => {
    const lock = new ContendedLock();
    const logger = new CapturingLogger();
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const prune: PruneReviewInvestigationsPort = {
      async execute() {
        calls += 1;
        started.resolve();
        await release.promise;
        return {
          expiredPrivateMaterialCount: 1,
          prunedInvestigationCount: 1,
          prunedShadowEvidenceCount: 1,
        };
      },
    };
    const dependencies = {
      clock: new MutableClock(now),
      lock,
      prune,
      logger,
    };
    const firstRuntime = createReviewInvestigationMaintenanceRuntime(
      config,
      dependencies,
    );
    const secondRuntime = createReviewInvestigationMaintenanceRuntime(
      config,
      dependencies,
    );

    const first = firstRuntime.runMaintenance();
    await started.promise;
    await expect(secondRuntime.runMaintenance()).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.LockContended,
      expiredPrivateMaterialCount: 0,
      prunedInvestigationCount: 0,
      prunedShadowEvidenceCount: 0,
    });
    release.resolve();
    await expect(first).resolves.toMatchObject({
      status: ReviewInvestigationMaintenanceStatus.Completed,
    });
    expect(calls).toBe(1);
  });

  it("reports failed prune progress without leaking private material", async () => {
    const secretQuery = "internal_search_query_never_log";
    const secretToken = "gh" + "p_privateMaintenanceToken";
    const pruner: InvestigationPrunerPort = {
      async reconcileExpiredPrivateMaterial() {
        return 4;
      },
      async pruneRetainedInvestigations() {
        throw new Error(`${secretQuery}:${secretToken}`);
      },
    };
    const shadowEvidence: InvestigationShadowEvidencePrunerPort = {
      async prune() {
        return 0;
      },
    };
    const logger = new CapturingLogger();
    const runtime = createReviewInvestigationMaintenanceRuntime(config, {
      clock: new MutableClock(now),
      lock: new ImmediateLock(),
      prune: new InvestigationPrunerMaintenanceAdapter({
        privateMaterial: pruner,
        investigations: pruner,
        shadowEvidence,
      }),
      logger,
    });

    await expect(runtime.runMaintenance()).resolves.toEqual({
      status: ReviewInvestigationMaintenanceStatus.Failed,
      failureCode: ReviewInvestigationPruneFailureCode.Investigations,
      expiredPrivateMaterialCount: 4,
      prunedInvestigationCount: 0,
      prunedShadowEvidenceCount: 0,
    });
    expect(logger.infoEvents).toHaveLength(0);
    expect(logger.warnEvents).toHaveLength(1);
    expect(logger.warnEvents[0]?.context).toEqual({
      status: ReviewInvestigationMaintenanceStatus.Failed,
      failureCode: ReviewInvestigationPruneFailureCode.Investigations,
      expiredPrivateMaterialCount: 4,
      prunedInvestigationCount: 0,
      prunedShadowEvidenceCount: 0,
    });
    const serializedLogs = JSON.stringify(logger);
    expect(serializedLogs).not.toContain(secretQuery);
    expect(serializedLogs).not.toContain(secretToken);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
