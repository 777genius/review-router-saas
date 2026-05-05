import type { PrismaClient } from "@prisma/client";
import type {
  InstallationWorkspaceOwnerGrant,
  InstallationWorkspaceOwnerGrantPort,
} from "../../application/ports/installation-workspace-owner-grant-port";

export class PrismaInstallationWorkspaceOwnerGrant implements InstallationWorkspaceOwnerGrantPort {
  constructor(private readonly prisma: PrismaClient) {}

  async grantInstallationActorOwner(
    grant: InstallationWorkspaceOwnerGrant,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const installation = await tx.gitHubInstallation.findUnique({
        where: {
          githubInstallationId: BigInt(grant.githubInstallationId),
        },
        select: {
          workspaceId: true,
        },
      });
      if (!installation) {
        throw new Error("installation_not_found_for_owner_grant");
      }

      const user = await tx.user.upsert({
        where: { githubUserId: BigInt(grant.githubUserId) },
        update: {
          githubLogin: grant.githubLogin,
          avatarUrl: grant.avatarUrl ?? null,
        },
        create: {
          githubUserId: BigInt(grant.githubUserId),
          githubLogin: grant.githubLogin,
          primaryEmail: null,
          avatarUrl: grant.avatarUrl ?? null,
        },
      });

      const existingByUser = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: installation.workspaceId,
            userId: user.id,
          },
        },
        select: { id: true },
      });
      const existingByLogin = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_githubLogin: {
            workspaceId: installation.workspaceId,
            githubLogin: grant.githubLogin,
          },
        },
        select: { id: true },
      });

      if (
        existingByUser &&
        existingByLogin &&
        existingByUser.id !== existingByLogin.id
      ) {
        await tx.workspaceMember.delete({
          where: { id: existingByLogin.id },
        });
      }

      if (existingByUser) {
        await tx.workspaceMember.update({
          where: { id: existingByUser.id },
          data: {
            githubLogin: grant.githubLogin,
            role: "owner",
          },
        });
        return;
      }

      if (existingByLogin) {
        await tx.workspaceMember.update({
          where: { id: existingByLogin.id },
          data: {
            userId: user.id,
            role: "owner",
          },
        });
        return;
      }

      await tx.workspaceMember.create({
        data: {
          workspaceId: installation.workspaceId,
          userId: user.id,
          githubLogin: grant.githubLogin,
          role: "owner",
        },
      });
    });
  }
}
