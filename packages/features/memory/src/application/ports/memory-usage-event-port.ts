import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemoryUsageRuntimeContext } from "../../domain/memory-usage-event";

export type MemoryUsageEventInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly memoryItemId: string;
  readonly eventType: "action_bundle_exposed";
  readonly bundleVersion: number;
  readonly dedupeKey: string | null;
  readonly metadata: {
    readonly scope: MemoryScope;
    readonly bundleItemCount: number;
    readonly githubRunId: MemoryUsageRuntimeContext["githubRunId"];
    readonly githubRunAttempt: MemoryUsageRuntimeContext["githubRunAttempt"];
    readonly eventName: MemoryUsageRuntimeContext["eventName"];
  };
  readonly occurredAt: Date;
};

export type MemoryUsageEventWriteResult = {
  readonly recordedCount: number;
  readonly duplicateCount: number;
};

export interface MemoryUsageEventPort {
  recordMany(
    events: readonly MemoryUsageEventInput[],
  ): Promise<MemoryUsageEventWriteResult>;
}
