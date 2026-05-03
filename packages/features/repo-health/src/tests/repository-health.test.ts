import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { RepositoryHealthRepositoryPort } from "../application/ports/repository-health-repository-port";
import type {
  RepositoryWorkflowCheck,
  RepositoryWorkflowProbeInput,
  RepositoryWorkflowProbePort,
} from "../application/ports/repository-workflow-probe-port";
import { listWorkspaceRepositoryHealth } from "../application/use-cases/list-workspace-repository-health";
import {
  evaluateRepositoryHealth,
  type RepositoryHealthInput,
} from "../domain/repository-health";
import { OctokitRepositoryWorkflowProbe } from "../infrastructure/github/octokit-repository-workflow-probe";

describe("repository health", () => {
  it("detects setup and workflow version states", () => {
    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "not_configured",
        expectedActionRef: "777genius/review-router@v1",
      }),
    ).toMatchObject({ status: "missing_workflow" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowYaml: "uses: 777genius/review-router@v0",
      }),
    ).toMatchObject({ status: "version_mismatch" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowCheck: { status: "missing" },
      }),
    ).toMatchObject({
      status: "missing_workflow",
      summary: "ReviewRouter workflow file is missing from the default branch",
    });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowCheck: {
          status: "present",
          expectedActionRefFound: false,
        },
      }),
    ).toMatchObject({ status: "version_mismatch" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowCheck: {
          status: "unavailable",
          reason: "github_permission_denied",
        },
      }),
    ).toMatchObject({ status: "workflow_check_unavailable" });
  });

  it("surfaces provider setup and runtime health", () => {
    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        latestProviderSetupState: "missing",
      }),
    ).toMatchObject({ status: "provider_needs_setup" });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "configured",
        expectedActionRef: "777genius/review-router@v1",
        latestProviderSetupState: "configured",
        latestProviderHealth: "failed",
      }),
    ).toMatchObject({ status: "provider_unhealthy" });
  });

  it("enriches configured repositories with workflow probe metadata", async () => {
    const repositories = new InMemoryHealthRepository([
      healthInput("repo_1", "configured"),
      healthInput("repo_2", "configured"),
      healthInput("repo_3", "not_configured"),
    ]);
    const probe = new CapturingWorkflowProbe({
      repo_1: { status: "present", expectedActionRefFound: true },
      repo_2: { status: "missing" },
    });

    const health = await listWorkspaceRepositoryHealth(
      {
        workspaceId: "workspace_1",
        expectedActionRef: "777genius/review-router@v1",
        workflowProbeMaxRepositories: 1,
      },
      { repositories, workflowProbe: probe },
    );

    expect(probe.inputs).toHaveLength(1);
    expect(probe.inputs[0]).toMatchObject({
      githubInstallationId: "129",
      owner: "777genius",
      name: "repo-1",
      workflowPath: ".github/workflows/reviewrouter.yml",
    });
    expect(health).toEqual([
      expect.objectContaining({ repositoryId: "repo_1", status: "healthy" }),
      expect.objectContaining({ repositoryId: "repo_2", status: "healthy" }),
      expect.objectContaining({
        repositoryId: "repo_3",
        status: "missing_workflow",
      }),
    ]);
  });

  it("keeps repository health available when workflow probing fails", async () => {
    const repositories = new InMemoryHealthRepository([
      healthInput("repo_1", "configured"),
    ]);

    const health = await listWorkspaceRepositoryHealth(
      {
        workspaceId: "workspace_1",
        expectedActionRef: "777genius/review-router@v1",
      },
      {
        repositories,
        workflowProbe: {
          probeWorkflow: async () => {
            throw new Error("network timeout with token value");
          },
        },
      },
    );

    expect(health).toEqual([
      expect.objectContaining({
        repositoryId: "repo_1",
        status: "workflow_check_unavailable",
      }),
    ]);
  });

  it("checks workflow content through Octokit without returning raw YAML", async () => {
    const workflow = "uses: 777genius/review-router@v1\n";
    const requests: Array<{
      route: string;
      parameters?: Record<string, unknown>;
    }> = [];
    const probe = new OctokitRepositoryWorkflowProbe({
      createRequester: async () => ({
        request: async (route, parameters) => {
          requests.push({
            route,
            ...(parameters ? { parameters } : {}),
          });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(workflow).toString("base64"),
            },
          };
        },
      }),
    });

    const result = await probe.probeWorkflow({
      githubInstallationId: "129",
      owner: "777genius",
      name: "example",
      defaultBranch: "main",
      workflowPath: ".github/workflows/reviewrouter.yml",
      expectedActionRef: "777genius/review-router@v1",
    });

    expect(result).toEqual({
      status: "present",
      expectedActionRefFound: true,
    });
    expect(JSON.stringify(result)).not.toContain("uses:");
    expect(requests[0]).toMatchObject({
      route: "GET /repos/{owner}/{repo}/contents/{path}",
      parameters: {
        owner: "777genius",
        repo: "example",
        path: ".github/workflows/reviewrouter.yml",
        ref: "main",
      },
    });
  });

  it("ignores commented workflow action refs", async () => {
    const workflow = [
      "# uses: 777genius/review-router@v1",
      "jobs:",
      "  review:",
      "    steps:",
      "      - uses: 777genius/review-router@v0",
    ].join("\n");
    const probe = new OctokitRepositoryWorkflowProbe({
      createRequester: async () => ({
        request: async () => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(workflow).toString("base64"),
          },
        }),
      }),
    });

    await expect(
      probe.probeWorkflow({
        githubInstallationId: "129",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        workflowPath: ".github/workflows/reviewrouter.yml",
        expectedActionRef: "777genius/review-router@v1",
      }),
    ).resolves.toEqual({
      status: "present",
      expectedActionRefFound: false,
    });
  });

  it("maps missing or failed GitHub workflow probes to safe metadata", async () => {
    const missingProbe = new OctokitRepositoryWorkflowProbe({
      createRequester: async () => ({
        request: async () => {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      }),
    });
    await expect(missingProbe.probeWorkflow(probeInput())).resolves.toEqual({
      status: "missing",
    });

    const deniedProbe = new OctokitRepositoryWorkflowProbe({
      createRequester: async () => ({
        request: async () => {
          throw Object.assign(new Error("secret token should not leak"), {
            status: 403,
          });
        },
      }),
    });
    await expect(deniedProbe.probeWorkflow(probeInput())).resolves.toEqual({
      status: "unavailable",
      reason: "github_permission_denied",
    });

    const authFailureProbe = new OctokitRepositoryWorkflowProbe({
      createRequester: async () => {
        throw Object.assign(new Error("private key parse failed"), {
          status: 401,
        });
      },
    });
    await expect(authFailureProbe.probeWorkflow(probeInput())).resolves.toEqual(
      {
        status: "unavailable",
        reason: "github_workflow_probe_failed",
      },
    );
  });
});

