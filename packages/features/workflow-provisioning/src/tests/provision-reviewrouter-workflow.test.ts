import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseReviewConfigurationStrict,
  safeDefaultReviewConfiguration,
  type ReviewConfigurationRepositoryPort,
} from "@reviewrouter/features-review-config";
import type { ProvisionWorkflowInput } from "../domain/workflow-provisioning";
import {
  allocateVersionedProviderSecretNamespace,
  CodexRotatingT0WorkflowSchemaVersion,
} from "@reviewrouter/features-codex-oauth-rotating";
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
      headSha: "b".repeat(40),
      branch: input.setupBranch,
    };
  }
}

class CapturingProvisioningRepository implements WorkflowProvisioningRepositoryPort {
  public attempts = 0;

  async beginAttempt(record: WorkflowProvisioningRecord) {
    this.attempts += 1;
    return {
      workspaceId: record.workspaceId,
      repositoryId: record.repositoryId,
      installationId: record.installationId,
      attemptId: "attempt-1",
      branch: `${record.branch}/attempt-1`,
      revision: 0,
    };
  }
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
  installationId: "installation-1",
  repositoryId: "repo-1",
  owner: "777genius",
  name: "example",
  fullName: "777genius/example",
  defaultBranch: "main",
  selected: true,
  archived: false,
  installationStatus: "active",
} satisfies WorkflowProvisioningTarget;

