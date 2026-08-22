import { describe, expect, it, vi } from "vitest";
import { provisionHostedPoolRepositoryWorkflow } from "../application/use-cases/provision-hosted-pool-workflow";
import type { WorkflowSetupGatewayInput } from "../application/ports/workflow-setup-gateway-port";

const target = {
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
  owner: "777genius",
  name: "example",
  fullName: "777genius/example",
  defaultBranch: "main",
  selected: true,
  archived: false,
  installationStatus: "active",
};

describe("provisionHostedPoolRepositoryWorkflow", () => {
  it("opens an idempotent setup PR with exact App-first T0 v2 and safe legacy deletions", async () => {
    const createOrUpdateSetupPullRequest = vi.fn(
      async (input: WorkflowSetupGatewayInput) => ({
        url: "https://github.com/777genius/example/pull/7",
        number: 7,
        branch: input.setupBranch,
        baseBranch: input.baseBranch,
      }),
    );
    const markSetupPullRequestOpen = vi.fn(async () => undefined);
    await provisionHostedPoolRepositoryWorkflow(
      {
        repositoryId: "repo-1",
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        apiUrl: "https://api.reviewrouter.test",
        providerInstanceId: "hosted-pool:repository:1228051727",
        bindingId: "binding-1",
        bindingRevision: 4,
      },
      {
        targets: {
          findWorkflowProvisioningTarget: vi.fn(async () => target),
        },
        setupGateway: { createOrUpdateSetupPullRequest },
        provisioning: {
          markSetupPullRequestOpen,
          markFailed: vi.fn(async () => undefined),
        },
      },
    );

    const request = createOrUpdateSetupPullRequest.mock.calls[0]?.[0];
    if (!request) throw new Error("setup request missing");
    expect(request).toMatchObject({
      baseBranch: "main",
      setupBranch: "reviewrouter/setup",
    });
    const hosted = request.workflowFiles.find(
      (file) =>
        file.path === ".github/workflows/reviewrouter-codex.yml" &&
        file.operation !== "delete",
    );
    if (!hosted || hosted.operation === "delete")
      throw new Error("hosted workflow missing");
    expect(hosted.content).toContain("  pull_request:");
    expect(hosted.content).not.toContain("pull_request_target");
    expect(hosted.content).toContain(
      `uses: 777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${"a".repeat(40)}`,
    );
    expect(hosted.content).toContain("workflow_schema_version: 2");
    expect(hosted.content).toContain('session_binding_id: "binding-1"');
    expect(hosted.content).toContain("session_binding_version: 4");
    expect(
      request.workflowFiles.filter((file) => file.operation === "delete"),
    ).toHaveLength(2);
    expect(markSetupPullRequestOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "setup_pr_open",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
      }),
    );
  });

  it("persists a safe failure while the binding remains pending", async () => {
    const markFailed = vi.fn(async () => undefined);
    await expect(
      provisionHostedPoolRepositoryWorkflow(
        {
          repositoryId: "repo-1",
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          apiUrl: "https://api.reviewrouter.test",
          providerInstanceId: "hosted-pool:repository:1228051727",
          bindingId: "binding-1",
          bindingRevision: 4,
        },
        {
          targets: {
            findWorkflowProvisioningTarget: vi.fn(async () => target),
          },
          setupGateway: {
            createOrUpdateSetupPullRequest: vi.fn(async () => {
              throw new Error("sensitive upstream detail");
            }),
          },
          provisioning: {
            markSetupPullRequestOpen: vi.fn(async () => undefined),
            markFailed,
          },
        },
      ),
    ).rejects.toThrow("sensitive upstream detail");
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "workflow_provisioning_failed",
      }),
    );
  });
});
