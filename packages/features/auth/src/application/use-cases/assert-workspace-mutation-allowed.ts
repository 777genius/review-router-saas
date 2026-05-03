import { canMutateWorkspace } from "../../domain/workspace-access";
import type { WorkspaceAccessRepositoryPort } from "../ports/workspace-access-repository-port";

export type AssertWorkspaceMutationAllowedInput = {
  readonly workspaceId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly localAdminGithubLogins?: readonly string[];
};

export async function assertWorkspaceMutationAllowed(
  input: AssertWorkspaceMutationAllowedInput,
  dependencies: {
    readonly workspaceAccess: WorkspaceAccessRepositoryPort;
  },
): Promise<{ readonly allowed: true; readonly reason: string }> {
  const role =
    await dependencies.workspaceAccess.findWorkspaceRoleByGitHubUserId({
      workspaceId: input.workspaceId,
      githubUserId: input.githubUserId,
    });
  const decision = canMutateWorkspace({ ...input, role });

  if (!decision.allowed) {
    throw new Error(`workspace_mutation_forbidden:${decision.reason}`);
  }

  return { allowed: true, reason: decision.reason };
}
