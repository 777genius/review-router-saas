import type { GitLabRepositoryPort } from "../../application/ports/gitlab-repository-port";
import type { GitLabRepositoryContext } from "../../domain/gitlab-ci-identity";

export class StaticGitLabRepositoryRegistry implements GitLabRepositoryPort {
  private readonly repositoriesByProjectId: ReadonlyMap<
    string,
    GitLabRepositoryContext
  >;

  constructor(repositories: readonly GitLabRepositoryContext[]) {
    this.repositoriesByProjectId = new Map(
      repositories.map((repository) => [
        repository.gitlabProjectId,
        repository,
      ]),
    );
  }

  async findSelectedRepositoryByGitLabProjectId(
    gitlabProjectId: string,
  ): Promise<GitLabRepositoryContext | null> {
    return this.repositoriesByProjectId.get(gitlabProjectId) ?? null;
  }
}
