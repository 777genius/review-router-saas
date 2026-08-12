import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  assertProgressTransition,
  computeProgressSnapshot,
  type ProgressPhase,
  type ProgressSnapshot,
  type ProgressTerminal,
  type ReviewAssignmentManifest as ProgressAssignmentManifest,
  type ReviewSlotProgressInput,
} from "../../domain/review-progress";
import {
  canonicalObjectJson,
  validateReviewAssignmentManifest,
  type ReviewAssignmentManifest,
  type ReviewExecution,
} from "@reviewrouter/features-review-executions";

type Transaction = Prisma.TransactionClient;

export async function captureReviewProgress(
  transaction: Transaction,
  execution: ReviewExecution,
  options: Readonly<{ fileCoverageEnabled?: boolean }> = {},
): Promise<void> {
  await lockProgressScope(transaction, execution);
  const now = execution.updatedAt;
  const manifest = await readAssignmentManifest(transaction, execution);
  const attempts = await transaction.reviewInvocationLeaseV2.groupBy({
    by: ["workSlotId"],
    where: { executionId: execution.executionId },
    _max: { attemptOrdinal: true },
  });
  const maxAttempt = new Map(
    attempts.map((entry) => [entry.workSlotId, entry._max.attemptOrdinal ?? 0]),
  );
  const phase = phaseFor(execution);
  const terminalOutcome = terminalFor(execution);
  const computed = computeProgressSnapshot({
    generation: Number(execution.generation),
    slots: execution.workSlots.map(
      (slot): ReviewSlotProgressInput => ({
        slotId: slot.workSlotId,
        required: slot.required,
        state:
          slot.state === "satisfied"
            ? "accepted"
            : slot.state === "leased"
              ? "running"
              : slot.state,
        attemptOrdinal: Math.max(1, maxAttempt.get(slot.workSlotId) ?? 1),
      }),
    ),
    ...(manifest && options.fileCoverageEnabled === true
      ? { assignmentManifest: progressManifest(execution, manifest) }
      : {}),
    phase,
    terminal: terminalOutcome ?? "none",
    updatedAt: now,
    ...(execution.state === "partial" ? { allowPartial: true } : {}),
  });
  const snapshotHash = hashSnapshotForChangeDetection(computed);
  const existing = await transaction.reviewExecutionProgressV1.findUnique({
    where: { executionId: execution.executionId },
  });
  if (existing) {
    const previous = parseProgressSnapshot(existing.snapshotJson);
    assertProgressTransition(previous, computed);
    if (
      existing.sourceExecutionVersion === execution.version &&
      existing.snapshotHash === snapshotHash
    ) {
      return;
    }
  }

  const publication = await transaction.reviewProgressPublicationV1.findUnique({
    where: {
      workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
        scope(execution),
    },
  });
  const activeGeneration = publication?.activeGeneration ?? -1n;
  const activatesScope = execution.generation >= activeGeneration;
  const desiredVersion = activatesScope
    ? (publication?.desiredVersion ?? 0n) + 1n
    : (existing?.desiredVersion ?? 0n) + 1n;
  const fileCoverage = computed.fileCoverage.valid
    ? computed.fileCoverage
    : null;
  const snapshot = computed as unknown as Prisma.InputJsonObject;
  const required = execution.workSlots.filter((slot) => slot.required);
  const requiredSatisfied = required.filter(
    (slot) => slot.state === "satisfied",
  ).length;
  const requiredExhausted = required.filter(
    (slot) => slot.state === "exhausted",
  ).length;
  const requiredCancelled = required.filter(
    (slot) => slot.state === "cancelled",
  ).length;
  const retryingUnits = required.filter(
    (slot) =>
      slot.state === "leased" && (maxAttempt.get(slot.workSlotId) ?? 0) > 1,
  ).length;
  const recoveredUnits = required.filter(
    (slot) =>
      slot.state === "satisfied" && (maxAttempt.get(slot.workSlotId) ?? 0) > 1,
  ).length;

  await transaction.reviewExecutionProgressV1.upsert({
    where: { executionId: execution.executionId },
    create: progressData(),
    update: progressData(),
  });
  if (!activatesScope) return;

  const isTerminal = terminalOutcome !== null;
  const throttledAt = publication?.lastPublishedAt
    ? new Date(publication.lastPublishedAt.getTime() + 60_000)
    : new Date(now.getTime() + 1_000);
  const nextPublishAt = isTerminal || throttledAt < now ? now : throttledAt;
  if (!publication) {
    await transaction.reviewProgressPublicationV1.create({
      data: {
        ...scope(execution),
        activeExecutionId: execution.executionId,
        activeGeneration: execution.generation,
        activeHeadSha: execution.revision.headSha,
        activePlanHash: execution.planHash,
        desiredVersion,
        nextPublishAt,
        createdAt: now,
        updatedAt: now,
      },
    });
    return;
  }
  await transaction.reviewProgressPublicationV1.update({
    where: {
      workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
        scope(execution),
    },
    data: {
      version: { increment: 1n },
      activeExecutionId: execution.executionId,
      activeGeneration: execution.generation,
      activeHeadSha: execution.revision.headSha,
      activePlanHash: execution.planHash,
      desiredVersion,
      nextPublishAt,
      failureCount: 0,
      lastErrorCode: null,
      updatedAt: now,
      // A live claim is deliberately preserved. Its stale complete loses the
      // active identity/version CAS and the new snapshot remains due.
    },
  });

  function progressData() {
    return {
      executionId: execution.executionId,
      workspaceId: execution.workspaceId,
      repositoryConnectionId: execution.repositoryConnectionId,
      scmRepositoryIdentityId: execution.scmRepositoryIdentityId,
      pullRequestNumber: execution.pullRequestNumber,
      generation: execution.generation,
      headSha: execution.revision.headSha,
      planHash: execution.planHash,
      sourceExecutionVersion: execution.version,
      snapshotHash,
      phase,
      requiredTotal: required.length,
      requiredSatisfied,
      requiredExhausted,
      requiredCancelled,
      retryingUnits,
      recoveredUnits,
      snapshotJson: snapshot,
      eligibleFileCount: fileCoverage?.total ?? null,
      coveredFileCount: fileCoverage?.covered ?? null,
      uncoveredFileCount: fileCoverage?.uncovered ?? null,
      excludedFileCount: fileCoverage?.excluded ?? null,
      desiredVersion,
      terminalOutcome,
      updatedAt: now,
    };
  }
}

