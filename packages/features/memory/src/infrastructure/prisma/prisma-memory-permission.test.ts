import { describe, expect, it, vi } from "vitest";
import { PrismaMemoryPermission } from "./prisma-memory-permission";

describe("PrismaMemoryPermission", () => {
  it("authorizes workspace_user actors through WorkspaceMember.userId", async () => {
    const prisma = {
      workspaceMember: {
        findFirst: vi.fn().mockResolvedValue({ role: "admin" }),
      },
    };
    const permission = new PrismaMemoryPermission(prisma as never);

    await expect(
      permission.canConfirmMemory({
        workspaceId: "workspace_1",
        repositoryId: null,
        userId: null,
        scope: "workspace",
        actor: {
          kind: "workspace_user",
          id: "user_gitlab",
          githubUserId: null,
          login: "gitlab-maintainer",
        },
      }),
    ).resolves.toEqual({ allowed: true });

    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        OR: [{ userId: "user_gitlab" }],
      },
      select: { role: true },
    });
  });

  it("does not treat workspace_user login as a GitHub local admin override", async () => {
    const prisma = {
      workspaceMember: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const permission = new PrismaMemoryPermission(prisma as never, {
      localAdminGithubLogins: ["gitlab-maintainer"],
    });

    await expect(
      permission.canConfirmMemory({
        workspaceId: "workspace_1",
        repositoryId: null,
        userId: null,
        scope: "workspace",
        actor: {
          kind: "workspace_user",
          id: "user_gitlab",
          githubUserId: null,
          login: "gitlab-maintainer",
        },
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "not_workspace_admin",
      retryable: false,
    });
  });
});
