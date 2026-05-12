import { z } from "zod";

export const entitlementFeatureSchema = z.enum([
  "workflow_provisioning",
  "action_control_plane",
  "repository_dashboard",
  "audit_log",
  "advanced_org_policies",
  "cloud_review_execution",
  "compliance_exports",
]);

export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;

export const entitlementPlanSchema = z.enum(["free_beta", "pro", "enterprise"]);
export type EntitlementPlan = z.infer<typeof entitlementPlanSchema>;

export type WorkspaceEntitlement = {
  readonly workspaceId: string;
  readonly plan: EntitlementPlan;
  readonly status: "active" | "paused" | "past_due";
  readonly limits: {
    readonly maxRepositories: number;
    readonly maxWorkspacesPerUser: number;
    readonly maxActiveMemoryItemsPerWorkspace: number;
    readonly maxPendingMemorySuggestionsPerWorkspace: number;
  };
  readonly flags: Readonly<Record<EntitlementFeature, boolean>>;
};

export const freeBetaLimits = {
  maxRepositories: 250,
  maxWorkspacesPerUser: 3,
  maxActiveMemoryItemsPerWorkspace: 100,
  maxPendingMemorySuggestionsPerWorkspace: 50,
  setupPrAttemptsPerRepositoryPerHour: 5,
  installationSyncsPerInstallationPer15Minutes: 10,
  reviewConfigSavesPerWorkspacePerHour: 60,
  outboxRetriesPerWorkspacePerHour: 5,
} as const;

export const freeBetaEntitlement = (
  workspaceId: string,
): WorkspaceEntitlement => ({
  workspaceId,
  plan: "free_beta",
  status: "active",
  limits: {
    maxRepositories: freeBetaLimits.maxRepositories,
    maxWorkspacesPerUser: freeBetaLimits.maxWorkspacesPerUser,
    maxActiveMemoryItemsPerWorkspace:
      freeBetaLimits.maxActiveMemoryItemsPerWorkspace,
    maxPendingMemorySuggestionsPerWorkspace:
      freeBetaLimits.maxPendingMemorySuggestionsPerWorkspace,
  },
  flags: {
    workflow_provisioning: true,
    action_control_plane: true,
    repository_dashboard: true,
    audit_log: true,
    advanced_org_policies: false,
    cloud_review_execution: false,
    compliance_exports: false,
  },
});

export class EntitlementDeniedError extends Error {
  constructor(
    readonly feature: EntitlementFeature,
    readonly reason: string,
  ) {
    super(`entitlement_denied:${feature}:${reason}`);
    this.name = "EntitlementDeniedError";
  }
}

export function evaluateFeatureEntitlement(input: {
  readonly entitlement: WorkspaceEntitlement;
  readonly feature: EntitlementFeature;
}):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string } {
  if (input.entitlement.status !== "active") {
    return { allowed: false, reason: "workspace_entitlement_not_active" };
  }
  if (input.entitlement.flags[input.feature] !== true) {
    return { allowed: false, reason: "feature_not_enabled_for_plan" };
  }
  return { allowed: true };
}
