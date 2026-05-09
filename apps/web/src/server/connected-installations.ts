import type { DashboardWorkspaceScope } from "./dashboard-mutations";
import { getPrisma } from "./prisma";

export async function countConnectedGitHubInstallations(
  workspaceScope: DashboardWorkspaceScope,
): Promise<number> {
  if (workspaceScope.kind === "none") {
    return 0;
  }

  return getPrisma().gitHubInstallation.count({
    where: {
      status: "active",
      ...(workspaceScope.kind === "workspace_ids"
        ? { workspaceId: { in: [...workspaceScope.workspaceIds] } }
        : {}),
    },
  });
}
