import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowProvisioningQuery } from "../infrastructure/prisma/prisma-workflow-provisioning-query";

describe("PrismaWorkflowProvisioningQuery", () => {
  it("breaks equal-updatedAt ties by id and projects the first row", async () => {
    const updatedAt = new Date("2026-08-30T08:00:00.000Z");
    const findMany = vi.fn(async () => [
      provisioningRow({ id: "provisioning_z", status: "failed", updatedAt }),
      provisioningRow({
        id: "provisioning_a",
        status: "configured",
        updatedAt,
      }),
    ]);
    const query = new PrismaWorkflowProvisioningQuery({
      workflowProvisioning: { findMany },
    } as never);

    await expect(
      query.listLatestForRepositories({
        workspaceId: "workspace_1",
        repositoryIds: ["repository_1"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        repositoryId: "repository_1",
        status: "failed",
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { repositoryId: "asc" },
          { updatedAt: "desc" },
          { id: "desc" },
        ],
      }),
    );
  });
});

function provisioningRow(input: {
  readonly id: string;
  readonly status: "configured" | "failed";
  readonly updatedAt: Date;
}) {
  return {
    id: input.id,
    workspaceId: "workspace_1",
    repositoryId: "repository_1",
    status: input.status,
    branch: "reviewrouter/setup",
    workflowPath: ".github/workflows/reviewrouter.yml",
    workflowStyle: "reusable",
    actionVersion: "777genius/review-router@v1",
    pullRequestUrl: "https://github.com/acme/widget/pull/7",
    errorMessage: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
}
