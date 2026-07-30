import type { Clock } from "@reviewrouter/shared";
import type { RepositorySyncResult } from "../../domain/repository-connection";
import {
  applyRepositorySyncPolicy,
  type RepositorySyncPolicy,
} from "../../domain/repository-sync-policy";
import type { GitHubRepositorySourcePort } from "../ports/github-repository-source-port";
import type { RepositoryConnectionRepositoryPort } from "../ports/repository-connection-repository-port";
import type { RepositoryIdentitySynchronizationPort } from "../ports/repository-identity-synchronization-port";

export type SyncInstallationRepositoriesDependencies = {
  readonly github: GitHubRepositorySourcePort;
  readonly repositories: RepositoryConnectionRepositoryPort;
  readonly repositoryIdentities?: RepositoryIdentitySynchronizationPort;
  readonly clock: Clock;
  readonly syncPolicy?: RepositorySyncPolicy;
};

export async function syncInstallationRepositories(
  githubInstallationId: string,
  dependencies: SyncInstallationRepositoriesDependencies,
): Promise<RepositorySyncResult> {
  const repositories =
    await dependencies.github.listInstallationRepositories(
      githubInstallationId,
    );

  const policyResult = applyRepositorySyncPolicy(
    repositories,
    dependencies.syncPolicy,
  );
  const syncedAt = dependencies.clock.now();
  const result = await dependencies.repositories.syncInstallationRepositories({
    githubInstallationId,
    repositories: policyResult.repositories,
    syncedAt,
  });
  if (dependencies.repositoryIdentities) {
    await dependencies.repositoryIdentities.synchronizeRepositoryIdentities({
      githubInstallationId,
      repositories: policyResult.repositories,
      syncedAt,
    });
  }

  return {
    ...result,
    seen: repositories.length,
    skippedDueToLimit: policyResult.skippedDueToLimit,
  };
}
