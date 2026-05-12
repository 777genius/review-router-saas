import type { MemoryUsageEventPort } from "../ports/memory-usage-event-port";
import type { MemoryIdGeneratorPort } from "../ports/memory-id-generator-port";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { Clock } from "@reviewrouter/shared";

export type RecordActionMemoryBundleUsageInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly bundleVersion: number;
  readonly items: readonly {
    readonly id: string;
    readonly scope: MemoryScope;
  }[];
};

export type RecordActionMemoryBundleUsageResult = {
  readonly status: "recorded" | "noop";
  readonly recordedCount: number;
};

export async function recordActionMemoryBundleUsage(
  input: RecordActionMemoryBundleUsageInput,
  dependencies: {
    readonly memoryUsageEvents: MemoryUsageEventPort;
    readonly memoryIds: MemoryIdGeneratorPort;
    readonly clock: Clock;
  },
): Promise<RecordActionMemoryBundleUsageResult> {
  const uniqueItems = dedupeBundleItems(input.items);
  if (uniqueItems.length === 0) {
    return { status: "noop", recordedCount: 0 };
  }

  const occurredAt = dependencies.clock.now();
  await dependencies.memoryUsageEvents.recordMany(
    uniqueItems.map((item) => ({
      id: dependencies.memoryIds.newId("mem_usage"),
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      memoryItemId: item.id,
      eventType: "action_bundle_exposed",
      bundleVersion: input.bundleVersion,
      metadata: {
        scope: item.scope,
        bundleItemCount: uniqueItems.length,
      },
      occurredAt,
    })),
  );

  return { status: "recorded", recordedCount: uniqueItems.length };
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
