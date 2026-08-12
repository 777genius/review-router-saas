import { createHash } from "node:crypto";
import {
  OutboxHandlerError,
  type OutboxEvent,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import {
  AdvanceReviewCompletionProcessStatus,
  ReviewCompletionProcessCreateStatus,
  ReviewCompletionWakeupKind,
  type RecoverMissingReviewCompletionProcesses,
  type ScanDueReviewCompletionProcesses,
  type WakeReviewCompletionProcess,
} from "@reviewrouter/features-review-processes";
import { ReviewCompletionSchedulerMode } from "@reviewrouter/features-review-processes/composition";
import type { ReviewCompletionWakeupQueryPort } from "./review-v2-context-adapters";

export const reviewV2WorkerEnabledEnv =
  "REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED";
export const reviewExecutionFinalizedEventType = "review.execution.finalized";
export const reviewExecutionFinalizedEventVersion = 2;

export type ReviewV2WorkerFeature = {
  readonly enabled: boolean;
  readonly handlers: readonly OutboxHandler[];
  readonly runMaintenance: () => Promise<ReviewV2MaintenanceResult>;
};

export type ReviewV2MaintenanceResult = {
  readonly intentsScanned: number;
  readonly intentsDispatched: number;
  readonly intentsRecovered: number;
  readonly intentDispatchFailures: number;
  readonly recovered: number;
  readonly advanced: number;
  readonly publicationProcessed: number;
  readonly publicationManualRequired: number;
  readonly publicationTerminalUnknown: number;
  readonly progressPromoted: number;
  readonly progressClaimed: number;
  readonly progressPublished: number;
  readonly progressDeferred: number;
  readonly progressSuppressed: number;
  readonly progressFailed: number;
  readonly expiredExecutionsScanned: number;
  readonly expiredExecutionsRecovered: number;
  readonly expiredExecutionConflicts: number;
  readonly expiredExecutionFailures: number;
};

export type ReviewV2IntentMaintenanceRuntime = {
  runMaintenance(): Promise<{
    readonly scanned: number;
    readonly dispatched: number;
    readonly recovered: number;
    readonly failed: number;
  }>;
};

export type ReviewV2ExecutionRecoveryRuntime = {
  execute(input: { readonly limit: number }): Promise<{
    readonly scanned: number;
    readonly recovered: number;
    readonly conflicts: number;
    readonly failures: number;
  }>;
};

export type ReviewV2PublicationMaintenanceRuntime = {
  runMaintenance(): Promise<{
    readonly processed: number;
    readonly manualRequired: number;
    readonly terminalUnknown: number;
    readonly settledExecutionIds: readonly string[];
    readonly progressSettlements: readonly ReviewProgressSettlement[];
  }>;
};

export type ReviewProgressSettlement = Readonly<{
  executionId: string;
  outcome: "succeeded" | "failed" | "superseded";
}>;

export type ReviewV2ProgressMaintenanceRuntime = {
  promoteSettledExecutions(input: {
    readonly settlements: readonly ReviewProgressSettlement[];
  }): Promise<number>;
  runMaintenance(): Promise<{
    readonly claimed: number;
    readonly published: number;
    readonly deferred: number;
    readonly suppressed: number;
    readonly failed: number;
  }>;
};

export type ReviewV2CompletionRuntime = {
  readonly wake: Pick<WakeReviewCompletionProcess, "execute">;
  readonly advance: {
    execute(input: {
      readonly executionId: string;
      readonly ownerIdHash: string;
    }): Promise<{ readonly status: AdvanceReviewCompletionProcessStatus }>;
  };
  readonly schedulers: {
    readonly mode: ReviewCompletionSchedulerMode.Enabled;
    readonly due: Pick<ScanDueReviewCompletionProcesses, "execute">;
    readonly recovery: Pick<
      RecoverMissingReviewCompletionProcesses,
      "scanNextPage"
    >;
  };
};

export function createReviewV2WorkerFeature(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createEnabledRuntime?: () => {
    readonly runtime: ReviewV2CompletionRuntime;
    readonly wakeups: ReviewCompletionWakeupQueryPort;
    readonly ownerIdHash: string;
    readonly dueLimit: number;
    readonly intents?: ReviewV2IntentMaintenanceRuntime;
    readonly executionRecovery?: ReviewV2ExecutionRecoveryRuntime;
    readonly publication?: ReviewV2PublicationMaintenanceRuntime;
    readonly progress?: ReviewV2ProgressMaintenanceRuntime;
    readonly ingressHandlers?: readonly OutboxHandler[];
  };
}): ReviewV2WorkerFeature {
  if (input.env[reviewV2WorkerEnabledEnv] !== "1") {
    return {
      enabled: false,
      handlers: [],
      runMaintenance: async () => ({
        intentsScanned: 0,
        intentsDispatched: 0,
        intentsRecovered: 0,
        intentDispatchFailures: 0,
        recovered: 0,
        advanced: 0,
        publicationProcessed: 0,
        publicationManualRequired: 0,
        publicationTerminalUnknown: 0,
        progressPromoted: 0,
        progressClaimed: 0,
        progressPublished: 0,
        progressDeferred: 0,
        progressSuppressed: 0,
        progressFailed: 0,
        expiredExecutionsScanned: 0,
        expiredExecutionsRecovered: 0,
        expiredExecutionConflicts: 0,
        expiredExecutionFailures: 0,
      }),
    };
  }
  if (
    input.env.REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED === "1" &&
    input.env.REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED !== "1"
  ) {
    throw new Error("review_v2_ingress_requires_fenced_outbox_takeover");
  }
  if (!input.createEnabledRuntime) {
    throw new Error("review_v2_worker_enabled_composition_missing");
  }
  const enabled = input.createEnabledRuntime();
  return {
    enabled: true,
    handlers: [
      createReviewExecutionFinalizedHandler({
        runtime: enabled.runtime,
        wakeups: enabled.wakeups,
        ownerIdHash: enabled.ownerIdHash,
      }),
      ...(enabled.ingressHandlers ?? []),
    ],
    runMaintenance: () =>
      runReviewV2Maintenance({
        runtime: enabled.runtime,
        ownerIdHash: enabled.ownerIdHash,
        dueLimit: enabled.dueLimit,
        ...(enabled.intents ? { intents: enabled.intents } : {}),
        ...(enabled.executionRecovery
          ? { executionRecovery: enabled.executionRecovery }
          : {}),
        ...(enabled.publication ? { publication: enabled.publication } : {}),
        ...(enabled.progress ? { progress: enabled.progress } : {}),
      }),
  };
}

