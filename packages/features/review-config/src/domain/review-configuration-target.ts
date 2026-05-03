export type ReviewConfigurationTarget =
  | {
      readonly scope: "workspace";
      readonly workspaceId: string;
      readonly repositoryId?: null;
    }
  | {
      readonly scope: "repository";
      readonly workspaceId: string;
      readonly repositoryId: string;
    };

export function reviewConfigurationTargetKey(
  target: ReviewConfigurationTarget,
): string {
  if (target.scope === "workspace") {
    return "workspace:default";
  }

  return `repo:${target.repositoryId}`;
}
