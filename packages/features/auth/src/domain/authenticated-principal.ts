export type AuthenticatedPrincipal = {
  readonly userId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly primaryEmail?: string | null;
  readonly avatarUrl?: string | null;
  readonly sessionId?: string | null;
};

export type WorkspaceActor = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: "owner" | "admin" | "member";
};