export function createReviewExecutionFinalizedHandler(input: {
  readonly runtime: Pick<ReviewV2CompletionRuntime, "wake" | "advance">;
  readonly wakeups: ReviewCompletionWakeupQueryPort;
  readonly ownerIdHash: string;
}): OutboxHandler {
  requireOwnerHash(input.ownerIdHash);
  return {
    type: reviewExecutionFinalizedEventType,
    version: reviewExecutionFinalizedEventVersion,
    async handle(event: OutboxEvent) {
      const payload = parseFinalizedEvent(event);
      const facts = await input.wakeups.findFinalizedWakeup(payload);
      if (!facts) {
        throw new OutboxHandlerError(
          "Finalized review execution facts are not readable yet",
          "review_v2_finalized_facts_unavailable",
          true,
        );
      }
      const wake = await input.runtime.wake.execute({
        executionId: facts.executionId,
        finalizedArtifactId: facts.finalizedArtifactId,
        wakeupKind: ReviewCompletionWakeupKind.ExecutionFinalized,
        wakeupAt: facts.finalizedAt,
        retainUntil: facts.retainUntil,
      });
      if (
        wake.status === ReviewCompletionProcessCreateStatus.ArtifactConflict
      ) {
        throw new OutboxHandlerError(
          "Finalized review execution conflicts with the completion process",
          "review_v2_completion_artifact_conflict",
          false,
        );
      }
      await input.runtime.advance.execute({
        executionId: facts.executionId,
        ownerIdHash: input.ownerIdHash,
      });
    },
  };
}

