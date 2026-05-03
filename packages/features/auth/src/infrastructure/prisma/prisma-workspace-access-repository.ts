import type { PrismaClient } from "@prisma/client";
import type { WorkspaceAccessRepositoryPort } from "../../application/ports/workspace-access-repository-port";
import type { WorkspaceAccessRole } from "../../domain/workspace-access";

export class PrismaWorkspaceAccessRepository implements WorkspaceAccessRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

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
}
