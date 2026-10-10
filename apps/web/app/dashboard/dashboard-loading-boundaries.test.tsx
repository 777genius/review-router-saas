import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardWorkspaceLayout,
  listDashboardRepositoryAccess,
  loadDashboardSectionData,
} from "./dashboard-workspace-page";
import type { DashboardWorkspaceSummary } from "./dashboard-workspace-navigation";

const fixtures = vi.hoisted(() => {
  const repository = {
    id: "repo-a",
    workspaceId: "workspace-a",
    owner: "acme",
    fullName: "acme/test",
    visibility: "private",
    selected: true,
    archived: false,
  };
  const spies = {
    repositories: vi.fn(async () => [
      repository,
      { ...repository, id: "repo-hidden" },
    ]),
    entitlement: vi.fn(async () => ({ flags: { hosted_codex_pool: true } })),
    health: vi.fn(async () => []),
    config: vi.fn(async () => null),
    batchConfig: vi.fn(
      async (input: { readonly repositoryIds: readonly string[] }) =>
        input.repositoryIds.map((repositoryId) => ({
          repositoryId,
          config: null,
        })),
    ),
    outbox: vi.fn(async () => []),
    provisioning: vi.fn(async () => []),
    providerSetup: vi.fn(async () => []),
    readiness: vi.fn(async () => []),
    organizationRequest: vi.fn(async () => ({
      data: { plan: { name: "team" } },
    })),
    discovery: vi.fn(async () => ({
      status: "ready" as const,
      workspaceIds: ["workspace-a"],
      repositoryIds: new Set(["repo-a"]),
      directConfigRepositoryIds: new Set<string>(),
      checkedAt: new Date("2026-09-01"),
    })),
    requestedCandidates: vi.fn(async () => []),
    diagnostics: vi.fn(async () => null),
    ruleset: vi.fn(async () => null),
    memoryItems: vi.fn(async () => ({ items: [] })),
    memorySuggestions: vi.fn(async () => ({ suggestions: [] })),
    memoryPolicy: vi.fn(async () => ({ memoryEnabled: true })),
    memorySimulation: vi.fn(),
    audit: vi.fn(async () => ({
      auditEvents: [
        {
          action: "test",
          actor: "owner",
          targetType: "workspace",
          createdAt: new Date("2026-09-01"),
        },
      ],
    })),
    summaries: vi.fn(async () => [
      {
        id: "workspace-a",
        name: "acme",
        slug: "acme",
        installations: [],
        gitLabInstallations: [],
        repositories: [{ owner: "acme" }],
        _count: { repositories: 2 },
      },
    ]),
    hostedPool: vi.fn(async () => ({
      gate: "enabled",
      pool: null,
      accounts: [],
      repositories: [],
    })),
  };
  return { spies, EmptyStore: class {} };
});
const { spies } = fixtures;

