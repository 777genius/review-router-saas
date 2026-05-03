import type { Clock } from "@reviewrouter/shared";
import type { RepositorySyncResult } from "../../domain/repository-connection";
import type { GitHubRepositorySourcePort } from "../ports/github-repository-source-port";
import type { RepositoryConnectionRepositoryPort } from "../ports/repository-connection-repository-port";

export type SyncInstallationRepositoriesDependencies = {
  readonly github: GitHubRepositorySourcePort;
  readonly repositories: RepositoryConnectionRepositoryPort;
  readonly clock: Clock;
};

export async function syncInstallationRepositories(
  githubInstallationId: string,
  dependencies: SyncInstallationRepositoriesDependencies,
): Promise<RepositorySyncResult> {
  const repositories =
    await dependencies.github.listInstallationRepositories(
      githubInstallationId,
    );

  return dependencies.repositories.syncInstallationRepositories({
    githubInstallationId,
    repositories,
    syncedAt: dependencies.clock.now(),
  });
}
