import type { WorkspaceAccessRole } from "../../domain/workspace-access";

export type WorkspaceAccessGrant = {
  readonly workspaceId: string;
  readonly role: WorkspaceAccessRole;
};

export interface WorkspaceAccessRepositoryPort {
  findWorkspaceRoleByUserId(input: {
    readonly workspaceId: string;
    readonly userId: string;
  }): Promise<WorkspaceAccessRole | null>;

  findWorkspaceRoleByGitHubUserId(input: {
    readonly workspaceId: string;
    readonly githubUserId: string;
  }): Promise<WorkspaceAccessRole | null>;

  listWorkspaceRolesByUserId(input: {
    readonly userId: string;
  }): Promise<readonly WorkspaceAccessGrant[]>;

  listWorkspaceRolesByGitHubUserId(input: {
    readonly githubUserId: string;
  }): Promise<readonly WorkspaceAccessGrant[]>;
}
