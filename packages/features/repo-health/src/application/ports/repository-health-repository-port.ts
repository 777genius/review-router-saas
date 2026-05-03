import type { RepositoryHealthInput } from "../../domain/repository-health";

export interface RepositoryHealthRepositoryPort {
  listWorkspaceHealthInputs(
    workspaceId: string,
  ): Promise<readonly RepositoryHealthInput[]>;
}
