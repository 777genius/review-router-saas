import { canAdminWorkspace } from "../../domain/workspace-access";
import type { WorkspaceAccessRepositoryPort } from "../ports/workspace-access-repository-port";

export type AssertWorkspaceAdminAllowedInput = {
  readonly workspaceId: string;
  readonly userId?: string | undefined;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly localAdminGithubLogins?: readonly string[];
};

export async function assertWorkspaceAdminAllowed(
  input: AssertWorkspaceAdminAllowedInput,
  dependencies: {
    readonly workspaceAccess: WorkspaceAccessRepositoryPort;
  },
): Promise<{ readonly allowed: true; readonly reason: string }> {
  const role = input.userId
    ? await dependencies.workspaceAccess.findWorkspaceRoleByUserId({
        workspaceId: input.workspaceId,
        userId: input.userId,
      })
    : await dependencies.workspaceAccess.findWorkspaceRoleByGitHubUserId({
        workspaceId: input.workspaceId,
        githubUserId: input.githubUserId,
      });
  const decision = canAdminWorkspace({ ...input, role });

  if (!decision.allowed) {
    throw new Error(`workspace_admin_forbidden:${decision.reason}`);
  }

  return { allowed: true, reason: decision.reason };
}
