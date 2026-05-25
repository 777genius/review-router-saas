import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";
import type {
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
} from "../application/ports/workflow-setup-gateway-port";
import type {
  WorkflowProvisioningRecord,
  WorkflowProvisioningRepositoryPort,
} from "../application/ports/workflow-provisioning-repository-port";
import type {
  WorkflowProvisioningTarget,
  WorkflowProvisioningTargetPort,
} from "../application/ports/workflow-provisioning-target-port";
import { provisionRepositoryReviewRouterWorkflow } from "../application/use-cases/provision-repository-reviewrouter-workflow";
import { provisionReviewRouterWorkflow } from "../application/use-cases/provision-reviewrouter-workflow";

class CapturingSetupGateway implements WorkflowSetupGatewayPort {
  public input: WorkflowSetupGatewayInput | null = null;

  constructor(private readonly failure: Error | null = null) {}

  async createOrUpdateSetupPullRequest(input: WorkflowSetupGatewayInput) {
    this.input = input;
    if (this.failure) {
      throw this.failure;
    }
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

class CapturingAuditLog implements AuditLogRepositoryPort {
  public readonly events: AuditEventInput[] = [];

  async append(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

class StaticWorkflowProvisioningTarget implements WorkflowProvisioningTargetPort {
  constructor(private readonly target: WorkflowProvisioningTarget | null) {}

  async findWorkflowProvisioningTarget(): Promise<WorkflowProvisioningTarget | null> {
    return this.target;
  }
}

const activeTarget = {
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
  owner: "777genius",
  name: "example",
  fullName: "777genius/example",
  defaultBranch: "main",
  selected: true,
  archived: false,
  installationStatus: "active",
} satisfies WorkflowProvisioningTarget;

describe("provisionReviewRouterWorkflow", () => {
  it("renders workflow and records setup PR state", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

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
        staticRuntimeEnv: {
          CODEX_MODEL: "gpt-5.4-mini",
          FAIL_ON_SEVERITY: "major",
          REVIEW_AUTH_MODE: "codex-oauth",
        },
      },
      { setupGateway: gateway, provisioning, auditLog },
    );

    expect(pullRequest.url).toContain("/pull/1");
    const files = new Map(
      (gateway.input?.workflowFiles ?? [])
        .filter((file) => file.operation !== "delete")
        .map((file) => [file.path, file.content]),
    );
    expect([...files.keys()].sort()).toEqual([
      ".github/workflows/reviewrouter-interaction.yml",
      ".github/workflows/reviewrouter.yml",
    ]);
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      "name: ReviewRouter",
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).not.toContain(
      "repository_dispatch:",
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).not.toContain(
      "conflict_dispatch_id:",
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).not.toContain(
      "pull_request_review_comment:",
    );
    expect(
      files.get(".github/workflows/reviewrouter-interaction.yml"),
    ).toContain("name: ReviewRouter Interaction");
    expect(
      files.get(".github/workflows/reviewrouter-interaction.yml"),
    ).toContain("pull_request_review_comment:");
    expect(
      files.get(".github/workflows/reviewrouter-interaction.yml"),
    ).toContain("issue_comment:");
    expect(
      files.get(".github/workflows/reviewrouter-interaction.yml"),
    ).toContain("types: [created, edited]");
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      '"CODEX_MODEL": "gpt-5.4-mini"',
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      '"FAIL_ON_SEVERITY": "major"',
    );
    expect(provisioning.opened).toMatchObject({
      status: "setup_pr_open",
      branch: "reviewrouter/setup",
      workflowStyle: "reusable",
      actionVersion: "777genius/review-router@v1",
    });
    expect(auditLog.events).toContainEqual(
      expect.objectContaining({
        action: "workflow.setup_pr_opened",
        targetId: "repo-1",
      }),
    );
  });

  it("blocks setup PR creation when workflow provisioning is disabled", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionReviewRouterWorkflow(
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
        { setupGateway: gateway, provisioning, auditLog, enabled: false },
      ),
    ).rejects.toThrow("workflow_provisioning_disabled");