const savedGatewayConfig = parseReviewConfigurationStrict({
  ...safeDefaultReviewConfiguration,
  schemaVersion: 2,
  providers: [
    {
      kind: "codex",
      authMode: "codex_account_gateway",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      fastMode: false,
      gatewayBindingId: "binding-account-v",
      gatewayProfileRef: "default",
    },
  ],
});
const gatewayInput: ProvisionWorkflowInput = {
  ...activeTarget,
  githubRepositoryId: "123456",
  repositoryFullName: activeTarget.fullName,
  actionRef: "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
  apiUrl: "https://app.reviewrouter.dev",
  runtimeConfigMode: "oidc",
  codexSessionMode: "account-gateway",
};
function savedConfigurations(
  selection = "repository",
): ReviewConfigurationRepositoryPort {
  return {
    findLatest: async (target) =>
      target.scope === selection
        ? { version: 1, config: savedGatewayConfig }
        : null,
    saveNextVersion: async () => {
      throw new Error("unexpected_config_write");
    },
    deleteTarget: async () => {
      throw new Error("unexpected_config_delete");
    },
  };
}
it("provisions only the keyless caller from server-loaded saved repository config", async () => {
  const setupGateway = new CapturingSetupGateway();
  await provisionRepositoryReviewRouterWorkflow(gatewayInput, {
    targets: new StaticWorkflowProvisioningTarget(activeTarget),
    setupGateway,
    provisioning: new CapturingProvisioningRepository(),
    configurations: savedConfigurations(),
    trustedGithubRepositoryId: "123456",
  });
  const files = setupGateway.input!.workflowFiles;
  expect(files).toHaveLength(1);
  expect(files[0]!.path).toBe(".github/workflows/reviewrouter-codex.yml");
  const file = files[0]!;
  const job = parse("content" in file ? file.content : "").jobs["codex-review"];
  expect(job.with).toMatchObject({
    codex_session_mode: "account-gateway",
    workflow_schema_version: 2,
    provider_instance_id: "codex-rotating:123456",
    runtime_config_mode: "oidc",
  });
  expect(job.uses).toBe(
    gatewayInput.actionRef.replace(
      "@",
      "/.github/workflows/reviewrouter-t0-reusable.yml@",
    ),
  );
  expect(job.secrets).toBeUndefined();
});
it.each([
  ["missing-mode", { codexSessionMode: undefined }],
  ["wrong-mode", { codexSessionMode: "oauth" }],
  ["mutable-ref", { actionRef: "777genius/review-router@main" }],
  ["missing-ref", { actionRef: "" }],
  ["wrong-repo-ref", { actionRef: `other/repo@${"a".repeat(40)}` }],
  ["uppercase-ref", { actionRef: `777genius/review-router@${"A".repeat(40)}` }],
  ["missing-identity", { githubRepositoryId: undefined }],
  ["invalid-identity", { githubRepositoryId: "01" }],
  ["different-identity", { githubRepositoryId: "654321" }],
  ["isolated-path", { githubRepositoryId: "1228051727" }],
  ["static", { runtimeConfigMode: "static" }],
  ["static-env", { staticRuntimeEnv: {} }],
  ["explicit", { workflowStyle: "explicit" }],
  ["conflict", { conflictReviewFallbackEnabled: true }],
  ["rotating", { codexRotatingProviderInstanceId: "codex-rotating:123456" }],
] as const)(
  "denies gateway %s before setup effects",
  async (_reason, overrides) => {
    const setupGateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    await expect(
      provisionReviewRouterWorkflow(
        { ...gatewayInput, ...overrides } as ProvisionWorkflowInput,
        {
          setupGateway,
          provisioning,
          configurations: savedConfigurations(),
          trustedGithubRepositoryId: "123456",
        },
      ),
    ).rejects.toThrow();
    expect(setupGateway.input).toBeNull();
    expect(provisioning.attempts).toBe(0);
  },
);
it.each(["missing", "workspace", "mixed"])(
  "denies %s saved gateway selection before setup",
  async (selection) => {
    const setupGateway = new CapturingSetupGateway();
    const configurations = savedConfigurations(
      selection === "mixed" ? "repository" : selection,
    );
    if (selection === "mixed")
      configurations.findLatest = async () => ({
        version: 1,
        config: parseReviewConfigurationStrict({
          ...savedGatewayConfig,
          providers: [
            ...savedGatewayConfig.providers,
            safeDefaultReviewConfiguration.provider,
          ],
        }),
      });
    await expect(
      provisionReviewRouterWorkflow(gatewayInput, {
        setupGateway,
        provisioning: new CapturingProvisioningRepository(),
        configurations,
        trustedGithubRepositoryId: "123456",
      }),
    ).rejects.toThrow();
    expect(setupGateway.input).toBeNull();
  },
);
it("denies forged gateway runtime hints without saved configuration", async () => {
  const setupGateway = new CapturingSetupGateway();
  const input = {
    ...gatewayInput,
    staticRuntimeEnv: { REVIEW_AUTH_MODE: "codex-account-gateway" },
  };
  delete input.codexSessionMode;
  await expect(
    provisionReviewRouterWorkflow(input, {
      setupGateway,
      provisioning: new CapturingProvisioningRepository(),
    }),
  ).rejects.toThrow("account_gateway_saved_config_required");
  expect(setupGateway.input).toBeNull();
});
it("requires server repository identity even when the caller supplies a valid numeric ID", async () => {
  const setupGateway = new CapturingSetupGateway();
  await expect(
    provisionReviewRouterWorkflow(gatewayInput, {
      setupGateway,
      provisioning: new CapturingProvisioningRepository(),
      configurations: savedConfigurations(),
    }),
  ).rejects.toThrow("account_gateway_repository_identity_required");
  expect(setupGateway.input).toBeNull();
});