export async function runReviewV2Maintenance(input: {
  readonly runtime: ReviewV2CompletionRuntime;
  readonly ownerIdHash: string;
  readonly dueLimit: number;
  readonly intents?: ReviewV2IntentMaintenanceRuntime;
  readonly executionRecovery?: ReviewV2ExecutionRecoveryRuntime;
  readonly publication?: ReviewV2PublicationMaintenanceRuntime;
  readonly progress?: ReviewV2ProgressMaintenanceRuntime;
}): Promise<ReviewV2MaintenanceResult> {
  requireOwnerHash(input.ownerIdHash);
  if (!Number.isSafeInteger(input.dueLimit) || input.dueLimit <= 0) {
    throw new Error("review_v2_worker_due_limit_invalid");
  }
  const recovery = await input.runtime.schedulers.recovery.scanNextPage();
  const executionRecovery = await input.executionRecovery?.execute({
    limit: input.dueLimit,
  });
  const intents = await input.intents?.runMaintenance();
  const due = await input.runtime.schedulers.due.execute({
    ownerIdHash: input.ownerIdHash,
    limit: input.dueLimit,
  });
  const publication = await input.publication?.runMaintenance();
  const publicationWakeups = publication
    ? await Promise.all(
        [...new Set(publication.settledExecutionIds)].map((executionId) =>
          input.runtime.advance.execute({
            executionId,
            ownerIdHash: input.ownerIdHash,
          }),
        ),
      )
    : [];
  const advanced = [...due, ...publicationWakeups].filter(
    (result) =>
      result.status !== AdvanceReviewCompletionProcessStatus.Busy &&
      result.status !== AdvanceReviewCompletionProcessStatus.Missing &&
      result.status !== AdvanceReviewCompletionProcessStatus.StaleClaim,
  ).length;
  let progressPromoted = 0;
  let progressPromotionFailed = false;
  if (input.progress && publication) {
    try {
      progressPromoted = await input.progress.promoteSettledExecutions({
        settlements: publication.progressSettlements,
      });
    } catch {
      progressPromotionFailed = true;
    }
  }
  // The final review publication always runs first. Progress is deliberately
  // last so it can never delay or overtake the user-visible review result.
  let progress:
    | Awaited<ReturnType<ReviewV2ProgressMaintenanceRuntime["runMaintenance"]>>
    | undefined;
  let progressPublicationFailed = false;
  if (input.progress) {
    try {
      progress = await input.progress.runMaintenance();
    } catch {
      progressPublicationFailed = true;
    }
  }
  return {
    intentsScanned: intents?.scanned ?? 0,
    intentsDispatched: intents?.dispatched ?? 0,
    intentsRecovered: intents?.recovered ?? 0,
    intentDispatchFailures: intents?.failed ?? 0,
    recovered: recovery.createdOrRestored,
    advanced,
    publicationProcessed: publication?.processed ?? 0,
    publicationManualRequired: publication?.manualRequired ?? 0,
    publicationTerminalUnknown: publication?.terminalUnknown ?? 0,
    progressPromoted,
    progressClaimed: progress?.claimed ?? 0,
    progressPublished: progress?.published ?? 0,
    progressDeferred: progress?.deferred ?? 0,
    progressSuppressed: progress?.suppressed ?? 0,
    progressFailed:
      (progress?.failed ?? 0) +
      Number(progressPromotionFailed) +
      Number(progressPublicationFailed),
    expiredExecutionsScanned: executionRecovery?.scanned ?? 0,
    expiredExecutionsRecovered: executionRecovery?.recovered ?? 0,
    expiredExecutionConflicts: executionRecovery?.conflicts ?? 0,
    expiredExecutionFailures: executionRecovery?.failures ?? 0,
  };
}

export function createReviewV2WorkerOwnerId(seed: string): string {
  if (seed.trim().length === 0) {
    throw new Error("review_v2_worker_owner_seed_invalid");
  }
  return createHash("sha256")
    .update(`rr.review-v2-worker-owner.v1\0${seed}`, "utf8")
    .digest("hex");
}

function parseFinalizedEvent(event: OutboxEvent): {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
} {
  if (
    event.type !== reviewExecutionFinalizedEventType ||
    event.version !== reviewExecutionFinalizedEventVersion ||
    !isRecord(event.payload)
  ) {
    throw invalidFinalizedEvent();
  }
  const executionId = event.payload.executionId;
  const finalizedArtifactId = event.payload.artifactId;
  const artifactHash = event.payload.artifactHash;
  const generation = event.payload.generation;
  const reviewRevisionHash = event.payload.reviewRevisionHash;
  const projectionHash = event.payload.projectionHash;
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    typeof finalizedArtifactId !== "string" ||
    finalizedArtifactId.length === 0 ||
    typeof artifactHash !== "string" ||
    !isSha256(artifactHash) ||
    typeof generation !== "string" ||
    !isPositiveDecimal(generation) ||
    typeof reviewRevisionHash !== "string" ||
    !isSha256(reviewRevisionHash) ||
    typeof projectionHash !== "string" ||
    !isSha256(projectionHash) ||
    event.aggregateId !== executionId
  ) {
    throw invalidFinalizedEvent();
  }
  return { executionId, finalizedArtifactId };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isPositiveDecimal(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function invalidFinalizedEvent(): OutboxHandlerError {
  return new OutboxHandlerError(
    "Invalid review.execution.finalized event payload",
    "review_v2_finalized_event_invalid",
    false,
  );
}

function requireOwnerHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("review_v2_worker_owner_hash_invalid");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
