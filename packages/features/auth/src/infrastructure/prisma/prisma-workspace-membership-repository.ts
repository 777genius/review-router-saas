import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type {
  WorkspaceMembership,
  WorkspaceMembershipRepositoryPort,
} from "../../application/ports/workspace-membership-repository-port";

function personalWorkspaceSlug(principal: AuthenticatedPrincipal): string {
  if (principal.provider === "github") {
    return `gh-user-${principal.githubUserId ?? principal.externalUserId}`;
  }

  return `${principal.provider}-user-${principal.externalUserId}`;
}

export class PrismaWorkspaceMembershipRepository implements WorkspaceMembershipRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async ensurePersonalWorkspaceOwner(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMembership> {
    const githubLogin =
      principal.provider === "github" ? (principal.githubLogin ?? null) : null;
    const workspace = await this.prisma.workspace.upsert({
      where: { slug: personalWorkspaceSlug(principal) },
      update: { name: `@${principal.login}` },
      create: {
        slug: personalWorkspaceSlug(principal),
        name: `@${principal.login}`,
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
        githubLogin,
        role: "owner",
      },
      create: {
        workspaceId: workspace.id,
        userId: principal.userId,
        githubLogin,
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
    if (principal.provider !== "github" || !principal.githubLogin) {
      return [];
    }
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