describe("provisionReviewRouterWorkflow", () => {
  it("renders non-Codex workflow and records setup PR state", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    const pullRequest = await provisionReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        installationId: "installation-1",
        repositoryId: "repo-1",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        staticRuntimeEnv: {
          FAIL_ON_SEVERITY: "major",
          REVIEW_AUTH_MODE: "openrouter-api",
          REVIEW_PROVIDERS: "openrouter/openai/gpt-5.3-codex",
          SYNTHESIS_MODEL: "openrouter/openai/gpt-5.3-codex",
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
      '"REVIEW_AUTH_MODE": "openrouter-api"',
    );
    expect(files.get(".github/workflows/reviewrouter.yml")).toContain(
      '"FAIL_ON_SEVERITY": "major"',
    );
    expect(provisioning.opened).toMatchObject({
      status: "setup_pr_open",
      branch: "reviewrouter/setup/attempt-1",
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

  it("rejects legacy Codex setup PR provisioning", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: {
            CODEX_MODEL: "gpt-5.4-mini",
            REVIEW_AUTH_MODE: "codex-oauth",
          },
        },
        { setupGateway: gateway, provisioning, auditLog },
      ),
    ).rejects.toThrow("codex_legacy_auth_requires_reconnect");

    expect(gateway.input).toBeNull();
    expect(provisioning.failed?.errorMessage).toBe(
      "codex_legacy_auth_requires_reconnect",
    );
    expect(auditLog.events[0]?.metadata).toMatchObject({
      errorSummary: "codex_legacy_auth_requires_reconnect",
    });
  });

  it("rejects Codex API-key setup PR provisioning", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: {
            CODEX_MODEL: "gpt-5.4-mini",
            REVIEW_AUTH_MODE: "openai-api",
          },
        },
        { setupGateway: gateway, provisioning },
      ),
    ).rejects.toThrow("codex_api_key_setup_disabled");

    expect(gateway.input).toBeNull();
    expect(provisioning.failed?.errorMessage).toBe(
      "codex_api_key_setup_disabled",
    );
  });

  it("rejects rotating Codex setup PR provisioning without provider instance id", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: {
            CODEX_MODEL: "gpt-5.5",
            REVIEW_AUTH_MODE: "codex-oauth-rotating",
          },
        },
        { setupGateway: gateway, provisioning },
      ),
    ).rejects.toThrow("codex_rotating_provider_instance_required");

    expect(gateway.input).toBeNull();
    expect(provisioning.failed?.errorMessage).toBe(
      "codex_rotating_provider_instance_required",
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
          installationId: "installation-1",
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
        installationId: "installation-1",
        repositoryId: "repo-1",
        owner: "777genius",
        name: "example",
        defaultBranch: "main",
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        conflictReviewFallbackEnabled: true,
        staticRuntimeEnv: {
          REVIEW_AUTH_MODE: "openrouter-api",
          REVIEW_PROVIDERS: "openrouter/openai/gpt-5.3-codex",
          SYNTHESIS_MODEL: "openrouter/openai/gpt-5.3-codex",
        },
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
        installationId: "installation-1",
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
    const interactionWorkflows = workflowFiles.filter(
      (file) => file.path === ".github/workflows/reviewrouter-interaction.yml",
    );
    const interactionWorkflow = interactionWorkflows.find(
      (file) => file.operation !== "delete",
    );
    expect(workflowFiles).toHaveLength(3);
    expect(codexWorkflow).toMatchObject({
      path: ".github/workflows/reviewrouter-codex.yml",
    });
    expect(codexWorkflow?.operation).not.toBe("delete");
    expect(interactionWorkflows).toHaveLength(1);
    expect(interactionWorkflow).toBeTruthy();
    const codexWorkflowContent =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    const interactionWorkflowContent = interactionWorkflow?.content ?? "";
    expect(codexWorkflowContent).toContain("name: ReviewRouter Codex OAuth");
    expect(codexWorkflowContent).toContain("permissions: {}\n\njobs:");
    expect(codexWorkflowContent).toContain(
      "    permissions:\n      id-token: write",
    );
    expect(codexWorkflowContent).toContain(`uses: ${actionRef}`);
    expect(codexWorkflowContent).toContain(
      'provider-instance-id: "codex-rotating:123456"',
    );
    expect(codexWorkflowContent).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(codexWorkflowContent).not.toContain("actions/checkout");
    expect(codexWorkflowContent).toContain("workflow_dispatch:");
    expect(codexWorkflowContent).toContain("codex-refresh:");
    expect(interactionWorkflowContent).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflowContent).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflowContent).toContain("issue_comment:");
    expect(interactionWorkflowContent).toContain("runs-on: ubuntu-24.04");
    expect(interactionWorkflowContent).toContain(
      "repository: 777genius/review-router",
    );
    expect(interactionWorkflowContent).toContain(
      'RR_RUNTIME_REF: "0123456789abcdef0123456789abcdef01234567"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction-preflight"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction"',
    );
    expect(interactionWorkflowContent).toContain(
      "run: node .reviewrouter-runtime/dist/index.js",
    );
    expect(interactionWorkflowContent).not.toContain(`uses: ${actionRef}`);
    expect(interactionWorkflowContent).toContain(
      "CODEX_AUTH_JSON_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}",
    );
    expect(interactionWorkflowContent).not.toContain("secrets.CODEX_AUTH_JSON");
    expect(workflowFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".github/workflows/reviewrouter.yml",
          operation: "delete",
        }),
      ]),
    );
    expect(interactionWorkflows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "delete" }),
      ]),
    );
    expect(provisioning.opened).toMatchObject({
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowStyle: "reusable",
      actionVersion: actionRef,
    });
  });

  it("renders and persists the isolated workflow at its selected path", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const workflowPath = ".github/workflows/reviewrouter-quality-stand.yml";
    const namespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "1228051727",
        providerInstanceId: "codex-rotating:1228051727",
      },
      epoch: 3n,
      randomBytes: () => Buffer.alloc(16, 9),
    });

    await provisionReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        installationId: "installation-1",
        repositoryId: "repo-1",
        githubRepositoryId: "1228051727",
        repositoryFullName: "777genius/review-router-saas-e2e",
        owner: "777genius",
        name: "review-router-saas-e2e",
        defaultBranch: "main",
        actionRef:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        codexRotatingProviderInstanceId: "codex-rotating:1228051727",
        codexRotatingWorkflowSecretNamespace: namespace,
        codexRotatingWorkflowSchemaVersion:
          CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
        workflowPath,
      },
      { setupGateway: gateway, provisioning },
    );

    expect(gateway.input?.workflowFiles[0]).toMatchObject({
      path: workflowPath,
    });
    expect(gateway.input?.workflowFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".github/workflows/reviewrouter.yml",
          operation: "delete",
        }),
        expect.objectContaining({
          path: ".github/workflows/reviewrouter-codex.yml",
          operation: "delete",
        }),
      ]),
    );
    expect(provisioning.opened).toMatchObject({ workflowPath });
  });

  it("rejects isolated non-main provisioning before any side effect", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          githubRepositoryId: "1228051727",
          repositoryFullName: "777genius/review-router-saas-e2e",
          owner: "777genius",
          name: "review-router-saas-e2e",
          defaultBranch: "trunk",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          codexRotatingProviderInstanceId: "codex-rotating:1228051727",
        },
        { setupGateway: gateway, provisioning, auditLog },
      ),
    ).rejects.toThrow("isolated_workflow_default_branch_must_be_main");

    expect(provisioning.attempts).toBe(0);
    expect(provisioning.opened).toBeNull();
    expect(provisioning.failed).toBeNull();
    expect(gateway.input).toBeNull();
    expect(auditLog.events).toEqual([]);
  });

  it("rejects rotating Codex workflow provisioning on a mutable main action ref", async () => {
    const gateway = new CapturingSetupGateway();
    const provisioning = new CapturingProvisioningRepository();
    const auditLog = new CapturingAuditLog();

    await expect(
      provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@main",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          codexRotatingProviderInstanceId: "codex-rotating:123456",
        },
        { setupGateway: gateway, provisioning, auditLog },
      ),
    ).rejects.toThrow(
      "invalid_app_first_interaction_reusable_workflow_runtime_ref",
    );
    expect(gateway.input).toBeNull();
    expect(provisioning.opened).toBeNull();
    expect(provisioning.failed).toBeNull();
    expect(auditLog.events).toEqual([]);
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
          installationId: "installation-1",
          repositoryId: "repo-1",
          owner: "777genius",
          name: "example",
          defaultBranch: "main",
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: {
            REVIEW_AUTH_MODE: "openrouter-api",
            REVIEW_PROVIDERS: "openrouter/openai/gpt-5.3-codex",
            SYNTHESIS_MODEL: "openrouter/openai/gpt-5.3-codex",
          },
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
          workspaceId: "workspace-1",
          installationId: "installation-1",
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
          workspaceId: "workspace-1",
          installationId: "installation-1",
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

  it("provisions v4 from an explicitly proven workflow namespace", async () => {
    const gateway = new CapturingSetupGateway();
    const namespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 7n,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });

    await expect(
      provisionRepositoryReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: { REVIEW_AUTH_MODE: "codex-oauth-rotating" },
          codexRotatingProviderInstanceId: "codex-rotating:123456",
          codexRotatingWorkflowSecretNamespace: namespace,
          actor: "user:maintainer",
        },
        {
          targets: new StaticWorkflowProvisioningTarget(activeTarget),
          setupGateway: gateway,
          provisioning: new CapturingProvisioningRepository(),
        },
      ),
    ).resolves.toMatchObject({ number: 1 });

    const workflow = gateway.input?.workflowFiles.find(
      (file) => file.path === ".github/workflows/reviewrouter-codex.yml",
    );
    expect(workflow?.operation).not.toBe("delete");
    expect(workflow && "content" in workflow ? workflow.content : "").toContain(
      `secrets.${namespace.name}`,
    );
    expect(workflow && "content" in workflow ? workflow.content : "").toContain(
      "workflow_schema_version: 4",
    );
  });

  it("honors an explicit v5 workflow schema for a proven namespace", async () => {
    const gateway = new CapturingSetupGateway();
    const namespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 7n,
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });

    await provisionRepositoryReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        installationId: "installation-1",
        repositoryId: "repo-1",
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        staticRuntimeEnv: { REVIEW_AUTH_MODE: "codex-oauth-rotating" },
        codexRotatingProviderInstanceId: "codex-rotating:123456",
        codexRotatingWorkflowSecretNamespace: namespace,
        codexRotatingWorkflowSchemaVersion:
          CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      },
      {
        targets: new StaticWorkflowProvisioningTarget(activeTarget),
        setupGateway: gateway,
        provisioning: new CapturingProvisioningRepository(),
      },
    );

    const workflow = gateway.input?.workflowFiles.find(
      (file) => file.path === ".github/workflows/reviewrouter-codex.yml",
    );
    expect(workflow?.operation).not.toBe("delete");
    expect(workflow && "content" in workflow ? workflow.content : "").toContain(
      "workflow_schema_version: 5",
    );
  });

  it("does not call GitHub without an exact workflow namespace", async () => {
    const gateway = new CapturingSetupGateway();

    await expect(
      provisionRepositoryReviewRouterWorkflow(
        {
          workspaceId: "workspace-1",
          installationId: "installation-1",
          repositoryId: "repo-1",
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          apiUrl: "https://app.reviewrouter.dev",
          runtimeConfigMode: "oidc",
          staticRuntimeEnv: { REVIEW_AUTH_MODE: "codex-oauth-rotating" },
          codexRotatingProviderInstanceId: "codex-rotating:123456",
        },
        {
          targets: new StaticWorkflowProvisioningTarget(activeTarget),
          setupGateway: gateway,
          provisioning: new CapturingProvisioningRepository(),
        },
      ),
    ).rejects.toThrow("codex_rotating_active_secret_namespace_required");

    expect(gateway.input).toBeNull();
  });
});

