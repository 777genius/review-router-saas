import type {
  GitLabRepositoryContext,
  GitLabRepositoryPort,
} from "@reviewrouter/features-gitlab-integration";

export class FallbackGitLabRepositoryRegistry implements GitLabRepositoryPort {
  constructor(private readonly registries: readonly GitLabRepositoryPort[]) {
    if (registries.length === 0) {
      throw new Error("gitlab_repository_registry_fallback_empty");
    }
  }

  async findSelectedRepositoryByGitLabProjectId(
    gitlabProjectId: string,
  ): Promise<GitLabRepositoryContext | null> {
    for (const registry of this.registries) {
      const repository =
        await registry.findSelectedRepositoryByGitLabProjectId(gitlabProjectId);
      if (repository) return repository;
    }
    return null;
  }
}
