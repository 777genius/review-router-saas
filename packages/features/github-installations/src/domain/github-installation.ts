export type GitHubInstallationLifecycleStatus =
  | "pending"
  | "active"
  | "suspended"
  | "removed"
  | "permission_error"
  | "sync_error";

export type GitHubAccountType = "User" | "Organization" | string;

export type GitHubInstallationSnapshot = {
  readonly githubInstallationId: string;
  readonly accountLogin: string;
  readonly accountType: GitHubAccountType;
  readonly repositorySelection: "all" | "selected" | string;
  readonly status: GitHubInstallationLifecycleStatus;
};

export function installationStatusForAction(
  action: string,
): GitHubInstallationLifecycleStatus | null {
  switch (action) {
    case "created":
    case "unsuspend":
    case "new_permissions_accepted":
      return "active";
    case "suspend":
      return "suspended";
    case "deleted":
      return "removed";
    default:
      return null;
  }
}
