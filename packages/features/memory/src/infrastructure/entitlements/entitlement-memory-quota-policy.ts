import {
  freeBetaEntitlement,
  type EntitlementRepositoryPort,
} from "@reviewrouter/features-entitlements";
import type {
  MemoryQuotaPolicyPort,
  MemoryWorkspaceQuota,
} from "../../application/ports/memory-quota-policy-port";

export class EntitlementMemoryQuotaPolicy implements MemoryQuotaPolicyPort {
  constructor(private readonly entitlements: EntitlementRepositoryPort) {}

  async getWorkspaceQuota(input: {
    readonly workspaceId: string;
  }): Promise<MemoryWorkspaceQuota> {
    const entitlement =
      (await this.entitlements.findWorkspaceEntitlement(input.workspaceId)) ??
      freeBetaEntitlement(input.workspaceId);

    return {
      activeItems: {
        limit: entitlement.limits.maxActiveMemoryItemsPerWorkspace,
      },
      pendingSuggestions: {
        limit: entitlement.limits.maxPendingMemorySuggestionsPerWorkspace,
      },
    };
  }
}
