export type RepositoryPermissionProof = {
  readonly permission?: string | null;
  readonly roleName?: string | null;
};

export type DashboardRepositoryCapability = "repo_manager" | "direct_config";

export function repositoryPermissionAllowsCapability(
  proof: RepositoryPermissionProof,
  capability: DashboardRepositoryCapability,
): boolean {
  switch (capability) {
    case "repo_manager":
      return repositoryPermissionAllowsRepoManagement(proof);
    case "direct_config":
      return repositoryPermissionAllowsDirectConfig(proof);
  }
}

export function repositoryPermissionAllowsRepoManagement(
  proof: RepositoryPermissionProof,
): boolean {
  const permission = normalizePermission(proof.permission);
  const roleName = normalizePermission(proof.roleName);

  return (
    permission === "admin" ||
    permission === "maintain" ||
    permission === "write" ||
    roleName === "admin" ||
    roleName === "maintain" ||
    roleName === "write"
  );
}

export function repositoryPermissionAllowsDirectConfig(
  proof: RepositoryPermissionProof,
): boolean {
  const permission = normalizePermission(proof.permission);
  const roleName = normalizePermission(proof.roleName);

  return (
    permission === "admin" ||
    permission === "maintain" ||
    roleName === "admin" ||
    roleName === "maintain"
  );
}

function normalizePermission(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
