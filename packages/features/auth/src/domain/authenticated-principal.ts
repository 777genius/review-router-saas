export type AuthenticatedPrincipal = {
  readonly userId: string;
  readonly provider: "github" | "gitlab";
  readonly externalUserId: string;
  readonly login: string;
  readonly githubUserId?: string | null;
  readonly githubLogin?: string | null;
  readonly primaryEmail?: string | null;
  readonly avatarUrl?: string | null;
  readonly sessionId?: string | null;
};

export type WorkspaceActor = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: "owner" | "admin" | "member";
};
