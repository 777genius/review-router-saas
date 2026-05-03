import type { GitHubInstallationSnapshot } from "../../domain/github-installation";

export interface GitHubInstallationRepositoryPort {
  upsertInstallation(snapshot: GitHubInstallationSnapshot): Promise<void>;
  markInstallationRemoved(githubInstallationId: string): Promise<void>;
}
