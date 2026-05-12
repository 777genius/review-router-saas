import { createMemoryBodyHash } from "../../domain/memory-body";
import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemoryError } from "../../domain/memory-errors";
import { MemoryItem } from "../../domain/memory-item";
import { evaluateMemorySafety } from "../../domain/memory-safety-policy";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type EditMemoryItemInput = {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly body: string;
  readonly expectedVersion?: number;
  readonly actor: MemoryActor;
  readonly safetyPolicyVersion?: number;
};

export async function editMemoryItem(
  input: EditMemoryItemInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  const existing = await dependencies.memoryItems.findById({
    workspaceId: input.workspaceId,
    itemId: input.itemId,
  });
  if (!existing) {
    return { status: "noop", reason: "memory_not_found" };
  }
  if (existing.status === "deleted" || existing.status === "expired") {
    return { status: "noop", reason: existing.status, id: existing.id };
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

  const safety = evaluateMemorySafety({
    body: input.body,
    scope: existing.scope,
    redactedSourceExcerpt: existing.source.redactedExcerpt,
  });
  if (safety.severity === "blocked") {
    return {
      status: "rejected",
      reason: safety.blockedReason ?? "memory_safety_blocked",
    };
  }
  const nextBodyHash = createMemoryBodyHash(safety.redactedBody);
  const duplicate = await dependencies.memoryItems.findActiveByBodyHash({
    workspaceId: input.workspaceId,
    scope: existing.scope,
    repositoryId: existing.repositoryId,
    userId: existing.userId,
    bodyHash: nextBodyHash,
  });
  if (duplicate && duplicate.id !== existing.id) {
    return { status: "noop", reason: "memory_duplicate", id: duplicate.id };
  }

  const now = dependencies.clock.now();
  const item = MemoryItem.fromSnapshot(existing).editBody({
    actor: input.actor,
    body: safety.redactedBody,
    riskLevel: safety.riskLevel,
    safetyPolicyVersion:
      input.safetyPolicyVersion ?? existing.safetyPolicyVersion,
    now,
  });
  const snapshot = item.snapshot();
  const bodyChanged = snapshot.bodyHash !== existing.bodyHash;

  try {
    return await dependencies.memoryTransaction.run(async (tx) => {
      await tx.memoryItems.save(item, { expectedVersion: existing.version });
      await tx.memoryAudit.record({
        workspaceId: input.workspaceId,
        actor: memoryActorRef(input.actor),
        action: "memory.item.edited",
        targetType: "memory_item",
        targetId: snapshot.id,
        metadata: {
          scope: snapshot.scope,
          previousBodyHash: existing.bodyHash,
          bodyHash: snapshot.bodyHash,
          previousBodyVersion: existing.bodyVersion,
          bodyVersion: snapshot.bodyVersion,
          previousVersion: existing.version,
          version: snapshot.version,
          bodyChanged,
        },
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.item.edited",
        version: 1,
        idempotencyKey: `memory.item.edited:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
        workspaceId: input.workspaceId,
        repositoryId: snapshot.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          bodyHash: snapshot.bodyHash,
          bodyVersion: snapshot.bodyVersion,
          scope: snapshot.scope,
          bodyChanged,
        },
        occurredAt: now,
      });
      if (bodyChanged) {
        await tx.memoryOutbox.enqueue({
          type: "memory.embedding.reindex.requested",
          version: 1,
          idempotencyKey: `memory.embedding.reindex:${snapshot.workspaceId}:${snapshot.id}:${snapshot.bodyVersion}:${snapshot.bodyHash}`,
          workspaceId: input.workspaceId,
          repositoryId: snapshot.repositoryId,
          aggregateId: snapshot.id,
          payload: {
            bodyHash: snapshot.bodyHash,
            bodyVersion: snapshot.bodyVersion,
          },
          occurredAt: now,
        });
      }
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
    if (error instanceof MemoryError && error.code === "memory_duplicate") {
      return { status: "noop", reason: "memory_duplicate" };
    }
    throw error;
  }
}
