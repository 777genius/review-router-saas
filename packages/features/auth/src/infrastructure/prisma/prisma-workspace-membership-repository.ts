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

    return {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      role: "owner",
      source: "personal",
    };
  }

  async ensureGitHubUserInstallationWorkspaceOwners(
    principal: AuthenticatedPrincipal,
  ): Promise<readonly WorkspaceMembership[]> {
    const installations = await this.prisma.gitHubInstallation.findMany({
      where: {
        accountType: "User",
        status: "active",
        accountLogin: {
          equals: principal.githubLogin,
          mode: "insensitive",
        },
      },
      select: {
        workspace: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
    });

    const memberships: WorkspaceMembership[] = [];
    for (const installation of installations) {
      const workspaceId = installation.workspace.id;
      await this.prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: principal.userId,
          },
        },
        update: {
          githubLogin: principal.githubLogin,
          role: "owner",
        },
        create: {
          workspaceId,
          userId: principal.userId,
          githubLogin: principal.githubLogin,
          role: "owner",
        },
      });

      memberships.push({
        workspaceId,
        workspaceSlug: installation.workspace.slug,
        role: "owner",
        source: "github_user_installation",
      });
    }

    return memberships;
  }
}
