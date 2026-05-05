import { describe, expect, it } from "vitest";
import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import type { OutboxEventRepositoryPort } from "@reviewrouter/features-outbox";
import {
  buildGitHubOrgRulesetPayload,
  createOrgRulesetProvisioningRequest,
  defaultOrgRulesetName,
  normalizeWorkflowPath,
  safeOrgRulesetErrorCode,
  type OrgRulesetProvisioningRequest,
  type OrgRulesetProvisioningTarget,
} from "../domain/org-ruleset-provisioning.js";
import type {
  OrgRulesetProvisioningRecord,
  OrgRulesetProvisioningRepositoryPort,
} from "../application/ports/org-ruleset-provisioning-repository-port.js";
import type {
  OrgRulesetPermissionProbeResult,
  OrgRulesetSetupGatewayPort,
  OrgRulesetWriteResult,
  SourceWorkflowWriteResult,
} from "../application/ports/org-ruleset-setup-gateway-port.js";
import { requestOrgRulesetProvisioning } from "../application/use-cases/request-org-ruleset-provisioning.js";
import { provisionOrgRulesetRequiredWorkflow } from "../application/use-cases/provision-org-ruleset-required-workflow.js";

const requestedAt = new Date("2026-05-06T12:00:00.000Z");
const target: OrgRulesetProvisioningTarget = {
  workspaceId: "workspace_1",
  installationId: "installation_1",
  githubInstallationId: "129500385",
  organizationLogin: "agent-teams-ai",
  accountType: "Organization",
  installationStatus: "active",
  repositorySelection: "selected",
  repositories: [
    {
      id: "repo_1",
      githubRepositoryId: "1001",
      owner: "agent-teams-ai",
      name: "alpha",
      fullName: "agent-teams-ai/alpha",
      defaultBranch: "main",
      selected: true,
      archived: false,
      visibility: "private",
    },
    {
      id: "repo_2",
      githubRepositoryId: "1002",
      owner: "agent-teams-ai",
      name: "beta",
      fullName: "agent-teams-ai/beta",
      defaultBranch: "main",
      selected: true,
      archived: false,
      visibility: "private",
    },
  ],
};