vi.mock("./actions", () => ({}));
vi.mock("../../src/server/prisma", () => ({
  getPrisma: () => ({
    providerSetupState: { findMany: fixtures.spies.providerSetup },
    workspace: {
      findMany: fixtures.spies.summaries,
      findUnique: fixtures.spies.audit,
    },
    repositoryConnection: {
      findMany: fixtures.spies.requestedCandidates,
    },
  }),
}));
vi.mock("../../src/server/dashboard-mutations", () => ({
  createGitHubAppInstallationOctokit: async () => ({
    request: fixtures.spies.organizationRequest,
  }),
  getDashboardMutationStatus: async () => ({
    signedIn: true,
    enabled: true,
    sourceLogin: "owner",
    sourceAvatarUrl: null,
  }),
  getDashboardWorkspaceScope: async () => ({
    kind: "all",
    reason: "local_admin_override",
  }),
  getDashboardSignedInActor: async () => null,
  asDashboardGitHubActor: (actor: unknown) => actor,
}));
vi.mock("../../src/server/github-app-install-url", () => ({
  getGitHubAppInstallUrl: () => null,
}));
vi.mock("../../src/server/github-user-repository-access", () => ({
  listGitHubUserRepositoryAccess: fixtures.spies.discovery,
}));
vi.mock("../../src/server/prisma-codex-rotating-setup-readiness", () => ({
  PrismaCodexRotatingSetupReadiness: fixtures.EmptyStore,
}));
vi.mock("../../src/server/dashboard-codex-rotating-setup-readiness", () => ({
  deriveDashboardProviderSetupReadiness: fixtures.spies.readiness,
}));
vi.mock("../../src/server/openrouter-model-catalog", () => ({
  getReviewModelOptions: vi.fn(async () => []),
}));
vi.mock("../../src/server/hosted-pool-dashboard", () => ({
  loadHostedPoolDashboardView: fixtures.spies.hostedPool,
}));
vi.mock("@reviewrouter/platform-config", () => ({
  isHostedCodexPoolEnabled: () => true,
  requireReviewRouterDatabaseRecoveryWitness: () => "test-witness",
  resolveReviewRouterActionRef: () => "test-sha",
}));
vi.mock("@reviewrouter/features-repositories", () => ({
  PrismaRepositoryConnectionRepository: class {
    listWorkspaceRepositories = fixtures.spies.repositories;
  },
}));
vi.mock("@reviewrouter/features-repo-health", () => ({
  PrismaRepositoryHealthRepository: fixtures.EmptyStore,
  listWorkspaceRepositoryHealth: fixtures.spies.health,
}));
vi.mock("@reviewrouter/features-entitlements", () => ({
  PrismaEntitlementRepository: class {
    findWorkspaceEntitlement = fixtures.spies.entitlement;
  },
  freeBetaEntitlement: () => ({ flags: { hosted_codex_pool: true } }),
  evaluateFeatureEntitlement: () => ({ allowed: true }),
}));
vi.mock("@reviewrouter/features-review-config", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@reviewrouter/features-review-config")
  >()),
  PrismaReviewConfigurationRepository: fixtures.EmptyStore,
  findReviewConfiguration: fixtures.spies.config,
  findRepositoryReviewConfigurations: fixtures.spies.batchConfig,
}));
vi.mock("@reviewrouter/features-outbox", () => ({
  PrismaOutboxEventRepository: fixtures.EmptyStore,
  listWorkspaceOutboxFailures: fixtures.spies.outbox,
}));
vi.mock("@reviewrouter/features-support-diagnostics", () => ({
  PrismaSupportDiagnosticsRepository: fixtures.EmptyStore,
  getWorkspaceSupportDiagnostics: fixtures.spies.diagnostics,
}));
vi.mock("@reviewrouter/features-org-ruleset-provisioning", () => ({
  PrismaOrgRulesetProvisioningRepository: class {
    findByWorkspaceId = fixtures.spies.ruleset;
  },
}));
vi.mock("@reviewrouter/features-workflow-provisioning", () => ({
  PrismaWorkflowProvisioningQuery: fixtures.EmptyStore,
  listRepositoryWorkflowProvisioning: fixtures.spies.provisioning,
}));
vi.mock("@reviewrouter/features-audit-log", () => ({
  PrismaAuditLogRepository: fixtures.EmptyStore,
}));
vi.mock("@reviewrouter/features-hosted-account-pool", () => ({
  PrismaHostedPoolQuery: fixtures.EmptyStore,
}));
vi.mock("@reviewrouter/features-provider-setup", () => ({}));
vi.mock("@reviewrouter/features-memory", () => ({
  PrismaMemoryPermission: fixtures.EmptyStore,
  PrismaMemoryItemRepository: fixtures.EmptyStore,
  PrismaMemorySuggestionRepository: fixtures.EmptyStore,
  EntitlementMemoryQuotaPolicy: fixtures.EmptyStore,
  EntitlementMemoryPolicyConfig: class {
    getPolicy = fixtures.spies.memoryPolicy;
  },
  readMemoryServiceEnabled: () => true,
  simulateMemoryPolicyDecision: fixtures.spies.memorySimulation,
  listMemoryItemsForDashboard: fixtures.spies.memoryItems,
  listMemorySuggestionsForDashboard: fixtures.spies.memorySuggestions,
}));

