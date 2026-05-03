import type { WorkspaceAccessRole } from "../../domain/workspace-access";

export type WorkspaceAccessGrant = {
  readonly workspaceId: string;
  readonly role: WorkspaceAccessRole;
};

export interface WorkspaceAccessRepositoryPort {
  findWorkspaceRoleByGitHubUserId(input: {
    readonly workspaceId: string;
    readonly githubUserId: string;
  }): Promise<WorkspaceAccessRole | null>;

  listWorkspaceRolesByGitHubUserId(input: {
    readonly githubUserId: string;
  }): Promise<readonly WorkspaceAccessGrant[]>;
}
