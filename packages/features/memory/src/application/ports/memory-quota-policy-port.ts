export type MemoryWorkspaceQuota = {
  readonly activeItems: {
    readonly limit: number | null;
  };
  readonly pendingSuggestions: {
    readonly limit: number | null;
  };
};

export interface MemoryQuotaPolicyPort {
  getWorkspaceQuota(input: {
    readonly workspaceId: string;
  }): Promise<MemoryWorkspaceQuota>;
}

export const unlimitedMemoryWorkspaceQuota: MemoryWorkspaceQuota = {
  activeItems: { limit: null },
  pendingSuggestions: { limit: null },
};

export class UnlimitedMemoryQuotaPolicy implements MemoryQuotaPolicyPort {
  async getWorkspaceQuota(): Promise<MemoryWorkspaceQuota> {
    return unlimitedMemoryWorkspaceQuota;
  }
}
