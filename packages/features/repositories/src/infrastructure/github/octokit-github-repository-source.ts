import { App } from "@octokit/app";
import type { GitHubRepositorySnapshot } from "../../domain/repository-connection";
import type { GitHubRepositorySourcePort } from "../../application/ports/github-repository-source-port";

export type OctokitGitHubRepositorySourceOptions = {
  readonly appId: number | string;
  readonly privateKey: string;
};

type InstallationRepository = {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly owner: { readonly login: string };
  readonly default_branch: string | null;
  readonly visibility?: string;
  readonly private: boolean;
  readonly archived: boolean;
};

function normalizeVisibility(
  repository: InstallationRepository,
): GitHubRepositorySnapshot["visibility"] {
  if (repository.visibility === "internal") return "internal";
  if (repository.private) return "private";
  return "public";
}

export class OctokitGitHubRepositorySource implements GitHubRepositorySourcePort {
  private readonly app: App;

  constructor(options: OctokitGitHubRepositorySourceOptions) {
    this.app = new App({
      appId: options.appId,
      privateKey: options.privateKey,
    });
  }

  async listInstallationRepositories(
    githubInstallationId: string,
  ): Promise<readonly GitHubRepositorySnapshot[]> {
    const octokit = await this.app.getInstallationOctokit(
      Number(githubInstallationId),
    );
    const repositories: InstallationRepository[] = [];
    for (let page = 1; ; page += 1) {
      const response = await octokit.request("GET /installation/repositories", {
        per_page: 100,
        page,
      });
      repositories.push(
        ...(response.data.repositories as InstallationRepository[]),
      );
      if (response.data.repositories.length < 100) break;
    }

    return repositories.map((repository) => ({
      githubRepositoryId: String(repository.id),
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch ?? "main",
      visibility: normalizeVisibility(repository),
      archived: repository.archived,
    }));
  }
}