    expect(gateway.input).toBeNull();
    expect(provisioning.failed).toMatchObject({
      status: "failed",
      errorMessage: "workflow_provisioning_disabled",
    });
    expect(auditLog.events).toContainEqual(
      expect.objectContaining({ action: "workflow.setup_pr_blocked" }),
    );
  });

  it("adds conflict fallback workflow surface only when the rollout flag is passed", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();

    await provisionReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        conflictReviewFallbackEnabled: true,
      },
      { setupGateway: gateway, provisioning },
    );

    const reviewWorkflowFile = gateway.input?.workflowFiles.find(
      (file) =>
        file.operation !== "delete" &&
        file.path === ".github/workflows/reviewrouter.yml",
    );
    const reviewWorkflow =
      reviewWorkflowFile && reviewWorkflowFile.operation !== "delete"
        ? reviewWorkflowFile.content
        : undefined;
    expect(reviewWorkflow).toContain("repository_dispatch:");
    expect(reviewWorkflow).toContain("conflict-review:");
    expect(reviewWorkflow).toContain(
      "if: ${{ github.event_name != 'repository_dispatch' }}",
    );
    expect(reviewWorkflow).toContain(
      "github.event_name == 'repository_dispatch' && github.event.action == 'reviewrouter_conflict_review'",
    );
    expect(reviewWorkflow).toContain(
      [
        "    permissions:",
        "      contents: read",
        "      id-token: write",
      ].join("\n"),
    );
    expect(reviewWorkflow).toContain("conflict_dispatch_event_type:");
    expect(reviewWorkflow).toContain("conflict_dispatch_id:");
  });

  it("provisions the dedicated advisory-only rotating Codex workflow", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";

    await provisionReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        actionRef,
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        workflowStyle: "reusable",
        conflictReviewFallbackEnabled: false,
        codexRotatingProviderInstanceId: "codex-rotating:123456",
      },
      { setupGateway: gateway, provisioning },
    );

    const workflowFiles = gateway.input?.workflowFiles ?? [];
    const codexWorkflow = workflowFiles.find(
      (file) => file.path === ".github/workflows/reviewrouter-codex.yml",
    );
    expect(workflowFiles).toHaveLength(3);
    expect(codexWorkflow).toMatchObject({
      path: ".github/workflows/reviewrouter-codex.yml",
    });
    expect(codexWorkflow?.operation).not.toBe("delete");
    const codexWorkflowContent =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    expect(codexWorkflowContent).toContain("name: ReviewRouter Codex OAuth");
    expect(codexWorkflowContent).toContain("permissions: {}\n\njobs:");
    expect(codexWorkflowContent).toContain(`uses: ${actionRef}`);
    expect(codexWorkflowContent).toContain(
      'provider-instance-id: "codex-rotating:123456"',
    );
    expect(codexWorkflowContent).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(codexWorkflowContent).not.toContain("actions/checkout");
    expect(codexWorkflowContent).not.toContain("workflow_dispatch:");
    expect(workflowFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".github/workflows/reviewrouter.yml",
          operation: "delete",
        }),
        expect.objectContaining({
          path: ".github/workflows/reviewrouter-interaction.yml",
          operation: "delete",
        }),
      ]),
    );
    expect(provisioning.opened).toMatchObject({
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowStyle: "reusable",
      actionVersion: actionRef,
    });
  });

  it("rejects rotating Codex workflow provisioning unless the action ref is a full SHA", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          codexRotatingProviderInstanceId: "codex-rotating:123456",
        },
        { setupGateway: gateway, provisioning },
      ),
    ).rejects.toThrow("codex_rotating_action_ref_must_be_full_sha");

    expect(gateway.input).toBeNull();
    expect(provisioning.failed?.errorMessage).toBe(
      "codex_rotating_action_ref_must_be_full_sha",
    );
  });

  it("persists safe GitHub failure summaries without raw adapter details", async () => {
    const rawToken = "ghs_sensitive_token";
    const gateway = new CapturingSetupGateway(
      Object.assign(new Error(`GitHub failed with ${rawToken}`), {
        status: 403,
      }),
    );
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionReviewRouterWorkflow(
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
        { setupGateway: gateway, provisioning, auditLog },
      ),
    ).rejects.toThrow(rawToken);

    expect(provisioning.failed?.errorMessage).toBe("github_api_error:403");
    expect(auditLog.events[0]?.metadata).toMatchObject({
      errorSummary: "github_api_error:403",
    });
    expect(JSON.stringify(provisioning.failed)).not.toContain(rawToken);
    expect(JSON.stringify(auditLog.events)).not.toContain(rawToken);
  });

  it("provisions by repository id after validating target state", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionRepositoryReviewRouterWorkflow(
        {
          repositoryId: "repo-1",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: {
            CODEX_MODEL: "gpt-5.4-mini",
            FAIL_ON_SEVERITY: "off",
          },
          actor: "user:maintainer",
        },
        {
          targets: new StaticWorkflowProvisioningTarget(activeTarget),
          setupGateway: gateway,
          provisioning,
          auditLog,
        },
      ),
    ).resolves.toMatchObject({ number: 1 });

    expect(gateway.input).toMatchObject({
      owner: "777genius",
      repo: "example",
      baseBranch: "main",
    });
    const files = new Map(
      (gateway.input?.workflowFiles ?? [])
        .filter((file) => file.operation !== "delete")
        .map((file) => [file.path, file.content]),
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      '"CODEX_MODEL": "gpt-5.4-mini"',
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      '"FAIL_ON_SEVERITY": "off"',
    );
    expect(auditLog.events[0]).toMatchObject({ actor: "user:maintainer" });
  });

  it("rejects invalid repository states before calling GitHub", async () => {
    const gateway = new CapturingSetupGateway();

    await expect(
      provisionRepositoryReviewRouterWorkflow(
        {
          repositoryId: "repo-1",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
        },
        {
          targets: new StaticWorkflowProvisioningTarget({
            ...activeTarget,
            selected: false,
          }),
          setupGateway: gateway,
          provisioning: new CapturingProvisioningRepository(),
        },
      ),
    ).rejects.toThrow("repository_not_selected");

    expect(gateway.input).toBeNull();
  });
});
