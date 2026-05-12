import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemorySuggestion } from "../../domain/memory-suggestion";
import { expirePendingMemorySuggestionIfExpired } from "./expire-pending-memory-suggestions";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type RejectMemorySuggestionInput = {
  readonly workspaceId: string;
  readonly suggestionId: string;
  readonly actor: MemoryActor;
  readonly reason?: string;
};

export async function rejectMemorySuggestion(
  input: RejectMemorySuggestionInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  const existing = await dependencies.memorySuggestions.findById({
    workspaceId: input.workspaceId,
    suggestionId: input.suggestionId,
  });
  if (!existing) {
    return { status: "noop", reason: "memory_not_found" };
  }
  if (existing.status !== "pending") {
    return { status: "noop", reason: existing.status, id: existing.id };
  }
  const now = dependencies.clock.now();
  if (
    await expirePendingMemorySuggestionIfExpired(
      { workspaceId: input.workspaceId, suggestion: existing, now },
      dependencies,
    )
  ) {
    return { status: "noop", reason: "expired", id: existing.id };
  }

  const permission = await dependencies.memoryPermissions.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId: existing.repositoryId,
    userId: existing.userId,
    scope: existing.suggestedScope,
    actor: input.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }

  const suggestion = MemorySuggestion.fromSnapshot(existing).reject({
    actor: input.actor,
    reason: input.reason ?? "rejected",
    now,
  });
  const snapshot = suggestion.snapshot();

  return dependencies.memoryTransaction.run(async (tx) => {
    await tx.memorySuggestions.save(suggestion);
    await tx.memoryAudit.record({
      workspaceId: input.workspaceId,
      actor: memoryActorRef(input.actor),
      action: "memory.suggestion.rejected",
      targetType: "memory_suggestion",
      targetId: snapshot.id,
      metadata: {
        scope: snapshot.suggestedScope,
        bodyHash: snapshot.suggestedBodyHash,
        reason: snapshot.resolutionReason,
      },
    });
    await tx.memoryOutbox.enqueue({
      type: "memory.suggestion.rejected",
      version: 1,
      idempotencyKey: `memory.suggestion.rejected:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
      workspaceId: input.workspaceId,
      repositoryId: snapshot.repositoryId,
      aggregateId: snapshot.id,
      payload: {
        scope: snapshot.suggestedScope,
        status: snapshot.status,
      },
      occurredAt: now,
    });
    return {
      status: "updated",
      id: snapshot.id,
      version: snapshot.version,
    };
  });
}
