import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type {
  WorkspaceMembership,
  WorkspaceMembershipRepositoryPort,
} from "../../application/ports/workspace-membership-repository-port";

function personalWorkspaceSlug(principal: AuthenticatedPrincipal): string {
  return `gh-user-${principal.githubUserId}`;
}

export class PrismaWorkspaceMembershipRepository implements WorkspaceMembershipRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async ensurePersonalWorkspaceOwner(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMembership> {
    const workspace = await this.prisma.workspace.upsert({
      where: { slug: personalWorkspaceSlug(principal) },
      update: { name: `@${principal.githubLogin}` },
      create: {
        slug: personalWorkspaceSlug(principal),
        name: `@${principal.githubLogin}`,
      },
    });

    await this.prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: workspace.id,
          userId: principal.userId,
        },
      },
      update: {
        githubLogin: principal.githubLogin,
        role: "owner",
      },
      create: {
        workspaceId: workspace.id,
        userId: principal.userId,
        githubLogin: principal.githubLogin,
        role: "owner",
      },
    });

    return { workspaceId: workspace.id, role: "owner" };
  }
}
