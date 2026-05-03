import {
  EntitlementDeniedError,
  evaluateFeatureEntitlement,
  freeBetaEntitlement,
  type EntitlementFeature,
} from "../../domain/entitlement";
import type { EntitlementRepositoryPort } from "../ports/entitlement-repository-port";
import {
  recordAuditEvent,
  type AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";

export async function assertWorkspaceFeatureEntitlement(
  input: {
    readonly workspaceId: string;
    readonly feature: EntitlementFeature;
    readonly actor: string;
  },
  dependencies: {
    readonly entitlements: EntitlementRepositoryPort;
    readonly auditLog?: AuditLogRepositoryPort;
  },
): Promise<void> {
  const entitlement =
    (await dependencies.entitlements.findWorkspaceEntitlement(
      input.workspaceId,
    )) ?? freeBetaEntitlement(input.workspaceId);
  const result = evaluateFeatureEntitlement({
    entitlement,
    feature: input.feature,
  });
  if (result.allowed) {
    return;
  }

  if (dependencies.auditLog) {
    await recordAuditEvent(
      {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: "entitlement.feature_denied",
        targetType: "feature",
        targetId: input.feature,
        metadata: {
          plan: entitlement.plan,
          reason: result.reason,
        },
      },
      { auditLog: dependencies.auditLog },
    );
  }

  throw new EntitlementDeniedError(input.feature, result.reason);
}