class InMemoryHealthRepository implements RepositoryHealthRepositoryPort {
  constructor(private readonly inputs: readonly RepositoryHealthInput[]) {}

  async listWorkspaceHealthInputs(): Promise<readonly RepositoryHealthInput[]> {
    return this.inputs;
  }
}

class CapturingWorkflowProbe implements RepositoryWorkflowProbePort {
  readonly inputs: RepositoryWorkflowProbeInput[] = [];

  constructor(
    private readonly results: Record<string, RepositoryWorkflowCheck>,
  ) {}

  async probeWorkflow(
    input: RepositoryWorkflowProbeInput,
  ): Promise<RepositoryWorkflowCheck> {
    this.inputs.push(input);
    const repositoryId = input.name.replace("repo-", "repo_");
    return this.results[repositoryId] ?? { status: "missing" };
  }
}

function healthInput(
  repositoryId: string,
  setupStatus: RepositoryHealthInput["setupStatus"],
): RepositoryHealthInput {
  return {
    repositoryId,
    fullName: `777genius/${repositoryId.replace("_", "-")}`,
    owner: "777genius",
    name: repositoryId.replace("_", "-"),
    defaultBranch: "main",
    githubInstallationId: "129",
    setupStatus,
    expectedActionRef: "777genius/review-router@v1",
  };
}

function probeInput(): RepositoryWorkflowProbeInput {
  return {
    githubInstallationId: "129",
    owner: "777genius",
    name: "example",
    defaultBranch: "main",
    workflowPath: ".github/workflows/reviewrouter.yml",
    expectedActionRef: "777genius/review-router@v1",
  };
}
