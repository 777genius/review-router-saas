import { describe, expect, it, vi } from "vitest";
import { PrismaRepositoryHealthRepository } from "../infrastructure/prisma/prisma-repository-health-repository";

describe("PrismaRepositoryHealthRepository", () => {
  it("projects latest workflow provisioning over contradictory legacy setup status", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "repository_1",
        owner: "acme",
        name: "widget",
        fullName: "acme/widget",
        defaultBranch: "main",
        setupStatus: "configured" as const,
        provisioning: [{ status: "failed" as const }],
        installation: { githubInstallationId: 123n },
        actionHealth: [],
      },
    ]);
    const repository = new PrismaRepositoryHealthRepository({
      repositoryConnection: { findMany },
    } as never);

    await expect(
      repository.listWorkspaceHealthInputs("workspace_1"),
    ).resolves.toEqual([
      expect.objectContaining({
        repositoryId: "repository_1",
        setupStatus: "needs_attention",
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          provisioning: {
            where: {
              workspaceId: "workspace_1",
              repository: { workspaceId: "workspace_1" },
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { status: true },
          },
        }),
      }),
    );
  });
});
