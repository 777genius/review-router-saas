import {
  createMemoryBodyHash,
  normalizeMemoryBody,
} from "../../domain/memory-body";
import type { MemoryActor } from "../../domain/memory-actor";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemoryError } from "../../domain/memory-errors";
import { MemoryItem } from "../../domain/memory-item";
import { evaluateMemorySafety } from "../../domain/memory-safety-policy";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import { MemorySuggestion } from "../../domain/memory-suggestion";
import { expirePendingMemorySuggestionIfExpired } from "./expire-pending-memory-suggestions";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";
import { rejectIfActiveMemoryItemQuotaExceeded } from "./enforce-memory-quota";

export type ConfirmMemorySuggestionInput = {
  readonly workspaceId: string;
  readonly suggestionId: string;
  readonly actor: MemoryActor;
  readonly optionalEditedBody?: string;
  readonly optionalScope?: MemoryScope;
};

export async function confirmMemorySuggestion(
  input: ConfirmMemorySuggestionInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  const existing = await dependencies.memorySuggestions.findById({
    workspaceId: input.workspaceId,
    suggestionId: input.suggestionId,
  });
  if (!existing) {
    return { status: "rejected", reason: "memory_not_found" };
  }
  if (existing.status !== "pending") {
    return { status: "noop", reason: existing.status };
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

  const scope = input.optionalScope ?? existing.suggestedScope;
  const repositoryId = scope === "repository" ? existing.repositoryId : null;
  const userId = scope === "user_prefs" ? existing.userId : null;
  const permission = await dependencies.memoryPermissions.canConfirmMemory({
    workspaceId: input.workspaceId,
    repositoryId,
    userId,
    scope,
    actor: input.actor,
  });
  if (!permission.allowed) {
    return {
      status: "rejected",
      reason: permission.reason,
      retryable: permission.retryable,
    };
  }

  const body = normalizeMemoryBody(
    input.optionalEditedBody ?? existing.suggestedBody,
  );
  const safety = evaluateMemorySafety({
    body,
    scope,
    redactedSourceExcerpt: existing.source.redactedExcerpt,
  });
  if (safety.severity === "blocked") {
    return {
      status: "rejected",
      reason: safety.blockedReason ?? "memory_safety_blocked",
    };
  }

  const duplicate = await dependencies.memoryItems.findActiveByBodyHash({
    workspaceId: input.workspaceId,
    scope,
    repositoryId,
    userId,
    bodyHash: createMemoryBodyHash(body),
  });
  if (duplicate) {
    return { status: "noop", reason: "memory_duplicate", id: duplicate.id };
  }

  const quotaRejection = await rejectIfActiveMemoryItemQuotaExceeded(
    { workspaceId: input.workspaceId },
    dependencies,
  );
  if (quotaRejection) return quotaRejection;

  const item = MemoryItem.create({
    id: dependencies.memoryIds.newId("mem"),
    workspaceId: input.workspaceId,
    repositoryId,
    userId,
    scope,
    body,
    riskLevel: safety.riskLevel,
    confidence: 1,
    source: existing.source,
    policyVersion: existing.policyVersion,
    safetyPolicyVersion: existing.safetyPolicyVersion,
    actor: input.actor,
    now,
    originSuggestionId: existing.id,
  });
  const itemSnapshot = item.snapshot();
  const suggestion = MemorySuggestion.fromSnapshot(existing).confirm({
    actor: input.actor,
    memoryItemId: itemSnapshot.id,
    now,
  });
  const suggestionSnapshot = suggestion.snapshot();

  try {
    return await dependencies.memoryTransaction.run(async (tx) => {
      const transactionalQuotaRejection =
        await rejectIfActiveMemoryItemQuotaExceeded(
          { workspaceId: input.workspaceId },
          {
            memoryItems: tx.memoryItems,
            memoryQuotaPolicy: dependencies.memoryQuotaPolicy,
          },
        );
      if (transactionalQuotaRejection) return transactionalQuotaRejection;

      await tx.memoryItems.save(item);
      await tx.memorySuggestions.save(suggestion);
      await tx.memoryAudit.record({
        workspaceId: input.workspaceId,
        actor: memoryActorRef(input.actor),
        action: "memory.suggestion.confirmed",
        targetType: "memory_suggestion",
        targetId: existing.id,
        metadata: {
          memoryItemId: itemSnapshot.id,
          scope,
          bodyHash: itemSnapshot.bodyHash,
          editedBeforeConfirm: input.optionalEditedBody !== undefined,
        },
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.suggestion.confirmed",
        version: 1,
        idempotencyKey: `memory.suggestion.confirmed:${input.workspaceId}:${suggestionSnapshot.id}:${suggestionSnapshot.version}`,
        workspaceId: input.workspaceId,
        repositoryId,
        aggregateId: suggestionSnapshot.id,
        payload: {
          memoryItemId: itemSnapshot.id,
          bodyHash: itemSnapshot.bodyHash,
          scope,
        },
        occurredAt: now,
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.embedding.reindex.requested",
        version: 1,
        idempotencyKey: `memory.embedding.reindex:${input.workspaceId}:${itemSnapshot.id}:${itemSnapshot.bodyVersion}:${itemSnapshot.bodyHash}`,
        workspaceId: input.workspaceId,
        repositoryId,
        aggregateId: itemSnapshot.id,
        payload: {
          bodyHash: itemSnapshot.bodyHash,
          bodyVersion: itemSnapshot.bodyVersion,
        },
        occurredAt: now,
      });
      return {
        status: "created",
        id: itemSnapshot.id,
        version: itemSnapshot.version,
      };
    });
  } catch (error) {
    if (error instanceof MemoryError && error.code === "memory_duplicate") {
      return { status: "noop", reason: "memory_duplicate" };
    }
    throw error;
  }
}
