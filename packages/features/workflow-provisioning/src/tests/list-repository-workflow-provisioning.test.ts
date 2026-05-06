import { describe, expect, it } from "vitest";
import type {
  RepositoryWorkflowProvisioningSummary,
  WorkflowProvisioningQueryPort,
} from "../application/ports/workflow-provisioning-query-port";
import { listRepositoryWorkflowProvisioning } from "../application/use-cases/list-repository-workflow-provisioning";

class CapturingProvisioningQuery implements WorkflowProvisioningQueryPort {
  public input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  } | null = null;

  constructor(
    private readonly summaries: readonly RepositoryWorkflowProvisioningSummary[],
  ) {}

  async listLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }): Promise<readonly RepositoryWorkflowProvisioningSummary[]> {
    this.input = input;
    return this.summaries;
  }
}

describe("listRepositoryWorkflowProvisioning", () => {
  it("deduplicates repository ids before querying the read port", async () => {
    const query = new CapturingProvisioningQuery([
      {
        repositoryId: "repo_1",
        status: "setup_pr_open",
        branch: "reviewrouter/setup",
        workflowPath: ".github/workflows/reviewrouter.yml",
        workflowStyle: "reusable",
        actionVersion: "777genius/review-router@v1",
        pullRequestUrl: "https://github.com/777genius/example/pull/1",
        errorMessage: null,
        updatedAt: new Date("2026-05-03T12:00:00.000Z"),
      },
    ]);

    await expect(
      listRepositoryWorkflowProvisioning(
        {
          workspaceId: "workspace_1",
          repositoryIds: ["repo_1", "repo_1", "repo_2"],
        },
        { provisioning: query },
      ),
    ).resolves.toHaveLength(1);

    expect(query.input).toEqual({
      workspaceId: "workspace_1",
      repositoryIds: ["repo_1", "repo_2"],
    });
  });

  it("does not query storage when no repositories are visible", async () => {
    const query = new CapturingProvisioningQuery([]);

    await expect(
      listRepositoryWorkflowProvisioning(
        { workspaceId: "workspace_1", repositoryIds: [] },
        { provisioning: query },
      ),
    ).resolves.toEqual([]);

    expect(query.input).toBeNull();
  });
});
