import { describe, expect, it, vi } from "vitest";
import type { HostedPoolQueryPort } from "@reviewrouter/features-hosted-account-pool";
import {
  changeHostedRepositorySessionSource,
  importHostedPoolAccount,
  loadHostedPoolDashboardView,
  type HostedPoolDashboardMutationDependencies,
} from "./hosted-pool-dashboard";

function mutationDependencies(
  overrides: Partial<HostedPoolDashboardMutationDependencies> = {},
): HostedPoolDashboardMutationDependencies {
  return {
    featureEnabled: true,
    authorizeWorkspaceAdmin: vi.fn(async () => ({ actor: "user:owner" })),
    assertEntitled: vi.fn(async () => undefined),
    getRepository: vi.fn(async () => ({
      id: "repo-1",
      workspaceId: "workspace-1",
      fullName: "acme/private",
      visibility: "private",
    })),
    mutations: {
      importAccount: vi.fn(async () => undefined),
      setAccountState: vi.fn(async () => undefined),
      setRepositorySource: vi.fn(async () => ({
        activation: "pending" as const,
      })),
    },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("hosted pool dashboard boundary", () => {
  it("authorizes and checks entitlement before forwarding auth bytes", async () => {
    const order: string[] = [];
    const dependencies = mutationDependencies({
      authorizeWorkspaceAdmin: vi.fn(async () => {
        order.push("authorize");
        return { actor: "user:owner" };
      }),
      assertEntitled: vi.fn(async () => {
        order.push("entitlement");
      }),
      mutations: {
        importAccount: vi.fn(async () => {
          order.push("import");
        }),
        setAccountState: vi.fn(async () => undefined),
        setRepositorySource: vi.fn(async () => ({
          activation: "pending" as const,
        })),
      },
    });

    await importHostedPoolAccount(
      {
        workspaceId: "workspace-1",
        label: "Primary",
        priority: 10,
        authJson: async () => {
          order.push("read");
          return new TextEncoder().encode("secret bytes");
        },
      },
      dependencies,
    );
    expect(order).toEqual(["authorize", "entitlement", "read", "import"]);
  });

  it("zeroes uploaded auth bytes when credential enrollment fails", async () => {
    const authJson = new TextEncoder().encode("secret bytes");
    const dependencies = mutationDependencies({
      mutations: {
        importAccount: vi.fn(async () => {
          throw new Error("credential_enrollment_failed");
        }),
        setAccountState: vi.fn(async () => undefined),
        setRepositorySource: vi.fn(async () => ({
          activation: "pending" as const,
        })),
      },
    });

    await expect(
      importHostedPoolAccount(
        {
          workspaceId: "workspace-1",
          label: "Primary",
          priority: 10,
          authJson,
        },
        dependencies,
      ),
    ).rejects.toThrow("credential_enrollment_failed");
    expect(authJson.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects unknown visibility before a hosted binding mutation", async () => {
    const dependencies = mutationDependencies({
      getRepository: vi.fn(async () => ({
        id: "repo-1",
        workspaceId: "workspace-1",
        fullName: "acme/public",
        visibility: "unknown",
      })),
    });
    await expect(
      changeHostedRepositorySessionSource(
        {
          workspaceId: "workspace-1",
          repositoryId: "repo-1",
          source: "hosted_workspace_pool",
          expectedVersion: 0,
        },
        dependencies,
      ),
    ).rejects.toThrow("hosted_pool_repository_visibility_ineligible");
    expect(dependencies.mutations.setRepositorySource).not.toHaveBeenCalled();
  });

  it.each(["public", "private", "internal"])(
    "allows %s visibility consistently in mutation and read model",
    async (visibility) => {
      const repository = {
        id: "repo-1",
        workspaceId: "workspace-1",
        fullName: "acme/repo",
        visibility,
      };
      const dependencies = mutationDependencies({
        getRepository: vi.fn(async () => repository),
      });
      await expect(
        changeHostedRepositorySessionSource(
          {
            workspaceId: "workspace-1",
            repositoryId: "repo-1",
            source: "hosted_workspace_pool",
            expectedVersion: 0,
          },
          dependencies,
        ),
      ).resolves.toEqual({ activation: "pending" });
      expect(dependencies.mutations.setRepositorySource).toHaveBeenCalledOnce();
      const view = await loadHostedPoolDashboardView({
        workspaceId: "workspace-1",
        repositories: [repository],
        featureEnabled: true,
        entitled: true,
        queries: {
          getDefaultPoolSummary: vi.fn(async () => null),
          listAccountSummaries: vi.fn(async () => []),
          getRepositoryBindingSummary: vi.fn(async () => null),
        },
      });
      expect(view.repositories[0]).toMatchObject({
        eligible: true,
        activation: "legacy",
      });
    },
  );

  it("does not treat public visibility as workspace authorization", async () => {
    const dependencies = mutationDependencies({
      getRepository: vi.fn(async () => ({
        id: "repo-1",
        workspaceId: "other-workspace",
        fullName: "acme/public",
        visibility: "public",
      })),
    });
    await expect(
      changeHostedRepositorySessionSource(
        {
          workspaceId: "workspace-1",
          repositoryId: "repo-1",
          source: "hosted_workspace_pool",
          expectedVersion: 0,
        },
        dependencies,
      ),
    ).rejects.toThrow("repository_not_found");
    expect(dependencies.mutations.setRepositorySource).not.toHaveBeenCalled();
  });

  it("forwards the explicit version and reports pending activation without fallback", async () => {
    const dependencies = mutationDependencies();
    await expect(
      changeHostedRepositorySessionSource(
        {
          workspaceId: "workspace-1",
          repositoryId: "repo-1",
          source: "hosted_workspace_pool",
          expectedVersion: 4,
        },
        dependencies,
      ),
    ).resolves.toEqual({ activation: "pending" });
    expect(dependencies.mutations.setRepositorySource).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 4 }),
    );
  });

  it("treats a missing binding as legacy mode", async () => {
    const queries: HostedPoolQueryPort = {
      getDefaultPoolSummary: vi.fn(async () => null),
      listAccountSummaries: vi.fn(async () => []),
      getRepositoryBindingSummary: vi.fn(async () => null),
    };
    const view = await loadHostedPoolDashboardView({
      workspaceId: "workspace-1",
      repositories: [
        { id: "repo-1", fullName: "acme/private", visibility: "private" },
      ],
      featureEnabled: true,
      entitled: true,
      queries,
    });
    expect(view.repositories[0]).toMatchObject({
      source: "repository_secret",
      bindingVersion: 0,
      activation: "legacy",
    });
  });

  it("never silently falls back when a hosted binding exists but its pool is unavailable", async () => {
    const queries: HostedPoolQueryPort = {
      getDefaultPoolSummary: vi.fn(async () => null),
      listAccountSummaries: vi.fn(async () => []),
      getRepositoryBindingSummary: vi.fn(async () => ({
        id: "binding-1" as never,
        bindingId: "binding-1" as never,
        repositoryId: "repo-1" as never,
        poolId: "pool-1" as never,
        revision: 3,
        stateVersion: 5,
        status: "active" as const,
        activatedAt: new Date(),
        updatedAt: new Date(),
      })),
    };
    const view = await loadHostedPoolDashboardView({
      workspaceId: "workspace-1",
      repositories: [
        { id: "repo-1", fullName: "acme/private", visibility: "private" },
      ],
      featureEnabled: true,
      entitled: true,
      queries,
    });
    expect(view.repositories[0]).toMatchObject({
      source: "hosted_workspace_pool",
      bindingVersion: 3,
      activation: "pending",
    });
  });

  it("shows repository-owned source after an active binding enters draining", async () => {
    const queries: HostedPoolQueryPort = {
      getDefaultPoolSummary: vi.fn(async () => ({
        id: "pool-1" as never,
        workspaceId: "workspace-1" as never,
        revision: 2,
        status: "active" as const,
        isDefault: true as const,
        accountCount: 1,
        healthyAccountCount: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      listAccountSummaries: vi.fn(async () => []),
      getRepositoryBindingSummary: vi.fn(async () => ({
        id: "binding-1" as never,
        bindingId: "binding-1" as never,
        repositoryId: "repo-1" as never,
        poolId: "pool-1" as never,
        revision: 4,
        stateVersion: 6,
        status: "draining" as const,
        activatedAt: new Date(),
        updatedAt: new Date(),
      })),
    };
    const view = await loadHostedPoolDashboardView({
      workspaceId: "workspace-1",
      repositories: [
        { id: "repo-1", fullName: "acme/private", visibility: "private" },
      ],
      featureEnabled: true,
      entitled: true,
      queries,
    });
    expect(view.repositories[0]).toMatchObject({
      source: "repository_secret",
      bindingId: "binding-1",
      bindingVersion: 4,
      activation: "legacy",
    });
  });
});
