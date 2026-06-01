import type { PrismaClient } from "@prisma/client";
import type {
  WorkspaceAccessGrant,
  WorkspaceAccessRepositoryPort,
} from "../../application/ports/workspace-access-repository-port";
import type { WorkspaceAccessRole } from "../../domain/workspace-access";

export class PrismaWorkspaceAccessRepository implements WorkspaceAccessRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findWorkspaceRoleByUserId(input: {
    readonly workspaceId: string;
    readonly userId: string;
  }): Promise<WorkspaceAccessRole | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
      select: { role: true },
    });

    return member?.role ?? null;
  }

  async findWorkspaceRoleByGitHubUserId(input: {
    readonly workspaceId: string;
    readonly githubUserId: string;
  }): Promise<WorkspaceAccessRole | null> {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { githubUserId: BigInt(input.githubUserId) },
      },
      select: { role: true },
    });

    return member?.role ?? null;
  }

  async listWorkspaceRolesByUserId(input: {
    readonly userId: string;
  }): Promise<readonly WorkspaceAccessGrant[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { userId: input.userId },
      orderBy: { updatedAt: "desc" },
      select: {
        workspaceId: true,
        role: true,
      },
    });

    return members.map((member) => ({
      workspaceId: member.workspaceId,
      role: member.role,
    }));
  }

  async listWorkspaceRolesByGitHubUserId(input: {
    readonly githubUserId: string;
  }): Promise<readonly WorkspaceAccessGrant[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: {
        user: { githubUserId: BigInt(input.githubUserId) },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        workspaceId: true,
        role: true,
      },
    });

    return members.map((member) => ({
      workspaceId: member.workspaceId,
      role: member.role,
    }));
  }
}
