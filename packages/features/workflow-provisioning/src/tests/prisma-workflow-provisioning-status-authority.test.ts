import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";

const identity = {
  repositoryId: "repository_1",
  setupBranch: "reviewrouter/setup",
  pullRequestNumber: 7,
} as const;

describe("PrismaWorkflowProvisioningStatusAuthority", () => {
  it("transitions a matching failed row to configured without filtering by status", async () => {
    const { authority, workflowProvisioning } = createAuthority([
      { id: "provisioning_failed" },
    ]);

    await expect(authority.markConfigured(identity)).resolves.toBe(true);

    expect(workflowProvisioning.findMany).toHaveBeenCalledWith({
      where: {
        repositoryId: "repository_1",
        OR: [
          { branch: "reviewrouter/setup" },
          { pullRequestUrl: { endsWith: "/pull/7" } },
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true },
    });
    expect(workflowProvisioning.update).toHaveBeenCalledWith({
      where: { id: "provisioning_failed" },
      data: { status: "configured", errorMessage: null },
    });
  });

  it("keeps repeated configured transitions idempotent", async () => {
    const { authority, workflowProvisioning } = createAuthority([
      { id: "provisioning_configured" },
    ]);

    await authority.markConfigured(identity);
    await authority.markConfigured(identity);

    expect(workflowProvisioning.update).toHaveBeenCalledTimes(2);
    expect(workflowProvisioning.update).toHaveBeenLastCalledWith({
      where: { id: "provisioning_configured" },
      data: { status: "configured", errorMessage: null },
    });
  });

  it("fails closed when dashboard confirmation expects a missing row", async () => {
    const { authority, workflowProvisioning } = createAuthority([]);

    await expect(authority.assertConfigured(identity)).rejects.toThrow(
      "workflow_provisioning_match_not_found",
    );
    expect(workflowProvisioning.update).not.toHaveBeenCalled();
  });

  it("fails closed when pull request evidence matches multiple rows", async () => {
    const { authority, workflowProvisioning } = createAuthority([
      { id: "provisioning_1" },
      { id: "provisioning_2" },
    ]);

    await expect(authority.markConfigured(identity)).rejects.toThrow(
      "workflow_provisioning_match_ambiguous",
    );
    expect(workflowProvisioning.update).not.toHaveBeenCalled();
  });
});

function createAuthority(rows: readonly { readonly id: string }[]) {
  const workflowProvisioning = {
    findMany: vi.fn(async () => rows),
    update: vi.fn(async () => undefined),
  };
  const transactionClient = { workflowProvisioning };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
    ),
  };

  return {
    authority: new PrismaWorkflowProvisioningStatusAuthority(prisma as never),
    workflowProvisioning,
  };
}