describe("org ruleset provisioning", () => {
  it("builds selected repository ruleset payload", () => {
    const payload = buildGitHubOrgRulesetPayload({
      name: defaultOrgRulesetName,
      enforcement: "evaluate",
      sourceWorkflow: {
        repositoryId: "1001",
        repositoryFullName: "agent-teams-ai/alpha",
        path: ".github/workflows/reviewrouter-required.yml",
        ref: "refs/heads/main",
      },
      targetSelection: {
        scope: "selected_repositories",
        repositoryIds: ["1001", "1002"],
      },
    });

    expect(payload).toMatchObject({
      name: "ReviewRouter required workflow",
      target: "branch",
      enforcement: "evaluate",
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        repository_id: { repository_ids: [1001, 1002] },
      },
      rules: [
        {
          type: "workflows",
          parameters: {
            do_not_enforce_on_create: true,
            workflows: [
              {
                repository_id: 1001,
                path: ".github/workflows/reviewrouter-required.yml",
                ref: "refs/heads/main",
              },
            ],
          },
        },
      ],
    });
  });

  it("builds all repository ruleset payload", () => {
    const payload = buildGitHubOrgRulesetPayload({
      enforcement: "active",
      sourceWorkflow: {
        repositoryId: "1001",
        repositoryFullName: "agent-teams-ai/alpha",
        path: ".github/workflows/reviewrouter-required.yml",
        ref: "refs/heads/main",
      },
      targetSelection: { scope: "all_repositories" },
    });

    expect(payload.conditions).toEqual({
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_name: { include: ["~ALL"], exclude: [], protected: false },
    });
  });

  it("rejects unsafe central workflow paths", () => {
    expect(() =>
      normalizeWorkflowPath(".github/workflows/../deploy.yml"),
    ).toThrow("workflow_path_invalid");
    expect(() => normalizeWorkflowPath("deploy.yml")).toThrow(
      "workflow_path_invalid",
    );
  });

  it("maps worker-side 403 responses to the permission-upgrade code", () => {
    const error = new Error("forbidden") as Error & { status: number };
    error.status = 403;

    expect(safeOrgRulesetErrorCode(error)).toBe(
      "org_admin_permission_required",
    );
  });

  it("does not enqueue provisioning when org ruleset permission is missing", async () => {
    const provisioning = new InMemoryOrgRulesetProvisioningRepository(target);
    const gateway = new StaticOrgRulesetSetupGateway({
      ok: false,
      safeErrorCode: "org_admin_permission_required",
      safeErrorSummary: "permission missing",
    });
    const outbox = new InMemoryOutbox();
    const auditLog = new InMemoryAuditLog();

    await expect(
      requestOrgRulesetProvisioning(
        {
          workspaceId: target.workspaceId,
          githubInstallationId: target.githubInstallationId,
          scope: "selected_repositories",
          enforcement: "evaluate",
          actor: "777genius",
          requestedAt,
        },
        { provisioning, setupGateway: gateway, outbox, auditLog },
      ),
    ).rejects.toThrow("org_admin_permission_required");

    expect(outbox.events).toHaveLength(0);
    expect(provisioning.record).toBeNull();
    expect(auditLog.actions).toContain("org_ruleset.permission_required");
  });

  it("queues provisioning after a successful ruleset permission probe", async () => {
    const provisioning = new InMemoryOrgRulesetProvisioningRepository(target);
    const outbox = new InMemoryOutbox();

    const result = await requestOrgRulesetProvisioning(
      {
        workspaceId: target.workspaceId,
        githubInstallationId: target.githubInstallationId,
        scope: "selected_repositories",
        enforcement: "evaluate",
        actor: "777genius",
        requestedAt,
      },
      {
        provisioning,
        setupGateway: new StaticOrgRulesetSetupGateway({ ok: true }),
        outbox,
      },
    );

    expect(result.status).toBe("queued");
    expect(provisioning.record).toMatchObject({
      githubInstallationId: target.githubInstallationId,
      sourceRepositoryFullName: "agent-teams-ai/alpha",
      targetRepositoryIds: ["1001", "1002"],
    });
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: "org_ruleset.provision_requested",
        payload: { provisioningId: result.provisioningId },
      }),
    ]);
  });

  it("requires all-repositories App access before queueing all-repositories rulesets", async () => {
    const provisioning = new InMemoryOrgRulesetProvisioningRepository(target);

    await expect(
      requestOrgRulesetProvisioning(
        {
          workspaceId: target.workspaceId,
          githubInstallationId: target.githubInstallationId,
          scope: "all_repositories",
          enforcement: "active",
          actor: "777genius",
          requestedAt,
        },
        {
          provisioning,
          setupGateway: new StaticOrgRulesetSetupGateway({ ok: true }),
          outbox: new InMemoryOutbox(),
        },
      ),
    ).rejects.toThrow("org_ruleset_all_repositories_requires_all_access");
    expect(provisioning.record).toBeNull();
  });

  it("writes the central workflow and ruleset idempotently from the worker", async () => {
    const provisioning = new InMemoryOrgRulesetProvisioningRepository(target);
    const queued = await provisioning.upsertRequested(
      createRequest({ scope: "selected_repositories" }),
    );
    const gateway = new StaticOrgRulesetSetupGateway({ ok: true });

    await provisionOrgRulesetRequiredWorkflow(
      {
        provisioningId: queued.id,
        actionRef: "777genius/review-router@main",
        apiUrl: "https://api.reviewrouter.site",
        runtimeConfigMode: "oidc",
        attemptedAt: requestedAt,
      },
      {
        provisioning,
        createSetupGateway: async (githubInstallationId) => {
          expect(githubInstallationId).toBe(target.githubInstallationId);
          return gateway;
        },
      },
    );

    expect(gateway.workflowWrites).toEqual([
      expect.objectContaining({
        owner: "agent-teams-ai",
        repo: "alpha",
        path: ".github/workflows/reviewrouter-required.yml",
      }),
    ]);
    expect(gateway.rulesetWrites).toEqual([
      expect.objectContaining({ organizationLogin: "agent-teams-ai" }),
    ]);
    expect(provisioning.record).toMatchObject({
      status: "configured",
      rulesetId: "321",
      rulesetUrl:
        "https://github.com/organizations/agent-teams-ai/settings/rules/321",
      sourceWorkflowSha: "source-sha",
    });
  });
});

function createRequest(input: {
  readonly scope: "selected_repositories" | "all_repositories";
}): OrgRulesetProvisioningRequest {
  return createOrgRulesetProvisioningRequest({
    workspaceId: target.workspaceId,
    installationId: target.installationId,
    githubInstallationId: target.githubInstallationId,
    organizationLogin: target.organizationLogin,
    sourceRepositoryId: "repo_1",
    sourceGithubRepositoryId: "1001",
    sourceRepositoryFullName: "agent-teams-ai/alpha",
    sourceWorkflowPath: ".github/workflows/reviewrouter-required.yml",
    sourceWorkflowRef: "refs/heads/main",
    scope: input.scope,
    enforcement: "evaluate",
    targetRepositoryIds: ["1001", "1002"],
    requestedBy: "777genius",
    requestedAt,
  });
}

class InMemoryOrgRulesetProvisioningRepository implements OrgRulesetProvisioningRepositoryPort {
  public record: OrgRulesetProvisioningRecord | null = null;

  constructor(private readonly target: OrgRulesetProvisioningTarget) {}

