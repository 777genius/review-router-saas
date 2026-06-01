import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../domain/authenticated-principal";
import type { ExternalIdentity } from "../domain/external-identity";
import type { GitHubExternalIdentity } from "../domain/github-external-identity";
import type { UserRepositoryPort } from "../application/ports/user-repository-port";
import type {
  WorkspaceMembership,
  WorkspaceMembershipRepositoryPort,
} from "../application/ports/workspace-membership-repository-port";
import { linkGitHubIdentity } from "../application/use-cases/link-github-identity";
import { linkExternalIdentity } from "../application/use-cases/link-external-identity";

class InMemoryUserRepository implements UserRepositoryPort {
  private readonly users = new Map<string, AuthenticatedPrincipal>();

  async upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    return this.upsertExternalIdentity({
      provider: "github",
      externalUserId: identity.githubUserId,
      login: identity.githubLogin,
      primaryEmail: identity.primaryEmail ?? null,
      avatarUrl: identity.avatarUrl ?? null,
    });
  }

  async upsertExternalIdentity(
    identity: ExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    const identityKey = `${identity.provider}:${identity.externalUserId}`;
    const existing = this.users.get(identityKey);
    const principal = {
      provider: identity.provider,
      userId:
        existing?.userId ??
        `user-${identity.provider}-${identity.externalUserId}`,
      externalUserId: identity.externalUserId,
      login: identity.login,
      githubUserId:
        identity.provider === "github" ? identity.externalUserId : null,
      githubLogin: identity.provider === "github" ? identity.login : null,
      primaryEmail: identity.primaryEmail ?? null,
      avatarUrl: identity.avatarUrl ?? null,
    } satisfies AuthenticatedPrincipal;
    this.users.set(identityKey, principal);
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
      workspaceId: `workspace-${principal.userId}`,
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

  it("links GitLab identity without requiring GitHub fields or installation owners", async () => {
    const users = new InMemoryUserRepository();
    const memberships = new InMemoryMembershipRepository();

    const principal = await linkExternalIdentity(
      {
        provider: "gitlab",
        externalUserId: "123",
        login: "gitlab-user",
        primaryEmail: null,
        avatarUrl: null,
      },
      { users, memberships },
    );

    expect(principal).toMatchObject({
      provider: "gitlab",
      externalUserId: "123",
      login: "gitlab-user",
      githubUserId: null,
      githubLogin: null,
    });
    expect(memberships.personalWorkspaceOwnerCalls).toBe(1);
    expect(memberships.installationWorkspaceOwnerCalls).toBe(0);
  });
});
