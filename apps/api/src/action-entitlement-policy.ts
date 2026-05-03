import {
  assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import type { ActionEntitlementPolicyPort } from "@reviewrouter/features-action-control-plane";
import type { PrismaClient } from "@reviewrouter/platform-db";

export class PrismaActionEntitlementPolicy implements ActionEntitlementPolicyPort {
  constructor(private readonly prisma: PrismaClient) {}

  async assertActionControlPlaneAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName?: string;
  }): Promise<void> {
    await assertWorkspaceFeatureEntitlement(
      {
        workspaceId: input.workspaceId,
        feature: "action_control_plane",
        actor: `github-actions:${input.repositoryFullName ?? input.repositoryId}`,
      },
      { entitlements: new PrismaEntitlementRepository(this.prisma) },
    );
  }
}
