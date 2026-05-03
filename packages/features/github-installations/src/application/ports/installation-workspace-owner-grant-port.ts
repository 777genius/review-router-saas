export type InstallationWorkspaceOwnerGrant = {
  readonly githubInstallationId: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly avatarUrl?: string | null;
};

export interface InstallationWorkspaceOwnerGrantPort {
  grantInstallationActorOwner(
    grant: InstallationWorkspaceOwnerGrant,
  ): Promise<void>;
}