async function readAssignmentManifest(
  transaction: Transaction,
  execution: ReviewExecution,
): Promise<ReviewAssignmentManifest | null> {
  const row = await transaction.reviewExecutionV2.findUnique({
    where: { executionId: execution.executionId },
    select: { assignmentManifestVersion: true, assignmentManifestJson: true },
  });
  if (row === null) throw new Error("review_progress_execution_missing");
  if (
    row.assignmentManifestVersion === null &&
    row.assignmentManifestJson === null
  ) {
    return null;
  }
  if (
    row.assignmentManifestVersion !== 1 ||
    row.assignmentManifestJson === null
  ) {
    throw new Error("review_assignment_manifest_persisted_invalid");
  }
  return validateReviewAssignmentManifest(
    row.assignmentManifestJson,
    execution.workSlots.map((slot) => slot.workSlotId),
  );
}

function progressManifest(
  execution: ReviewExecution,
  manifest: ReviewAssignmentManifest,
): ProgressAssignmentManifest {
  const requiredIds = new Set(
    execution.workSlots
      .filter((slot) => slot.required)
      .map((slot) => slot.workSlotId),
  );
  const requiredByPath = new Map<string, string[]>();
  for (const assignment of manifest.assignments) {
    if (!requiredIds.has(assignment.workSlotId)) continue;
    for (const path of assignment.paths) {
      requiredByPath.set(path, [
        ...(requiredByPath.get(path) ?? []),
        assignment.workSlotId,
      ]);
    }
  }
  const uncovered = new Set(manifest.uncoveredPaths);
  return {
    paths: [
      ...manifest.eligiblePaths.map((path) => ({
        pathId: pathIdentity(path),
        disposition: "reviewable" as const,
        requiredCoveringSlotIds: uncovered.has(path)
          ? []
          : (requiredByPath.get(path) ?? []),
      })),
      ...manifest.excludedPaths.map((path) => ({
        pathId: pathIdentity(path),
        disposition: "excluded" as const,
        requiredCoveringSlotIds: [] as string[],
      })),
    ],
    uncoveredCount: manifest.uncoveredPaths.length,
    excludedCount: manifest.excludedPaths.length,
  };
}