const workspace: DashboardWorkspaceSummary = {
  workspace: {
    id: "workspace-a",
    name: "acme",
    slug: "acme",
    installations: [],
    gitLabInstallations: [],
    auditEvents: [],
  },
  repositoryCount: 2,
  hasWorkspaceWideAccess: true,
};
const access = {
  status: "ready" as const,
  workspaceIds: ["workspace-a"],
  repositoryIds: new Set(["repo-a"]),
  directConfigRepositoryIds: new Set<string>(),
  checkedAt: null,
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("dashboard server loading boundaries", () => {
  it("starts workspace-only reads while the repository list is pending", async () => {
    let resolveRepositories!: (
      value: Awaited<ReturnType<typeof spies.repositories>>,
    ) => void;
    spies.repositories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRepositories = resolve;
        }),
    );
    const withInstallation = {
      ...workspace,
      workspace: {
        ...workspace.workspace,
        installations: [
          {
            accountLogin: "Acme",
            accountType: "Organization",
            accountAvatarUrl: null,
            githubInstallationId: "900004",
            status: "active",
            repositorySelection: "all",
            organizationSecretPolicy: null,
          },
        ],
      },
    };

    const loading = loadDashboardSectionData(
      withInstallation,
      "repositories",
      access,
    );
    try {
      expect(spies.repositories).toHaveBeenCalledOnce();
      expect(spies.health).toHaveBeenCalledOnce();
      expect(spies.config).toHaveBeenCalledOnce();
      expect(spies.ruleset).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(spies.organizationRequest).toHaveBeenCalledOnce(),
      );
      expect(spies.batchConfig).not.toHaveBeenCalled();
      expect(spies.provisioning).not.toHaveBeenCalled();
      expect(spies.hostedPool).not.toHaveBeenCalled();
    } finally {
      resolveRepositories([
        {
          id: "repo-a",
          workspaceId: "workspace-a",
          owner: "acme",
          fullName: "acme/test",
          visibility: "private",
          selected: true,
          archived: false,
        },
      ]);
      await loading;
    }
  });

  it("observes early read failures while repositories are pending", async () => {
    let resolveRepositories!: (
      value: Awaited<ReturnType<typeof spies.repositories>>,
    ) => void;
    spies.repositories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRepositories = resolve;
        }),
    );
    spies.health.mockRejectedValueOnce(new Error("health unavailable"));

    const loading = loadDashboardSectionData(workspace, "repositories", access);
    await Promise.resolve();
    resolveRepositories([]);
    await expect(loading).rejects.toThrow("health unavailable");
  });

  it("waits for repository visibility before exposing scoped installations", async () => {
    let resolveRepositories!: (
      value: Awaited<ReturnType<typeof spies.repositories>>,
    ) => void;
    spies.repositories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRepositories = resolve;
        }),
    );
    const scopedWorkspace = {
      ...workspace,
      hasWorkspaceWideAccess: false,
      workspace: {
        ...workspace.workspace,
        installations: ["acme", "hidden"].map((accountLogin, index) => ({
          accountLogin,
          accountType: "Organization",
          accountAvatarUrl: null,
          githubInstallationId: String(900010 + index),
          status: "active",
          repositorySelection: "all",
          organizationSecretPolicy: null,
        })),
      },
    };

    const loading = loadDashboardSectionData(
      scopedWorkspace,
      "repositories",
      access,
    );
    expect(spies.organizationRequest).not.toHaveBeenCalled();
    resolveRepositories([
      {
        id: "repo-a",
        workspaceId: "workspace-a",
        owner: "acme",
        fullName: "acme/test",
        visibility: "private",
        selected: true,
        archived: false,
      },
      {
        id: "repo-hidden",
        workspaceId: "workspace-a",
        owner: "hidden",
        fullName: "hidden/test",
        visibility: "private",
        selected: true,
        archived: false,
      },
    ]);
    const data = await loading;
    expect(
      data.workspace.installations.map(({ accountLogin }) => accountLogin),
    ).toEqual(["acme"]);
    expect(spies.organizationRequest).not.toHaveBeenCalled();
  });

  it("starts provider readiness before an unrelated hosted pool read completes", async () => {
    let resolveHostedPool!: (
      value: Awaited<ReturnType<typeof spies.hostedPool>>,
    ) => void;
    const hostedPoolPending = new Promise<
      Awaited<ReturnType<typeof spies.hostedPool>>
    >((resolve) => {
      resolveHostedPool = resolve;
    });
    spies.hostedPool.mockImplementationOnce(() => hostedPoolPending);

    const loading = loadDashboardSectionData(workspace, "repositories", access);
    await vi.waitFor(() => expect(spies.providerSetup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(spies.readiness).toHaveBeenCalledOnce());
    expect(spies.readiness).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSetup: [],
        workspaceId: "workspace-a",
      }),
    );

    resolveHostedPool({
      gate: "enabled",
      pool: null,
      accounts: [],
      repositories: [],
    });
    await loading;
  });

  it("single-flights and caches organization plan presentation metadata", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let resolveOrganization!: (value: {
      data: { plan: { name: string } };
    }) => void;
    spies.organizationRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOrganization = resolve;
        }),
    );
    const withInstallation = {
      ...workspace,
      workspace: {
        ...workspace.workspace,
        installations: [
          {
            accountLogin: "Acme",
            accountType: "Organization",
            accountAvatarUrl: null,
            githubInstallationId: "900001",
            status: "active",
            repositorySelection: "all",
            organizationSecretPolicy: null,
          },
        ],
      },
    };

    const first = loadDashboardSectionData(
      withInstallation,
      "repositories",
      access,
    );
    const second = loadDashboardSectionData(
      withInstallation,
      "repositories",
      access,
    );
    await vi.waitFor(() =>
      expect(spies.organizationRequest).toHaveBeenCalledOnce(),
    );
    resolveOrganization({ data: { plan: { name: "Team" } } });
    const results = await Promise.all([first, second]);
    expect(
      results[0]?.workspace.installations[0]?.organizationSecretPolicy,
    ).toEqual({
      planName: "team",
      privateRepositoriesAvailable: true,
      status: "available",
    });
    await loadDashboardSectionData(withInstallation, "repositories", access);
    expect(spies.organizationRequest).toHaveBeenCalledOnce();

    await loadDashboardSectionData(
      {
        ...withInstallation,
        workspace: {
          ...withInstallation.workspace,
          installations: [
            {
              ...withInstallation.workspace.installations[0]!,
              accountLogin: "Other",
            },
          ],
        },
      },
      "repositories",
      access,
    );
    expect(spies.organizationRequest).toHaveBeenCalledTimes(2);

    now.mockReturnValue(5 * 60 * 1000 + 1000);
    await loadDashboardSectionData(withInstallation, "repositories", access);
    expect(spies.organizationRequest).toHaveBeenCalledTimes(3);
  });

  it("preserves permission and missing-plan statuses on organization lookup failure", async () => {
    spies.organizationRequest
      .mockRejectedValueOnce({ status: 403 })
      .mockRejectedValueOnce({ status: 404 });
    const installation = (githubInstallationId: string) => ({
      ...workspace,
      workspace: {
        ...workspace.workspace,
        installations: [
          {
            accountLogin: "Acme",
            accountType: "Organization",
            accountAvatarUrl: null,
            githubInstallationId,
            status: "active",
            repositorySelection: "all",
            organizationSecretPolicy: null,
          },
        ],
      },
    });
    const denied = await loadDashboardSectionData(
      installation("900002"),
      "repositories",
      access,
    );
    const missing = await loadDashboardSectionData(
      installation("900003"),
      "repositories",
      access,
    );
    expect(
      denied.workspace.installations[0]?.organizationSecretPolicy?.status,
    ).toBe("permission_required");
    expect(
      missing.workspace.installations[0]?.organizationSecretPolicy?.status,
    ).toBe("unknown");
  });
  it("shares one persistent route layout across dashboard and Accounts while keeping previews outside it", () => {
    const route = (path: string) => new URL(path, import.meta.url);
    const workspacePageSource = readFileSync(
      route("./dashboard-workspace-page.tsx"),
      "utf8",
    );
    expect(readFileSync(route("./(workspace)/layout.tsx"), "utf8")).toContain(
      "DashboardWorkspaceLayout as default",
    );
    expect(readFileSync(route("./(workspace)/loading.tsx"), "utf8")).toContain(
      "DashboardSectionLoading as default",
    );
    expect(existsSync(route("./(workspace)/page.tsx"))).toBe(true);
    expect(existsSync(route("./(workspace)/setup/page.tsx"))).toBe(true);
    expect(existsSync(route("./memory-preview/page.tsx"))).toBe(true);
    expect(existsSync(route("./hosted-pool-preview/page.tsx"))).toBe(true);
    expect(existsSync(route("./loading.tsx"))).toBe(false);
    expect(workspacePageSource).toContain("readParam(params.repository)");
    expect(workspacePageSource).toContain(
      "<NavigationContentReady completionKey={sectionBoundaryKey} />",
    );
    expect(workspacePageSource.match(/<NavigationContentReady/g)).toHaveLength(
      2,
    );
    expect(workspacePageSource).not.toContain(
      "selectedSection,\n          params,",
    );
  });

  it("renders shell data without section queries", async () => {
    const shell = await DashboardWorkspaceLayout({ children: "content" });
    expect((shell.props as { workspaces: unknown[] }).workspaces).toHaveLength(
      1,
    );
    expect(spies.summaries).toHaveBeenCalledOnce();
    for (const spy of Object.values(spies).filter(
      (spy) => spy !== spies.summaries,
    ))
      expect(spy).not.toHaveBeenCalled();
  });

  it("reuses base discovery when augmenting a direct repository URL", async () => {
    const actor = {
      userId: "user-a",
      sourceProvider: "github" as const,
      externalUserId: "github-user-a",
      sourceLogin: "owner",
      githubUserId: "github-user-a",
      githubLogin: "owner",
      actor: "github:owner",
    };
    const workspaceScope = {
      kind: "workspace_ids" as const,
      workspaceIds: [] as string[],
    };
    const baseAccess = await listDashboardRepositoryAccess({
      actor,
      workspaceScope,
      requestedRepositoryFullName: "",
    });

    await listDashboardRepositoryAccess({
      actor,
      workspaceScope,
      requestedRepositoryFullName: "acme/test",
      baseAccess,
    });

    expect(spies.discovery).toHaveBeenCalledOnce();
    expect(spies.requestedCandidates).toHaveBeenCalledOnce();
  });

  it.each(["repositories", "policy", "diagnostics", "setup"] as const)(
    "does not load Memory when visiting %s",
    async (section) => {
      await loadDashboardSectionData(workspace, section, access);
      if (section === "setup") {
        expect(spies.repositories).not.toHaveBeenCalled();
      } else {
        expect(spies.repositories).toHaveBeenCalledExactlyOnceWith(
          "workspace-a",
        );
      }
      expect(spies.memoryItems).not.toHaveBeenCalled();
      expect(spies.memorySuggestions).not.toHaveBeenCalled();
      expect(spies.memoryPolicy).not.toHaveBeenCalled();
      expect(spies.memorySimulation).not.toHaveBeenCalled();
    },
  );

  it("loads account summaries without reading per-repository hosted bindings", async () => {
    const data = await loadDashboardSectionData(workspace, "setup", access);
    expect(data.repositoryCount).toBe(2);
    expect(spies.repositories).not.toHaveBeenCalled();
    expect(spies.hostedPool).toHaveBeenCalledWith(
      expect.objectContaining({
        featureEnabled: true,
        repositories: [],
      }),
    );
  });

  it.each(["setup", "memory"] as const)(
    "skips configuration, readiness, diagnostics and audit for %s",
    async (section) => {
      await loadDashboardSectionData(workspace, section, access);
      for (const spy of [
        spies.config,
        spies.batchConfig,
        spies.health,
        spies.provisioning,
        spies.providerSetup,
        spies.readiness,
        spies.diagnostics,
        spies.outbox,
        spies.ruleset,
        spies.audit,
      ])
        expect(spy).not.toHaveBeenCalled();
    },
  );

  it("loads Memory only for the selected workspace", async () => {
    await loadDashboardSectionData(workspace, "memory", access);
    expect(spies.memoryItems).toHaveBeenCalledWith(
      { workspaceId: "workspace-a", limit: 25 },
      expect.anything(),
    );
    expect(spies.memorySuggestions).toHaveBeenCalledOnce();
    expect(spies.memoryPolicy).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
    });
    expect(spies.hostedPool).toHaveBeenCalledWith(
      expect.objectContaining({ featureEnabled: false }),
    );
  });

  it("restricts Memory reads to repositories visible to a scoped actor", async () => {
    await loadDashboardSectionData(
      { ...workspace, hasWorkspaceWideAccess: false },
      "memory",
      access,
    );
    expect(spies.memoryItems).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-a",
        repositoryIds: ["repo-a"],
        limit: 25,
      },
      expect.anything(),
    );
    expect(spies.memorySuggestions).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-a",
        repositoryIds: ["repo-a"],
        limit: 25,
      },
      expect.anything(),
    );
  });

  it("keeps selected-workspace audit and support diagnostics in Diagnostics", async () => {
    const data = await loadDashboardSectionData(
      workspace,
      "diagnostics",
      access,
    );
    expect(data.workspace.auditEvents[0]?.action).toBe("test");
    expect(spies.audit).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "workspace-a" } }),
    );
    expect(spies.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a" }),
      expect.anything(),
    );
    expect(spies.ruleset).not.toHaveBeenCalled();
  });

  it("keeps repository-scoped access from receiving other repository configs or workspace diagnostics", async () => {
    const data = await loadDashboardSectionData(
      { ...workspace, hasWorkspaceWideAccess: false },
      "diagnostics",
      access,
    );
    expect(data.repositories.map((repository) => repository.id)).toEqual([
      "repo-a",
    ]);
    expect(data.repositoryConfigs.map((config) => config.repositoryId)).toEqual(
      ["repo-a"],
    );
    expect(spies.batchConfig).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: "workspace-a",
        repositoryIds: ["repo-a"],
      },
      expect.anything(),
    );
    expect(spies.diagnostics).not.toHaveBeenCalled();
    expect(spies.outbox).not.toHaveBeenCalled();
    expect(spies.audit).not.toHaveBeenCalled();
  });
});
