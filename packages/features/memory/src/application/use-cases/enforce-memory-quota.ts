import type { MemoryItemRepositoryPort } from "../ports/memory-item-repository-port";
import type { MemoryQuotaPolicyPort } from "../ports/memory-quota-policy-port";
import type { MemorySuggestionRepositoryPort } from "../ports/memory-suggestion-repository-port";
import type { MemoryMutationResult } from "./memory-use-case-types";

type ActiveMemoryQuotaDependencies = {
  readonly memoryItems: MemoryItemRepositoryPort;
  readonly memoryQuotaPolicy?: MemoryQuotaPolicyPort | undefined;
};

type PendingSuggestionQuotaDependencies = {
  readonly memorySuggestions: MemorySuggestionRepositoryPort;
  readonly memoryQuotaPolicy?: MemoryQuotaPolicyPort | undefined;
};

export async function rejectIfActiveMemoryItemQuotaExceeded(
  input: { readonly workspaceId: string },
  dependencies: ActiveMemoryQuotaDependencies,
): Promise<MemoryMutationResult | null> {
  const limit = await resolveQuotaLimit(
    input.workspaceId,
    dependencies.memoryQuotaPolicy,
    "activeItems",
  );
  if (limit === null) return null;

  const activeCount = await dependencies.memoryItems.countActiveForWorkspace({
    workspaceId: input.workspaceId,
  });
  if (activeCount < limit) return null;

  return {
    status: "rejected",
    reason: "memory_active_item_quota_exceeded",
    retryable: false,
  };
}

export async function rejectIfPendingMemorySuggestionQuotaExceeded(
  input: { readonly workspaceId: string; readonly now: Date },
  dependencies: PendingSuggestionQuotaDependencies,
): Promise<MemoryMutationResult | null> {
  const limit = await resolveQuotaLimit(
    input.workspaceId,
    dependencies.memoryQuotaPolicy,
    "pendingSuggestions",
  );
  if (limit === null) return null;

  const pendingCount =
    await dependencies.memorySuggestions.countPendingForWorkspace({
      workspaceId: input.workspaceId,
      notExpiredAt: input.now,
    });
  if (pendingCount < limit) return null;

  return {
    status: "rejected",
    reason: "memory_pending_suggestion_quota_exceeded",
    retryable: false,
  };
}

async function resolveQuotaLimit(
  workspaceId: string,
  policy: MemoryQuotaPolicyPort | undefined,
  key: "activeItems" | "pendingSuggestions",
): Promise<number | null> {
  if (!policy) return null;
  const quota = await policy.getWorkspaceQuota({ workspaceId });
  return normalizeLimit(quota[key].limit);
}

function normalizeLimit(limit: number | null): number | null {
  if (limit === null) return null;
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, Math.floor(limit));
}
