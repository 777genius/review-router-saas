import { describe, expect, it } from "vitest";
import type { WorkspaceAccessRepositoryPort } from "../application/ports/workspace-access-repository-port";
import { assertWorkspaceMutationAllowed } from "../application/use-cases/assert-workspace-mutation-allowed";
import type { WorkspaceAccessRole } from "../domain/workspace-access";
import { canMutateWorkspace } from "../domain/workspace-access";

class StaticWorkspaceAccess implements WorkspaceAccessRepositoryPort {
  constructor(private readonly role: WorkspaceAccessRole | null) {}

  async findWorkspaceRoleByGitHubUserId(): Promise<WorkspaceAccessRole | null> {
    return this.role;
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
});
