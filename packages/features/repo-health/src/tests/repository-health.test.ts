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

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "setup_pr_open",
        expectedActionRef: "777genius/review-router@v1",
        workflowCheck: {
          status: "present",
          expectedActionRefFound: true,
        },
      }),
    ).toMatchObject({
      status: "healthy",
      summary: "Ready",
    });

    expect(
      evaluateRepositoryHealth({
        repositoryId: "repo_1",
        fullName: "777genius/example",
        setupStatus: "not_configured",
        expectedActionRef: "777genius/review-router@v1",
        workflowCheck: {
          status: "present",
          expectedActionRefFound: true,
        },
      }),
    ).toMatchObject({ status: "healthy" });
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

    expect(
      evaluateRepositoryHealth(
        {
          repositoryId: "repo_1",
          fullName: "777genius/example",
          setupStatus: "configured",
          expectedActionRef: "777genius/review-router@v1",
          latestProviderSetupState: "configured",
          latestProviderHealth: "ok",
          latestActionHealthReceivedAt: new Date("2026-05-02T00:00:00.000Z"),
          actionHealthStaleAfterMs: 60 * 60 * 1000,
        },
        new Date("2026-05-03T00:00:00.000Z"),
      ),
    ).toMatchObject({
      status: "provider_report_stale",
      summary: "No recent action health report from the installed workflow",
    });

    expect(
      evaluateRepositoryHealth(
        {
          repositoryId: "repo_1",
          fullName: "777genius/example",
          setupStatus: "configured",
          expectedActionRef: "777genius/review-router@v1",
          latestProviderSetupState: "configured",
          latestProviderHealth: "ok",
          latestActionHealthReceivedAt: new Date("2026-05-03T00:00:00.000Z"),
          latestActionHealthTelemetry: {
            configSource: "runtime_oidc",
            findingCounts: { critical: 1, major: 2, minor: 0, info: 0 },
            commentCounts: { inline: 3, summary: 1 },
            skippedReasonCategory: "none",
          },
        },
        new Date("2026-05-03T00:05:00.000Z"),
      ),
    ).toMatchObject({
      status: "healthy",
      latestActionHealthTelemetry: {
        configSource: "runtime_oidc",
        findingCounts: { critical: 1, major: 2 },
        commentCounts: { inline: 3, summary: 1 },
      },
    });
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

  it("probes stale setup statuses so merged setup PRs are recognized", async () => {
    const repositories = new InMemoryHealthRepository([
      healthInput("repo_1", "setup_pr_open"),
      healthInput("repo_2", "not_configured"),
    ]);
    const probe = new CapturingWorkflowProbe({
      repo_1: { status: "present", expectedActionRefFound: true },
      repo_2: { status: "present", expectedActionRefFound: true },
    });

    const health = await listWorkspaceRepositoryHealth(
      {
        workspaceId: "workspace_1",
        expectedActionRef: "777genius/review-router@v1",
        workflowProbeMaxRepositories: 2,
      },
      { repositories, workflowProbe: probe },
    );

    expect(probe.inputs.map((input) => input.name)).toEqual([
      "repo-1",
      "repo-2",
    ]);
    expect(health).toEqual([
      expect.objectContaining({ repositoryId: "repo_1", status: "healthy" }),
      expect.objectContaining({ repositoryId: "repo_2", status: "healthy" }),
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

  it("applies stale action health thresholds in workspace health", async () => {
    const repositories = new InMemoryHealthRepository([
      {
        ...healthInput("repo_1", "configured"),
        latestProviderSetupState: "configured",
        latestProviderHealth: "ok",
        latestActionHealthReceivedAt: new Date("2026-05-03T10:00:00.000Z"),
      },
    ]);

    const health = await listWorkspaceRepositoryHealth(
      {
        workspaceId: "workspace_1",
        expectedActionRef: "777genius/review-router@v1",
        workflowProbeMaxRepositories: 0,
        actionHealthStaleAfterMs: 30 * 60 * 1000,
        checkedAt: new Date("2026-05-03T11:00:01.000Z"),
      },
      { repositories },
    );

    expect(health).toEqual([
      expect.objectContaining({
        repositoryId: "repo_1",
        status: "provider_report_stale",
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

  it("recognizes compact reusable ReviewRouter caller workflows as current", async () => {
    const workflow =
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1\n";
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
      expectedActionRefFound: true,
    });
  });

  it("recognizes the immutable T0 reusable workflow ref as current", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const workflow = `uses: 777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${sha}\n`;
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
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        expectedActionRef: `777genius/review-router@${sha}`,
      }),
    ).resolves.toEqual({
      status: "present",
      expectedActionRefFound: true,
    });
  });

  it("checks expected workflow capability markers without returning raw YAML", async () => {
    const workflow = [
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
      "secrets:",
      "  CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
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
        ...probeInput(),
        expectedContentMarkerGroups: [
          [
            ".github/workflows/reviewrouter-reusable.yml",
            "CLAUDE_CODE_OAUTH_TOKEN",
          ],
        ],
      }),
    ).resolves.toEqual({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: true,
    });

    const result = await probe.probeWorkflow({
      ...probeInput(),
      expectedContentMarkerGroups: [["Install Claude Code CLI"]],
    });
    expect(result).toEqual({
      status: "present",
      expectedActionRefFound: true,
      expectedContentMarkersFound: false,
    });
    for (const expectedContentValidator of [
      () => false,
      () => {
        throw new Error("validator rejected workflow");
      },
    ]) {
      await expect(
        probe.probeWorkflow({
          ...probeInput(),
          expectedContentMarkerGroups: [
            [".github/workflows/reviewrouter-reusable.yml"],
          ],
          expectedContentValidator,
        }),
      ).resolves.toEqual({
        status: "present",
        expectedActionRefFound: true,
        expectedContentMarkersFound: false,
      });
    }
    expect(JSON.stringify(result)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN:");
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
