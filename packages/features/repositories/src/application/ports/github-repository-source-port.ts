import type { GitHubRepositorySnapshot } from "../../domain/repository-connection";

export interface GitHubRepositorySourcePort {
  listInstallationRepositories(
    githubInstallationId: string,
  ): Promise<readonly GitHubRepositorySnapshot[]>;
}
