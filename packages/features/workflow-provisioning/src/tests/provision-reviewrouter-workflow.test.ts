import { describe, expect, it } from "vitest";
import type {
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
} from "../application/ports/workflow-setup-gateway-port";
import type {
  WorkflowProvisioningRecord,
  WorkflowProvisioningRepositoryPort,
} from "../application/ports/workflow-provisioning-repository-port";
import { provisionReviewRouterWorkflow } from "../application/use-cases/provision-reviewrouter-workflow";

class CapturingSetupGateway implements WorkflowSetupGatewayPort {
  public input: WorkflowSetupGatewayInput | null = null;

  async createOrUpdateSetupPullRequest(input: WorkflowSetupGatewayInput) {
    this.input = input;
    return {
      url: "https://github.com/777genius/example/pull/1",
      number: 1,
      branch: input.setupBranch,
    };
  }
}

class CapturingProvisioningRepository implements WorkflowProvisioningRepositoryPort {
  public opened: WorkflowProvisioningRecord | null = null;
  public failed: WorkflowProvisioningRecord | null = null;

  async markSetupPullRequestOpen(
    record: WorkflowProvisioningRecord,
  ): Promise<void> {
    this.opened = record;
  }

  async markFailed(record: WorkflowProvisioningRecord): Promise<void> {
    this.failed = record;
  }
}

describe("provisionReviewRouterWorkflow", () => {
  it("renders workflow and records setup PR state", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();

    const pullRequest = await provisionReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      },
      { setupGateway: gateway, provisioning },
    );

    expect(pullRequest.url).toContain("/pull/1");
    expect(gateway.input?.workflowPath).toBe(
      ".github/workflows/reviewrouter.yml",
    );
    expect(gateway.input?.workflowYaml).toContain("name: ReviewRouter");
    expect(provisioning.opened).toMatchObject({
      status: "setup_pr_open",
      branch: "reviewrouter/setup",
      actionVersion: "777genius/review-router@v1",
    });
  });
});
