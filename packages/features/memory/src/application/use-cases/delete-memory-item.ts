import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemoryError } from "../../domain/memory-errors";
import { MemoryItem } from "../../domain/memory-item";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type DeleteMemoryItemInput = {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly expectedVersion?: number;
  readonly actor: MemoryActor;
};

export async function deleteMemoryItem(
  input: DeleteMemoryItemInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  const existing = await dependencies.memoryItems.findById({
    workspaceId: input.workspaceId,
    itemId: input.itemId,
  });
  if (!existing) {
    return { status: "noop", reason: "memory_not_found" };
  }
  if (existing.status === "deleted") {
    return { status: "noop", reason: "deleted", id: existing.id };
  }
  const permission = await dependencies.memoryPermissions.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId: existing.repositoryId,
    userId: existing.userId,
    scope: existing.scope,
    actor: input.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }
  if (
    input.expectedVersion !== undefined &&
    existing.version !== input.expectedVersion
  ) {
    return {
      status: "rejected",
      reason: "memory_version_conflict",
      retryable: true,
    };
  }

  const now = dependencies.clock.now();
  const item = MemoryItem.fromSnapshot(existing).delete({
    actor: input.actor,
    now,
  });
  const snapshot = item.snapshot();

  try {
    return await dependencies.memoryTransaction.run(async (tx) => {
      await tx.memoryItems.save(item, { expectedVersion: existing.version });
      await tx.memoryAudit.record({
        workspaceId: input.workspaceId,
        actor: memoryActorRef(input.actor),
        action: "memory.item.deleted",
        targetType: "memory_item",
        targetId: snapshot.id,
        metadata: {
          scope: snapshot.scope,
          bodyHash: snapshot.bodyHash,
          previousStatus: existing.status,
          previousVersion: existing.version,
        },
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.item.deleted",
        version: 1,
        idempotencyKey: `memory.item.deleted:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
        workspaceId: input.workspaceId,
        repositoryId: snapshot.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          bodyHash: snapshot.bodyHash,
          bodyVersion: snapshot.bodyVersion,
          scope: snapshot.scope,
        },
        occurredAt: now,
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.embedding.delete.requested",
        version: 1,
        idempotencyKey: `memory.embedding.delete:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
        workspaceId: input.workspaceId,
        repositoryId: snapshot.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          indexState: snapshot.indexState,
          scope: snapshot.scope,
        },
        occurredAt: now,
      });
      return {
        status: "updated",
        id: snapshot.id,
        version: snapshot.version,
      };
    });
  } catch (error) {
    if (
      error instanceof MemoryError &&
      error.code === "memory_version_conflict"
    ) {
      return {
        status: "rejected",
        reason: "memory_version_conflict",
        retryable: true,
      };
    }
    throw error;
  }
}
