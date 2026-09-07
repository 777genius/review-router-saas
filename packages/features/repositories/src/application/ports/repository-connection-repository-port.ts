import type {
  GitHubRepositorySnapshot,
  RepositoryConnectionSummary,
  RepositorySyncResult,
} from "../../domain/repository-connection";

export interface RepositoryConnectionRepositoryPort {
  beginInstallationInventory(): Promise<bigint>;

  syncInstallationRepositories(input: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
    inventoryGeneration: bigint;
  }): Promise<RepositorySyncResult>;

  listWorkspaceRepositories(
    workspaceId: string,
  ): Promise<readonly RepositoryConnectionSummary[]>;
}
