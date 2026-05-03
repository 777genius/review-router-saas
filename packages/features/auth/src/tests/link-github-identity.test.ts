import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../domain/authenticated-principal";
import type { GitHubExternalIdentity } from "../domain/github-external-identity";
import type { UserRepositoryPort } from "../application/ports/user-repository-port";
import type {
  WorkspaceMembership,
  WorkspaceMembershipRepositoryPort,
} from "../application/ports/workspace-membership-repository-port";
import { linkGitHubIdentity } from "../application/use-cases/link-github-identity";

class InMemoryUserRepository implements UserRepositoryPort {
  private readonly users = new Map<string, AuthenticatedPrincipal>();

  async upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    const existing = this.users.get(identity.githubUserId);
    const principal = {
      userId: existing?.userId ?? `user-${identity.githubUserId}`,
      githubUserId: identity.githubUserId,
      githubLogin: identity.githubLogin,
      primaryEmail: identity.primaryEmail ?? null,
      avatarUrl: identity.avatarUrl ?? null,
    } satisfies AuthenticatedPrincipal;
    this.users.set(identity.githubUserId, principal);
    return principal;
  }
}

class InMemoryMembershipRepository implements WorkspaceMembershipRepositoryPort {
  public personalWorkspaceOwnerCalls = 0;
  public installationWorkspaceOwnerCalls = 0;

  async ensurePersonalWorkspaceOwner(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMembership> {
    this.personalWorkspaceOwnerCalls += 1;
    return {
      workspaceId: `workspace-${principal.githubUserId}`,
      role: "owner",
      source: "personal",
    };
  }

  async ensureGitHubUserInstallationWorkspaceOwners(
    principal: AuthenticatedPrincipal,
  ): Promise<readonly WorkspaceMembership[]> {
    this.installationWorkspaceOwnerCalls += 1;
    return [
      {
        workspaceId: `gh-user-installation-${principal.githubLogin}`,
        role: "owner",
        source: "github_user_installation",
      },
    ];
  }
}

describe("linkGitHubIdentity", () => {
  it("uses immutable GitHub id and refreshes login snapshot", async () => {
    const users = new InMemoryUserRepository();
    const memberships = new InMemoryMembershipRepository();

    const first = await linkGitHubIdentity(
      { githubUserId: "123", githubLogin: "old-login", primaryEmail: null },
      { users, memberships },
    );
    const renamed = await linkGitHubIdentity(
      { githubUserId: "123", githubLogin: "new-login", primaryEmail: null },
      { users, memberships },
    );

    expect(renamed.userId).toBe(first.userId);
    expect(renamed.githubLogin).toBe("new-login");
    expect(memberships.personalWorkspaceOwnerCalls).toBe(2);
    expect(memberships.installationWorkspaceOwnerCalls).toBe(2);
  });
});
