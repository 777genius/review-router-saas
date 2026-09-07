import { describe, expect, it, vi } from "vitest";
import { PrismaSupportDiagnosticsRepository } from "../infrastructure/prisma/prisma-support-diagnostics-repository";

describe("PrismaSupportDiagnosticsRepository", () => {
  it("projects latest workflow provisioning over contradictory legacy setup status", async () => {
    const workspaceFindUnique = vi.fn(async () => ({
      id: "workspace_1",
      name: "Acme",
      slug: "acme",
      installations: [],
      repositories: [
        {
          id: "repository_1",
          selected: true,
          archived: false,
          setupStatus: "needs_attention" as const,
          provisioning: [{ status: "configured" as const }],
          actionHealth: [],
        },
      ],
      provisioning: [{ status: "configured" as const }],
      auditEvents: [],
    }));
    const prisma = {
      workspace: { findUnique: workspaceFindUnique },
      outboxEvent: { findMany: vi.fn(async () => []) },
      memoryItem: { groupBy: vi.fn(async () => []) },
      memorySuggestion: { groupBy: vi.fn(async () => []) },
      memoryUsageEvent: { count: vi.fn(async () => 0) },
    };
    const repository = new PrismaSupportDiagnosticsRepository(prisma as never);

    await expect(
      repository.getWorkspaceDiagnosticsInput("workspace_1"),
    ).resolves.toEqual(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            id: "repository_1",
            setupStatus: "configured",
          }),
        ],
      }),
    );
    expect(workspaceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          repositories: {
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
          },
        }),
      }),
    );
  });
});
