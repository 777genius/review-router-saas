import type { WorkspaceAccessRole } from "../../domain/workspace-access";

export interface WorkspaceAccessRepositoryPort {
  findWorkspaceRoleByGitHubUserId(input: {
    readonly workspaceId: string;
    readonly githubUserId: string;
  }): Promise<WorkspaceAccessRole | null>;
}
