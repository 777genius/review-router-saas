import type { MemoryUsageEventPort } from "../ports/memory-usage-event-port";
import type { MemoryIdGeneratorPort } from "../ports/memory-id-generator-port";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { Clock } from "@reviewrouter/shared";
import type { MemoryItemRepositoryPort } from "../ports/memory-item-repository-port";
import {
  createMemoryUsageDedupeKey,
  type MemoryUsageRuntimeContext,
} from "../../domain/memory-usage-event";

export type RecordActionMemoryBundleUsageInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly runtimeContext: MemoryUsageRuntimeContext;
  readonly bundleVersion: number;
  readonly items: readonly {
    readonly id: string;
    readonly scope: MemoryScope;
  }[];
};

export type RecordActionMemoryBundleUsageResult = {
  readonly status: "recorded" | "noop";
  readonly exposedItemCount: number;
  readonly usageEventRecordedCount: number;
  readonly duplicateUsageEventCount: number;
  readonly markedUsedCount: number;
};

export async function recordActionMemoryBundleUsage(
  input: RecordActionMemoryBundleUsageInput,
  dependencies: {
    readonly memoryUsageEvents: MemoryUsageEventPort;
    readonly memoryItems: Pick<MemoryItemRepositoryPort, "markActiveItemsUsed">;
    readonly memoryIds: MemoryIdGeneratorPort;
    readonly clock: Clock;
  },
): Promise<RecordActionMemoryBundleUsageResult> {
  const uniqueItems = dedupeBundleItems(input.items);
  if (uniqueItems.length === 0) {
    return {
      status: "noop",
      exposedItemCount: 0,
      usageEventRecordedCount: 0,
      duplicateUsageEventCount: 0,
      markedUsedCount: 0,
    };
  }

  const occurredAt = dependencies.clock.now();
  const usageEventResult = await dependencies.memoryUsageEvents.recordMany(
    uniqueItems.map((item) => ({
      id: dependencies.memoryIds.newId("mem_usage"),
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      memoryItemId: item.id,
      eventType: "action_bundle_exposed",
      bundleVersion: input.bundleVersion,
      dedupeKey: createMemoryUsageDedupeKey({
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        memoryItemId: item.id,
        eventType: "action_bundle_exposed",
        bundleVersion: input.bundleVersion,
        runtimeContext: input.runtimeContext,
      }),
      metadata: {
        scope: item.scope,
        bundleItemCount: uniqueItems.length,
        githubRunId: input.runtimeContext.githubRunId,
        githubRunAttempt: input.runtimeContext.githubRunAttempt,
        eventName: input.runtimeContext.eventName,
      },
      occurredAt,
    })),
  );
  const markResult = await dependencies.memoryItems.markActiveItemsUsed({
    workspaceId: input.workspaceId,
    itemIds: uniqueItems.map((item) => item.id),
    usedAt: occurredAt,
  });

  return {
    status: "recorded",
    exposedItemCount: uniqueItems.length,
    usageEventRecordedCount: usageEventResult.recordedCount,
    duplicateUsageEventCount: usageEventResult.duplicateCount,
    markedUsedCount: markResult.updatedCount,
  };
}

function dedupeBundleItems(
  items: RecordActionMemoryBundleUsageInput["items"],
): RecordActionMemoryBundleUsageInput["items"] {
  const seen = new Set<string>();
  const uniqueItems = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    uniqueItems.push(item);
  }
  return uniqueItems;
}
