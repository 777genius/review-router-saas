import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import type { GitLabGroupProject } from "../../domain/gitlab-installation";
import { parseGitLabSourceUrl } from "../../domain/gitlab-source-url";
import { discoverGitLabGroupProjects } from "./discover-gitlab-group-projects";

export type DiscoverGitLabSourceProjectsResult = {
  readonly protocolVersion: 1;
  readonly source: {
    readonly inputPath: string;
    readonly resolvedKind: "group" | "project";
    readonly baseUrl: string;
  };
  readonly projects: readonly GitLabGroupProject[];
  readonly projectIds: readonly string[];
  readonly parentGroupPath: string | null;
};

export async function discoverGitLabSourceProjects(
  input: {
    readonly sourceUrl: string;
    readonly workspaceId: string;
    readonly defaultBaseUrl?: string | undefined;
  },
  dependencies: {
    readonly installation: GitLabInstallationPort;
  },
): Promise<DiscoverGitLabSourceProjectsResult> {
  const source = parseGitLabSourceUrl({
    value: input.sourceUrl,
    defaultBaseUrl: input.defaultBaseUrl,
  });

  const project = await tryGetProject(source.path, dependencies.installation);
  if (project) {
    return {
      protocolVersion: 1,
      source: {
        inputPath: source.path,
        resolvedKind: "project",
        baseUrl: source.baseUrl,
      },
      projects: [
        {
          projectId: project.projectId,
          fullName: project.fullName,
          name: project.name,
          defaultBranch: project.defaultBranch,
          webUrl: `${source.baseUrl}/${project.fullName}`,
          visibility: project.visibility ?? "private",
          archived: false,
        },
      ],
      projectIds: [project.projectId],
      parentGroupPath: parentPath(project.fullName),
    };
  }

  const group = await discoverGitLabGroupProjects(
    {
      groupIdOrPath: source.path,
      includeSubgroups: true,
      archived: false,
      withShared: false,
      workspaceId: input.workspaceId,
    },
    dependencies,
  );

  return {
    protocolVersion: 1,
    source: {
      inputPath: source.path,
      resolvedKind: "group",
      baseUrl: source.baseUrl,
    },
    projects: group.projects,
    projectIds: group.projectIds,
    parentGroupPath: source.path,
  };
}

async function tryGetProject(
  path: string,
  installation: GitLabInstallationPort,
): Promise<{
  readonly projectId: string;
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly visibility?: "public" | "internal" | "private" | undefined;
} | null> {
  try {
    const project = await installation.getProjectSettingsByPathOrId({
      projectPathOrId: path,
    });
    return {
      projectId: project.projectId,
      fullName: project.fullName,
      name: project.fullName.split("/").at(-1) ?? project.fullName,
      defaultBranch: project.defaultBranch,
      visibility: project.visibility ?? "private",
    };
  } catch (error) {
    if (isGitLabNotFound(error)) return null;
    throw error;
  }
}

function isGitLabNotFound(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("gitlab_api_error_404")
  );
}

function parentPath(fullName: string): string | null {
  const index = fullName.lastIndexOf("/");
  return index > 0 ? fullName.slice(0, index) : null;
}
