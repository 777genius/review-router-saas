import { describe, expect, it } from "vitest";
import type { WorkspaceAccessRepositoryPort } from "../application/ports/workspace-access-repository-port";
import { assertWorkspaceAdminAllowed } from "../application/use-cases/assert-workspace-admin-allowed";
import { assertWorkspaceMutationAllowed } from "../application/use-cases/assert-workspace-mutation-allowed";
import { listVisibleWorkspaceScope } from "../application/use-cases/list-visible-workspace-scope";
import type { WorkspaceAccessRole } from "../domain/workspace-access";
import {
  canAdminWorkspace,
  canMutateWorkspace,
} from "../domain/workspace-access";

class StaticWorkspaceAccess implements WorkspaceAccessRepositoryPort {
  constructor(
    private readonly role: WorkspaceAccessRole | null,
    private readonly workspaceIds: readonly string[] = [],
  ) {}

  async findWorkspaceRoleByGitHubUserId(): Promise<WorkspaceAccessRole | null> {
    return this.role;
  }

  async listWorkspaceRolesByGitHubUserId() {
    return this.workspaceIds.map((workspaceId) => ({
      workspaceId,
      role: "member" as const,
    }));
  }
}

describe("workspace access policy", () => {
  it("allows owners, admins, and explicit local admin overrides", async () => {
    await expect(
      assertWorkspaceMutationAllowed(
        {
          workspaceId: "workspace_1",
          githubUserId: "123",
          githubLogin: "maintainer",
        },
        { workspaceAccess: new StaticWorkspaceAccess("owner") },
      ),
    ).resolves.toMatchObject({ allowed: true });

    expect(
      canMutateWorkspace({
        role: null,
        githubLogin: "777genius",
        localAdminGithubLogins: ["777genius"],
      }),
    ).toEqual({ allowed: true, reason: "local_admin_override" });

    expect(
      canAdminWorkspace({
        role: "admin",
        githubLogin: "maintainer",
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
  });

  it("checks workspace admin access independently from mutation workflows", async () => {
    await expect(
      assertWorkspaceAdminAllowed(
        {
          workspaceId: "workspace_1",
          githubUserId: "123",
          githubLogin: "maintainer",
        },
        { workspaceAccess: new StaticWorkspaceAccess("admin") },
      ),
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      assertWorkspaceAdminAllowed(
        {
          workspaceId: "workspace_1",
          githubUserId: "456",
          githubLogin: "member",
        },
        { workspaceAccess: new StaticWorkspaceAccess("member") },
      ),
    ).rejects.toThrow("workspace_admin_forbidden:insufficient_role");
  });

  it("blocks members and users without workspace membership", async () => {
    await expect(
      assertWorkspaceMutationAllowed(
        {
          workspaceId: "workspace_1",
          githubUserId: "123",
          githubLogin: "member",
        },
        { workspaceAccess: new StaticWorkspaceAccess("member") },
      ),
    ).rejects.toThrow("workspace_mutation_forbidden:insufficient_role");

    await expect(
      assertWorkspaceMutationAllowed(
        {
          workspaceId: "workspace_1",
          githubUserId: "456",
          githubLogin: "outsider",
        },
        { workspaceAccess: new StaticWorkspaceAccess(null) },
      ),
    ).rejects.toThrow("workspace_mutation_forbidden:missing_role");
  });

  it("lists only member workspace ids unless local admin override applies", async () => {
    await expect(
      listVisibleWorkspaceScope(
        {
          githubUserId: "123",
          githubLogin: "member",
        },
        {
          workspaceAccess: new StaticWorkspaceAccess(null, [
            "workspace_1",
            "workspace_2",
          ]),
        },
      ),
    ).resolves.toEqual({
      kind: "workspace_ids",
      workspaceIds: ["workspace_1", "workspace_2"],
    });

    await expect(
      listVisibleWorkspaceScope(
        {
          githubUserId: "123",
          githubLogin: "777genius",
          localAdminGithubLogins: ["777genius"],
        },
        { workspaceAccess: new StaticWorkspaceAccess(null) },
      ),
    ).resolves.toEqual({
      kind: "all",
      reason: "local_admin_override",
    });
  });
});