it("rejects schema 6 before GitHub provisioning mutations", async () => {
  const gateway = new CapturingSetupGateway();
  const provisioning = new CapturingProvisioningRepository();
  const auditLog = new CapturingAuditLog();
  const namespace = allocateVersionedProviderSecretNamespace({
    scope: {
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:123456",
    },
    epoch: 7n,
    randomBytes: (size) => new Uint8Array(size).fill(7),
  });
  await expect(
    provisionRepositoryReviewRouterWorkflow(
      {
        workspaceId: "workspace-1",
        installationId: "installation-1",
        repositoryId: "repo-1",
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
        staticRuntimeEnv: { REVIEW_AUTH_MODE: "codex-oauth-rotating" },
        codexRotatingProviderInstanceId: "codex-rotating:123456",
        codexRotatingWorkflowSecretNamespace: namespace,
        codexRotatingWorkflowSchemaVersion: 6,
      },
      {
        targets: new StaticWorkflowProvisioningTarget(activeTarget),
        setupGateway: gateway,
        provisioning,
        auditLog,
      },
    ),
  ).rejects.toThrow("codex_rotating_t0_workflow_schema_unsupported");
  expect(gateway.input).toBeNull();
  // Existing attempt/failure bookkeeping remains unchanged; no workflow is written.
  expect(provisioning.attempts).toBe(1);
  expect(provisioning.opened).toBeNull();
  expect(provisioning.failed).toMatchObject({ status: "failed" });
  expect(auditLog.events.map((event) => event.action)).toEqual([
    "workflow.setup_pr_failed",
  ]);
});
