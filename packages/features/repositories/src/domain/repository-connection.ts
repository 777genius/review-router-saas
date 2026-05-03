export type RepositoryVisibility = "public" | "private" | "internal";

export type GitHubRepositorySnapshot = {
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: RepositoryVisibility;
  readonly archived: boolean;
};

export type RepositoryConnectionSummary = GitHubRepositorySnapshot & {
  readonly id: string;
  readonly workspaceId: string;
  readonly selected: boolean;
  readonly setupStatus:
    | "not_configured"
    | "setup_pr_open"
    | "configured"
    | "needs_attention";
  readonly lastSyncedAt: Date | null;
};

export type RepositorySyncResult = {
  readonly installationId: string;
  readonly seen: number;
  readonly upserted: number;
  readonly unselected: number;
  readonly skippedDueToLimit: number;
};
