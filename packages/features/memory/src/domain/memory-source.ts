export type MemorySourceType =
  | "review_comment"
  | "pr_comment"
  | "dashboard"
  | "api"
  | "system_migration";

export type MemorySource = {
  readonly type: MemorySourceType;
  readonly sourceId: string;
  readonly githubCommentId: string | null;
  readonly githubPullRequestNumber: number | null;
  readonly githubRepositoryId: string | null;
  readonly url: string | null;
  readonly actorLogin: string | null;
  readonly redactedExcerpt: string | null;
  readonly sourceHash: string | null;
  readonly sourceVisibility: "private" | "internal" | "public";
};

export function createDashboardMemorySource(input: {
  readonly actorLogin?: string | null;
  readonly sourceId?: string;
}): MemorySource {
  return {
    type: "dashboard",
    sourceId: input.sourceId ?? "dashboard",
    githubCommentId: null,
    githubPullRequestNumber: null,
    githubRepositoryId: null,
    url: null,
    actorLogin: input.actorLogin ?? null,
    redactedExcerpt: null,
    sourceHash: null,
    sourceVisibility: "internal",
  };
}
