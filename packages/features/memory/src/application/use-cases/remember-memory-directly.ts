import {
  createMemoryBodyHash,
  normalizeMemoryBody,
} from "../../domain/memory-body";
import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemoryItem } from "../../domain/memory-item";
import { evaluateMemorySafety } from "../../domain/memory-safety-policy";
import {
  assertValidMemoryScope,
  type MemoryScope,
} from "../../domain/memory-scope-policy";
import type { MemorySource } from "../../domain/memory-source";
import { MemoryError } from "../../domain/memory-errors";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type RememberMemoryDirectlyInput = {
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly source: MemorySource;
  readonly actor: MemoryActor;
  readonly policyVersion?: number;
  readonly safetyPolicyVersion?: number;
  readonly idempotencyKey?: string;
};

export async function rememberMemoryDirectly(
  input: RememberMemoryDirectlyInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  assertValidMemoryScope(input);
  const permission = await dependencies.memoryPermissions.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    userId: input.userId,
    scope: input.scope,
    actor: input.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }

  const safety = evaluateMemorySafety({
    body: input.body,
    scope: input.scope,
    redactedSourceExcerpt: input.source.redactedExcerpt,
  });
  if (safety.severity === "blocked") {
    return {
      status: "rejected",
      reason: safety.blockedReason ?? "memory_safety_blocked",
    };
  }

  const body = normalizeMemoryBody(safety.redactedBody);
  const bodyHash = createMemoryBodyHash(body);
  const duplicate = await dependencies.memoryItems.findActiveByBodyHash({
    workspaceId: input.workspaceId,
    scope: input.scope,
    repositoryId: input.repositoryId,
    userId: input.userId,
    bodyHash,
  });
  if (duplicate) {
    return { status: "noop", reason: "memory_duplicate", id: duplicate.id };
  }

  const now = dependencies.clock.now();
  const item = MemoryItem.create({
    id: dependencies.memoryIds.newId("mem"),
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    userId: input.userId,
    scope: input.scope,
    body,
    riskLevel: safety.riskLevel,
    confidence: 1,
    source: input.source,
    policyVersion: input.policyVersion ?? 1,
    safetyPolicyVersion: input.safetyPolicyVersion ?? 1,
    actor: input.actor,
    now,
  });
  const snapshot = item.snapshot();

  try {
    return await dependencies.memoryTransaction.run(async (tx) => {
      await tx.memoryItems.save(item);
      await tx.memoryAudit.record({
        workspaceId: input.workspaceId,
        actor: memoryActorRef(input.actor),
        action: "memory.item.created",
        targetType: "memory_item",
        targetId: snapshot.id,
        metadata: {
          scope: snapshot.scope,
          bodyHash: snapshot.bodyHash,
          sourceType: input.source.type,
        },
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.item.created",
        version: 1,
        idempotencyKey:
          input.idempotencyKey ??
          `memory.item.created:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          bodyHash: snapshot.bodyHash,
          bodyVersion: snapshot.bodyVersion,
          scope: snapshot.scope,
        },
        occurredAt: now,
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.embedding.reindex.requested",
        version: 1,
        idempotencyKey: `memory.embedding.reindex:${snapshot.workspaceId}:${snapshot.id}:${snapshot.bodyVersion}:${snapshot.bodyHash}`,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          bodyHash: snapshot.bodyHash,
          bodyVersion: snapshot.bodyVersion,
        },
        occurredAt: now,
      });
      return {
        status: "created",
        id: snapshot.id,
        version: snapshot.version,
      };
    });
  } catch (error) {
    if (error instanceof MemoryError && error.code === "memory_duplicate") {
      return { status: "noop", reason: "memory_duplicate" };
    }
    throw error;
  }
}
