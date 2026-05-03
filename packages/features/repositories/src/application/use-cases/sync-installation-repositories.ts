import type { Clock } from "@reviewrouter/shared";
import type { RepositorySyncResult } from "../../domain/repository-connection";
import {
  applyRepositorySyncPolicy,
  type RepositorySyncPolicy,
} from "../../domain/repository-sync-policy";
import type { GitHubRepositorySourcePort } from "../ports/github-repository-source-port";
import type { RepositoryConnectionRepositoryPort } from "../ports/repository-connection-repository-port";

export type SyncInstallationRepositoriesDependencies = {
  readonly github: GitHubRepositorySourcePort;
  readonly repositories: RepositoryConnectionRepositoryPort;
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
  const result = await dependencies.repositories.syncInstallationRepositories({
    githubInstallationId,
    repositories: policyResult.repositories,
    syncedAt: dependencies.clock.now(),
  });

  return {
    ...result,
    seen: repositories.length,
    skippedDueToLimit: policyResult.skippedDueToLimit,
  };
}
