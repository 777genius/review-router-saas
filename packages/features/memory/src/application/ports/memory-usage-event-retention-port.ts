export type MemoryUsageEventRetentionScope =
  | {
      readonly kind: "workspace";
      readonly workspaceId: string;
    }
  | {
      readonly kind: "all_workspaces";
    };

export type MemoryUsageEventRetentionPruneInput = {
  readonly scope: MemoryUsageEventRetentionScope;
  readonly occurredBefore: Date;
  readonly limit: number;
};

export type MemoryUsageEventRetentionPruneResult = {
  readonly deletedCount: number;
};

export interface MemoryUsageEventRetentionPort {
  pruneBefore(
    input: MemoryUsageEventRetentionPruneInput,
  ): Promise<MemoryUsageEventRetentionPruneResult>;
}
