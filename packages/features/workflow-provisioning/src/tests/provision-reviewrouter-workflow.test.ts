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
      (gateway.input?.workflowFiles ?? []).map((file) => [
        file.path,
        file.content,
      ]),
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
      (gateway.input?.workflowFiles ?? []).map((file) => [
        file.path,
        file.content,
      ]),
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
