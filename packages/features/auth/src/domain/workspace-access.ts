export type WorkspaceAccessRole = "owner" | "admin" | "member";

export type WorkspaceAccessDecision = {
  readonly allowed: boolean;
  readonly reason:
    | "allowed"
    | "local_admin_override"
    | "missing_role"
    | "insufficient_role";
};

export function canMutateWorkspace(input: {
  readonly role: WorkspaceAccessRole | null;
  readonly githubLogin: string;
  readonly localAdminGithubLogins?: readonly string[];
}): WorkspaceAccessDecision {
  return canAdminWorkspace(input);
}

export function canAdminWorkspace(input: {
  readonly role: WorkspaceAccessRole | null;
  readonly githubLogin: string;
  readonly localAdminGithubLogins?: readonly string[];
}): WorkspaceAccessDecision {
  if (
    input.localAdminGithubLogins?.some(
      (login) => login.toLowerCase() === input.githubLogin.toLowerCase(),
    )
  ) {
    return { allowed: true, reason: "local_admin_override" };
  }

  if (!input.role) {
    return { allowed: false, reason: "missing_role" };
  }

  if (input.role === "owner" || input.role === "admin") {
    return { allowed: true, reason: "allowed" };
  }

  return { allowed: false, reason: "insufficient_role" };
}
