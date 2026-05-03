import type { WorkspaceAccessRepositoryPort } from "../ports/workspace-access-repository-port";

export type VisibleWorkspaceScope =
  | {
      readonly kind: "all";
      readonly reason: "local_admin_override";
    }
  | {
      readonly kind: "workspace_ids";
      readonly workspaceIds: readonly string[];
    };

export async function listVisibleWorkspaceScope(
  input: {
    readonly githubUserId: string;
    readonly githubLogin: string;
    readonly localAdminGithubLogins?: readonly string[];
  },
  dependencies: {
    readonly workspaceAccess: WorkspaceAccessRepositoryPort;
  },
): Promise<VisibleWorkspaceScope> {
  if (
    input.localAdminGithubLogins?.some(
      (login) => login.toLowerCase() === input.githubLogin.toLowerCase(),
    )
  ) {
    return { kind: "all", reason: "local_admin_override" };
  }

  const grants =
    await dependencies.workspaceAccess.listWorkspaceRolesByGitHubUserId({
      githubUserId: input.githubUserId,
    });

  return {
    kind: "workspace_ids",
    workspaceIds: grants.map((grant) => grant.workspaceId),
  };
}
