import {
  codexRotatingSetupNotReadyError,
  inspectCodexRotatingSetupReadiness,
  type CodexRotatingSetupReadinessPort,
} from "@reviewrouter/features-provider-setup";
import type { DashboardProviderSetupReadinessRecord } from "./dashboard-provider-setup-readiness";

type GitHubRepositoryIdentity = Readonly<{
  id: string;
  githubRepositoryId: bigint | string | null;
}>;

/**
 * Cached setup rows are presentation hints only for rotating OAuth. A row is
 * shown as configured only when the exact durable versioned activation chain
 * still proves it under the provider lock.
 */
export async function deriveDashboardProviderSetupReadiness(input: {
  readonly providerSetup: readonly DashboardProviderSetupReadinessRecord[];
  readonly repositories: readonly GitHubRepositoryIdentity[];
  readonly workspaceId: string;
  readonly readiness: CodexRotatingSetupReadinessPort;
}): Promise<readonly DashboardProviderSetupReadinessRecord[]> {
  const repositoryById = new Map(
    input.repositories.map(
      (repository) => [repository.id, repository] as const,
    ),
  );

  return Promise.all(
    input.providerSetup.map(async (setup) => {
      if (
        setup.state !== "configured" ||
        setup.providerKind !== "codex" ||
        setup.authMode !== "codex_subscription_oauth_rotating" ||
        !setup.repositoryId
      ) {
        return setup;
      }
      const repository = repositoryById.get(setup.repositoryId);
      if (!repository?.githubRepositoryId) {
        return { ...setup, state: "stale_or_invalid" };
      }
      const githubRepositoryId = repository.githubRepositoryId.toString();
      try {
        await inspectCodexRotatingSetupReadiness(
          {
            workspaceId: input.workspaceId,
            repositoryId: repository.id,
            githubRepositoryId,
            providerInstanceId: `codex-rotating:${githubRepositoryId}`,
          },
          { readiness: input.readiness },
        );
        return setup;
      } catch (error) {
        return {
          ...setup,
          state:
            error instanceof Error &&
            error.message === codexRotatingSetupNotReadyError
              ? "stale_or_invalid"
              : "unknown",
        };
      }
    }),
  );
}
