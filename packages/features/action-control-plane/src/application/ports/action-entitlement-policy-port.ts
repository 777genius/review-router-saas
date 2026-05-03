export interface ActionEntitlementPolicyPort {
  assertActionControlPlaneAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName?: string;
  }): Promise<void>;
}
