import type { GitHubRepositorySnapshot } from "../../domain/repository-connection";

export interface RepositoryIdentitySynchronizationPort {
  synchronizeRepositoryIdentities(input: {
    readonly githubInstallationId: string;
    readonly repositories: readonly GitHubRepositorySnapshot[];
    readonly syncedAt: Date;
  }): Promise<void>;
}