  async findTargetByInstallation(input: {
    readonly workspaceId: string;
    readonly githubInstallationId: string;
  }): Promise<OrgRulesetProvisioningTarget | null> {
    if (
      input.workspaceId !== this.target.workspaceId ||
      input.githubInstallationId !== this.target.githubInstallationId
    ) {
      return null;
    }
    return this.target;
  }

  async findById(id: string): Promise<OrgRulesetProvisioningRecord | null> {
    return this.record?.id === id ? this.record : null;
  }

  async findByWorkspaceId(): Promise<OrgRulesetProvisioningRecord | null> {
    return this.record;
  }

  async listConfiguredTrustedWorkflows(): Promise<readonly string[]> {
    return [];
  }

  async upsertRequested(
    request: OrgRulesetProvisioningRequest,
  ): Promise<OrgRulesetProvisioningRecord> {
    this.record = {
      id: this.record?.id ?? "ruleset_1",
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      githubInstallationId: request.githubInstallationId,
      organizationLogin: request.organizationLogin,
      status: "requested",
      scope: request.scope,
      enforcement: request.enforcement,
      sourceRepositoryId: request.sourceRepositoryId ?? null,
      sourceGithubRepositoryId: request.sourceGithubRepositoryId ?? null,
      sourceRepositoryFullName: request.sourceRepositoryFullName ?? null,
      sourceWorkflowPath: request.sourceWorkflowPath,
      sourceWorkflowRef: request.sourceWorkflowRef,
      sourceWorkflowSha: null,
      rulesetId: null,
      rulesetUrl: null,
      targetRepositoryIds: request.targetRepositoryIds,
      safeErrorCode: null,
      safeErrorSummary: null,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt,
      lastAttemptAt: null,
      configuredAt: null,
      updatedAt: request.requestedAt,
    };
    return this.record;
  }

  async markProcessing(input: {
    readonly id: string;
    readonly attemptedAt: Date;
  }): Promise<void> {
    if (!this.record || this.record.id !== input.id) return;
    this.record = {
      ...this.record,
      status: "processing",
      lastAttemptAt: input.attemptedAt,
      safeErrorCode: null,
      safeErrorSummary: null,
    };
  }

  async markConfigured(input: {
    readonly id: string;
    readonly sourceWorkflowSha: string | null;
    readonly rulesetId: string;
    readonly rulesetUrl: string | null;
    readonly configuredAt: Date;
  }): Promise<void> {
    if (!this.record || this.record.id !== input.id) return;
    this.record = {
      ...this.record,
      status: "configured",
      sourceWorkflowSha: input.sourceWorkflowSha,
      rulesetId: input.rulesetId,
      rulesetUrl: input.rulesetUrl,
      configuredAt: input.configuredAt,
    };
  }

  async markFailed(input: {
    readonly id: string;
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    if (!this.record || this.record.id !== input.id) return;
    this.record = {
      ...this.record,
      status: "failed",
      safeErrorCode: input.safeErrorCode,
      safeErrorSummary: input.safeErrorSummary,
    };
  }
}

class StaticOrgRulesetSetupGateway implements OrgRulesetSetupGatewayPort {
  public readonly workflowWrites: unknown[] = [];
  public readonly rulesetWrites: unknown[] = [];

  constructor(private readonly probe: OrgRulesetPermissionProbeResult) {}

  async probeOrganizationRulesetAccess(): Promise<OrgRulesetPermissionProbeResult> {
    return this.probe;
  }

  async writeSourceWorkflow(input: {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<SourceWorkflowWriteResult> {
    this.workflowWrites.push(input);
    return { sha: "source-sha" };
  }

  async createOrUpdateOrganizationRuleset(
    input: unknown,
  ): Promise<OrgRulesetWriteResult> {
    this.rulesetWrites.push(input);
    return {
      id: "321",
      url: "https://github.com/organizations/agent-teams-ai/settings/rules/321",
    };
  }
}

class InMemoryOutbox implements OutboxEventRepositoryPort {
  public readonly events: unknown[] = [];

  async enqueue(input: unknown): Promise<{ readonly created: boolean }> {
    this.events.push(input);
    return { created: true };
  }

  async recoverStaleProcessing(): Promise<{ readonly recovered: number }> {
    return { recovered: 0 };
  }

  async claimDue(): Promise<readonly []> {
    return [];
  }

  async markProcessed(): Promise<void> {
    return undefined;
  }

  async markRetry(): Promise<void> {
    return undefined;
  }

  async markDeadLetter(): Promise<void> {
    return undefined;
  }
}

class InMemoryAuditLog implements AuditLogRepositoryPort {
  public readonly actions: string[] = [];

  async append(input: { readonly action: string }): Promise<void> {
    this.actions.push(input.action);
  }
}
