import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge: vi.fn(),
  assertDashboardRepositoryMutationAllowed: vi.fn(),
  assertWorkspaceFeatureEntitlement: vi.fn(),
  createGitHubAppInstallationOctokit: vi.fn(),
  getPrisma: vi.fn(),
  inspectSetupPullRequest: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@reviewrouter/features-audit-log", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
  PrismaAuditLogRepository: class PrismaAuditLogRepository {},
}));
vi.mock("@reviewrouter/features-entitlements", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@reviewrouter/features-entitlements")
  >()),
  assertWorkspaceFeatureEntitlement: mocks.assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository: class PrismaEntitlementRepository {},
}));
vi.mock("../../src/server/dashboard-mutations", () => ({
  asDashboardGitHubActor: vi.fn(),
  assertDashboardMutationAllowed: vi.fn(),
  assertDashboardRepositoryConfigMutationAllowed: vi.fn(),
  assertDashboardRepositoryMutationAllowed:
    mocks.assertDashboardRepositoryMutationAllowed,
  createGitHubAppInstallationOctokit: mocks.createGitHubAppInstallationOctokit,
  createGitHubUserOctokit: vi.fn(),
  dashboardMutationAccessAuditMetadata: () => ({}),
  getDashboardSignedInActor: vi.fn(),
  getDashboardWorkspaceScope: vi.fn(),
}));
vi.mock("../../src/server/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("../../src/server/setup-pull-request-status", () => ({
  inspectSetupPullRequest: mocks.inspectSetupPullRequest,
}));
vi.mock("../../src/server/codex-rotating-workflow-activation", () => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge:
    mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge,
}));
vi.mock("../../src/server/hosted-pool-workflow-activation", () => ({
  activateConfirmedHostedPoolBindingAfterWorkflowMerge: vi.fn(),
}));
vi.mock("../../src/server/workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { confirmSetupPullRequestMergedClientAction } from "./actions";

describe("dashboard setup PR recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertDashboardRepositoryMutationAllowed.mockResolvedValue({
      actor: "user:maintainer",
    });
    mocks.assertWorkspaceFeatureEntitlement.mockResolvedValue(undefined);
    mocks.createGitHubAppInstallationOctokit.mockResolvedValue({});
    mocks.inspectSetupPullRequest.mockResolvedValue({
      status: "merged",
      baseBranch: "main",
    });
    mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge.mockResolvedValue(
      undefined,
    );
    mocks.recordAuditEvent.mockResolvedValue(undefined);
  });

  it("loads failed provisioning deterministically and confirms a reopened merged PR", async () => {
    let provisioningStatus: "failed" | "configured" = "failed";
    const repositoryFindUnique = vi.fn(async () => ({
      id: "repository_1",
      workspaceId: "workspace_1",
      provider: "github",
      githubRepositoryId: 456n,
      owner: "acme",
      name: "widget",
      fullName: "acme/widget",
      visibility: "private",
      defaultBranch: "main",
      selected: true,
      archived: false,
      installation: { status: "active", githubInstallationId: 123n },
      provisioning: [
        {
          branch: "reviewrouter/setup",
          pullRequestUrl: "https://github.com/acme/widget/pull/7",
        },
      ],
    }));
    const workflowProvisioning = {
      findFirst: vi.fn(async () => ({
        id: "provisioning_1",
        status: provisioningStatus,
        branch: "reviewrouter/setup",
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
        errorMessage:
          provisioningStatus === "failed" ? "setup_pr_closed" : null,
      })),
      updateMany: vi.fn(async () => {
        provisioningStatus = "configured";
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ status: provisioningStatus })),
    };
    const transactionClient = { workflowProvisioning };
    mocks.getPrisma.mockReturnValue({
      repositoryConnection: { findUnique: repositoryFindUnique },
      hostedCodexRepositoryBinding: { findFirst: vi.fn(async () => null) },
      workflowProvisioning,
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    });
    const formData = new FormData();
    formData.set("repositoryId", "repository_1");
    formData.set("workspaceId", "workspace_1");

    await expect(
      confirmSetupPullRequestMergedClientAction(formData),
    ).resolves.toEqual({
      params: {
        notice: "setup_pr_merged",
        repository: "acme/widget",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

    expect(repositoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          provisioning: {
            where: {
              status: {
                in: ["setup_pr_open", "failed", "configured"],
              },
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { branch: true, pullRequestUrl: true },
          },
        }),
      }),
    );
    expect(workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);

    await expect(
      confirmSetupPullRequestMergedClientAction(formData),
    ).resolves.toMatchObject({ params: { notice: "setup_pr_merged" } });
    expect(workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
  });
});
