import type {
  ReviewCompletionClockPort,
  ReviewCompletionExecutionQueryPort,
  ReviewCompletionIdPort,
  ReviewCompletionProcessRepositoryPort,
  ReviewCompletionPublicationPort,
  ReviewCompletionRecoveryFeedPort,
  ReviewCompletionSnapshotPort,
} from "../application/ports/review-completion-process-ports";
import {
  AdvanceReviewCompletionProcess,
  type AdvanceReviewCompletionProcessOptions,
} from "../application/use-cases/advance-review-completion-process";
import { RecoverMissingReviewCompletionProcesses } from "../application/use-cases/recover-missing-review-completion-processes";
import { ScanDueReviewCompletionProcesses } from "../application/use-cases/scan-due-review-completion-processes";
import { WakeReviewCompletionProcess } from "../application/use-cases/wake-review-completion-process";

export enum ReviewCompletionSchedulerMode {
  Disabled = "disabled",
  Enabled = "enabled",
}

export type ReviewCompletionProcessCompositionOptions =
  AdvanceReviewCompletionProcessOptions & {
    readonly processes: ReviewCompletionProcessRepositoryPort;
    readonly executions: ReviewCompletionExecutionQueryPort;
    readonly publications: ReviewCompletionPublicationPort;
    readonly snapshots: ReviewCompletionSnapshotPort;
    readonly clock: ReviewCompletionClockPort;
    readonly ids: ReviewCompletionIdPort;
    readonly schedulerMode?: ReviewCompletionSchedulerMode;
    readonly recoveryFeed?: ReviewCompletionRecoveryFeedPort;
    readonly recoveryPageSize?: number;
  };

export function composeReviewCompletionProcesses(
  options: ReviewCompletionProcessCompositionOptions,
) {
  const wake = new WakeReviewCompletionProcess(options.processes);
  const advance = new AdvanceReviewCompletionProcess(
    options.processes,
    options.executions,
    options.publications,
    options.snapshots,
    options.clock,
    options.ids,
    options,
  );
  const schedulerMode =
    options.schedulerMode ?? ReviewCompletionSchedulerMode.Disabled;
  if (schedulerMode === ReviewCompletionSchedulerMode.Disabled) {
    return {
      wake,
      advance,
      schedulers: {
        mode: ReviewCompletionSchedulerMode.Disabled as const,
        due: null,
        recovery: null,
      },
    };
  }
  if (!options.recoveryFeed) {
    throw new Error("review_completion_recovery_feed_required");
  }
  return {
    wake,
    advance,
    schedulers: {
      mode: ReviewCompletionSchedulerMode.Enabled as const,
      due: new ScanDueReviewCompletionProcesses(
        options.processes,
        advance,
        options.clock,
        options.ids,
        options.claimDurationMs,
      ),
      recovery: new RecoverMissingReviewCompletionProcesses(
        options.recoveryFeed,
        options.processes,
        options.recoveryPageSize ?? 100,
      ),
    },
  };
}

export * from "../infrastructure/prisma";
