import type {
  GitHubRepositorySnapshot,
  RepositoryConnectionSummary,
  RepositorySyncResult,
} from "../../domain/repository-connection";

export interface RepositoryConnectionRepositoryPort {
  syncInstallationRepositories(input: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
  }): Promise<RepositorySyncResult>;

  listWorkspaceRepositories(
    workspaceId: string,
  ): Promise<readonly RepositoryConnectionSummary[]>;
}
