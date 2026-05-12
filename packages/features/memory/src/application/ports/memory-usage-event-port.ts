import type { MemoryScope } from "../../domain/memory-scope-policy";

export type MemoryUsageEventInput = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly memoryItemId: string;
  readonly eventType: "action_bundle_exposed";
  readonly bundleVersion: number;
  readonly metadata: {
    readonly scope: MemoryScope;
    readonly bundleItemCount: number;
  };
  readonly occurredAt: Date;
};

export interface MemoryUsageEventPort {
  recordMany(events: readonly MemoryUsageEventInput[]): Promise<void>;
}
