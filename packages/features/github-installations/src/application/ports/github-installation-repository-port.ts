import type { GitHubInstallationSnapshot } from "../../domain/github-installation.js";

export interface GitHubInstallationRepositoryPort {
  upsertInstallation(snapshot: GitHubInstallationSnapshot): Promise<void>;
  markInstallationRemoved(githubInstallationId: string): Promise<void>;
}
