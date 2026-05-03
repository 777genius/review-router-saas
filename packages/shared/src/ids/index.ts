export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type InstallationId = Brand<string, "InstallationId">;

export function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}
