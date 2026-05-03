import type { GitHubRepositorySnapshot } from "./repository-connection";

export type RepositorySyncPolicy = {
  readonly maxRepositories: number;
};

export type RepositorySyncPolicyResult = {
  readonly repositories: readonly GitHubRepositorySnapshot[];
  readonly skippedDueToLimit: number;
};

export function applyRepositorySyncPolicy(
  repositories: readonly GitHubRepositorySnapshot[],
  policy?: RepositorySyncPolicy,
): RepositorySyncPolicyResult {
  if (!policy) {
    return { repositories, skippedDueToLimit: 0 };
  }

  const maxRepositories = Math.max(0, Math.floor(policy.maxRepositories));
  if (repositories.length <= maxRepositories) {
    return { repositories, skippedDueToLimit: 0 };
  }

  const selectedRepositories = [...repositories]
    .sort((left, right) => left.fullName.localeCompare(right.fullName))
    .slice(0, maxRepositories);

  return {
    repositories: selectedRepositories,
    skippedDueToLimit: repositories.length - selectedRepositories.length,
  };
}