function phaseFor(execution: ReviewExecution): ProgressPhase {
  if (execution.state === "planned") return "preparing";
  if (execution.state === "running") return "reviewing";
  if (execution.state === "completed" || execution.state === "partial")
    return "assembling";
  return "terminal";
}

function terminalFor(
  execution: ReviewExecution,
): Exclude<ProgressTerminal, "none"> | null {
  if (execution.state === "superseded") return "superseded";
  if (execution.state === "failed") return "failed";
  return null;
}

function pathIdentity(value: string): string {
  return `path-sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hashSnapshotForChangeDetection(snapshot: ProgressSnapshot): string {
  const stableSnapshot = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== "updatedAt"),
  );
  const canonical = canonicalObjectJson(stableSnapshot);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseProgressSnapshot(value: Prisma.JsonValue): ProgressSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("review_progress_snapshot_invalid");
  }
  if (
    !isNonNegativeInteger(value.generation) ||
    !isProgressPhase(value.phase) ||
    !isProgressTerminal(value.terminal) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !isProgressCounts(value.counts) ||
    !isFileCoverage(value.fileCoverage) ||
    (value.phase === "terminal") !== (value.terminal !== "none")
  ) {
    throw new Error("review_progress_snapshot_invalid");
  }
  return value as unknown as ProgressSnapshot;
}

function scope(execution: ReviewExecution) {
  return {
    workspaceId: execution.workspaceId,
    repositoryConnectionId: execution.repositoryConnectionId,
    scmRepositoryIdentityId: execution.scmRepositoryIdentityId,
    pullRequestNumber: execution.pullRequestNumber,
  };
}

async function lockProgressScope(
  transaction: Transaction,
  execution: ReviewExecution,
) {
  const locked = await transaction.$queryRaw<readonly { one: number }[]>(
    Prisma.sql`SELECT 1 AS "one" FROM "ReviewExecutionStreamV2" WHERE "workspaceId" = ${execution.workspaceId} AND "repositoryConnectionId" = ${execution.repositoryConnectionId} AND "scmRepositoryIdentityId" = ${execution.scmRepositoryIdentityId} AND "pullRequestNumber" = ${execution.pullRequestNumber} FOR UPDATE`,
  );
  if (locked.length !== 1) {
    throw new Error("review_progress_scope_lock_missing");
  }
}

const progressCountKeys = [
  "total",
  "completed",
  "exhausted",
  "cancelled",
  "running",
  "pending",
  "retrying",
  "recovered",
  "requiredTotal",
  "requiredCompleted",
  "requiredExhausted",
  "requiredCancelled",
  "optionalTotal",
  "optionalCompleted",
] as const;

function isProgressCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    progressCountKeys.every((key) => isNonNegativeInteger(value[key]))
  );
}

function isFileCoverage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.valid !== "boolean") return false;
  if (!value.valid) return true;
  return ["total", "covered", "uncovered", "excluded"].every((key) =>
    isNonNegativeInteger(value[key]),
  );
}

function isProgressPhase(value: unknown): value is ProgressPhase {
  return (
    typeof value === "string" &&
    ["preparing", "reviewing", "assembling", "publishing", "terminal"].includes(
      value,
    )
  );
}

function isProgressTerminal(value: unknown): value is ProgressTerminal {
  return (
    typeof value === "string" &&
    [
      "none",
      "complete",
      "complete_with_gaps",
      "failed",
      "cancelled",
      "superseded",
    ].includes(value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
