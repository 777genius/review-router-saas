import { NextResponse, type NextRequest } from "next/server";
import { PrismaAuditLogRepository } from "@reviewrouter/features-audit-log";
import {
  assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import { exportMemoryItems } from "@reviewrouter/features-memory";
import { assertDashboardWorkspaceAdminAllowed } from "../../../../../src/server/dashboard-mutations";
import {
  createDashboardMemoryDependencies,
  resolveDashboardMemoryActor,
} from "../../../../../src/server/dashboard-memory";
import { getPrisma } from "../../../../../src/server/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const workspaceId = request.nextUrl.searchParams.get("workspace")?.trim();
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_required" }, { status: 400 });
  }

  try {
    const prisma = getPrisma();
    const dashboardActor =
      await assertDashboardWorkspaceAdminAllowed(workspaceId);
    await assertWorkspaceFeatureEntitlement(
      {
        workspaceId,
        actor: dashboardActor.actor,
        feature: "repository_dashboard",
      },
      {
        entitlements: new PrismaEntitlementRepository(prisma),
        auditLog: new PrismaAuditLogRepository(prisma),
      },
    );
    const memoryActor = await resolveDashboardMemoryActor(
      {
        githubUserId: dashboardActor.githubUserId,
        githubLogin: dashboardActor.githubLogin,
      },
      prisma,
    );
    const result = await exportMemoryItems(
      { workspaceId, actor: memoryActor },
      createDashboardMemoryDependencies({
        prisma,
        actor: {
          githubUserId: dashboardActor.githubUserId,
          githubLogin: dashboardActor.githubLogin,
        },
      }),
    );
    if (result.status === "rejected") {
      return NextResponse.json(
        { error: result.reason, retryable: result.retryable },
        { status: result.retryable ? 503 : 403 },
      );
    }

    return new NextResponse(JSON.stringify(result.export, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${memoryExportFileName(
          workspaceId,
          result.export.manifest.createdAt,
        )}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeExportErrorCode(error) },
      { status: 403 },
    );
  }
}

function memoryExportFileName(workspaceId: string, createdAt: string): string {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTimestamp = createdAt.replace(/[^0-9A-Za-z]/g, "");
  return `reviewrouter-memory-${safeWorkspaceId}-${safeTimestamp}.json`;
}

function safeExportErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "memory_export_failed";
  if (error.message.startsWith("entitlement_")) return error.message;
  switch (error.message) {
    case "dashboard_auth_misconfigured":
    case "dashboard_admin_requires_sign_in":
      return error.message;
    default:
      return "memory_export_failed";
  }
}
