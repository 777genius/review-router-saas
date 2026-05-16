import type { Prisma, PrismaClient } from "@prisma/client";
import type { EntitlementRepositoryPort } from "../../application/ports/entitlement-repository-port";
import {
  entitlementFeatureSchema,
  entitlementPlanSchema,
  freeBetaEntitlement,
  type EntitlementFeature,
  type WorkspaceEntitlement,
} from "../../domain/entitlement";

export class PrismaEntitlementRepository implements EntitlementRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findWorkspaceEntitlement(
    workspaceId: string,
  ): Promise<WorkspaceEntitlement | null> {
    const record = await this.prisma.workspaceEntitlement.findUnique({
      where: { workspaceId },
    });
    if (!record) return null;

    const fallback = freeBetaEntitlement(workspaceId);
    return {
      workspaceId,
      plan: entitlementPlanSchema.catch("free_beta").parse(record.plan),
      status: toStatus(record.status),
      limits: toLimits(record.limits, fallback.limits),
      flags: toFlags(record.flags, fallback.flags),
    };
  }

  async upsertWorkspaceEntitlement(
    entitlement: WorkspaceEntitlement,
  ): Promise<void> {
    await this.prisma.workspaceEntitlement.upsert({
      where: { workspaceId: entitlement.workspaceId },
      update: {
        plan: entitlement.plan,
        status: entitlement.status,
        limits: entitlement.limits as unknown as Prisma.InputJsonValue,
        flags: entitlement.flags as unknown as Prisma.InputJsonValue,
      },
      create: {
        workspaceId: entitlement.workspaceId,
        plan: entitlement.plan,
        status: entitlement.status,
        limits: entitlement.limits as unknown as Prisma.InputJsonValue,
        flags: entitlement.flags as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

function toStatus(value: string): "active" | "paused" | "past_due" {
  if (value === "paused" || value === "past_due") return value;
  return "active";
}

function toLimits(
  value: Prisma.JsonValue,
  fallback: WorkspaceEntitlement["limits"],
): WorkspaceEntitlement["limits"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const candidate = value as Record<string, unknown>;
  return {
    maxRepositories:
      typeof candidate.maxRepositories === "number"
        ? candidate.maxRepositories
        : fallback.maxRepositories,
    maxWorkspacesPerUser:
      typeof candidate.maxWorkspacesPerUser === "number"
        ? candidate.maxWorkspacesPerUser
        : fallback.maxWorkspacesPerUser,
    maxActiveMemoryItemsPerWorkspace:
      typeof candidate.maxActiveMemoryItemsPerWorkspace === "number"
        ? candidate.maxActiveMemoryItemsPerWorkspace
        : fallback.maxActiveMemoryItemsPerWorkspace,
    maxPendingMemorySuggestionsPerWorkspace:
      typeof candidate.maxPendingMemorySuggestionsPerWorkspace === "number"
        ? candidate.maxPendingMemorySuggestionsPerWorkspace
        : fallback.maxPendingMemorySuggestionsPerWorkspace,
  };
}

function toFlags(
  value: Prisma.JsonValue,
  fallback: WorkspaceEntitlement["flags"],
): WorkspaceEntitlement["flags"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const candidate = value as Record<string, unknown>;
  return Object.fromEntries(
    entitlementFeatureSchema.options.map(
      (feature): [EntitlementFeature, boolean] => [
        feature,
        typeof candidate[feature] === "boolean"
          ? candidate[feature]
          : fallback[feature],
      ],
    ),
  ) as WorkspaceEntitlement["flags"];
}
