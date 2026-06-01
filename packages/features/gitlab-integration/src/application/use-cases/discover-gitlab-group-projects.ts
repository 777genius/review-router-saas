import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import type { GitLabRepositoryContext } from "../../domain/gitlab-ci-identity";
import type { GitLabGroupProject } from "../../domain/gitlab-installation";

const defaultProjectPage = 1;
const defaultProjectsPerPage = 100;
const maxProjectsPerPage = 100;
const staticRepositoriesEnvKey =
  "REVIEW_ROUTER_GITLAB_STATIC_REPOSITORIES_JSON";

export type DiscoverGitLabGroupProjectsResult = {
  readonly protocolVersion: 1;
  readonly groupIdOrPath: string;
  readonly page: number;
  readonly perPage: number;
  readonly nextPage: number | null;
  readonly total: number | null;
  readonly totalPages: number | null;
  readonly projectIds: readonly string[];
  readonly projects: readonly GitLabGroupProject[];
  readonly staticRepositoriesEnvKey: typeof staticRepositoriesEnvKey;
  readonly staticRepositoriesJson: string;
  readonly staticRepositories: readonly GitLabRepositoryContext[];
};

export async function discoverGitLabGroupProjects(
  input: {
    readonly groupIdOrPath: string;
    readonly includeSubgroups?: boolean | undefined;
    readonly archived?: boolean | undefined;
    readonly withShared?: boolean | undefined;
    readonly page?: number | undefined;
    readonly perPage?: number | undefined;
    readonly search?: string | undefined;
    readonly workspaceId?: string | undefined;
  },
  dependencies: {
    readonly installation: GitLabInstallationPort;
  },
): Promise<DiscoverGitLabGroupProjectsResult> {
  const groupIdOrPath = normalizeGroupIdOrPath(input.groupIdOrPath);
  const page = normalizePositiveInteger(
    input.page ?? defaultProjectPage,
    "gitlab_group_projects_page_invalid",
  );
  const perPage = normalizePositiveInteger(
    input.perPage ?? defaultProjectsPerPage,
    "gitlab_group_projects_per_page_invalid",
  );
  if (perPage > maxProjectsPerPage) {
    throw new Error("gitlab_group_projects_per_page_invalid");
  }
  const workspaceId = normalizeWorkspaceId(
    input.workspaceId ?? defaultWorkspaceId(groupIdOrPath),
  );
  const search = input.search?.trim();
  const projectsPage = await dependencies.installation.listGroupProjects({
    groupIdOrPath,
    includeSubgroups: input.includeSubgroups ?? true,
    archived: input.archived ?? false,
    withShared: input.withShared ?? false,
    page,
    perPage,
    ...(search ? { search } : {}),
  });
  const staticRepositories = buildStaticRepositories({
    projects: projectsPage.projects,
    workspaceId,
  });

  return {
    protocolVersion: 1,
    groupIdOrPath,
    page: projectsPage.page,
    perPage: projectsPage.perPage,
    nextPage: projectsPage.nextPage,
    total: projectsPage.total,
    totalPages: projectsPage.totalPages,
    projectIds: projectsPage.projects.map((project) => project.projectId),
    projects: projectsPage.projects,
    staticRepositoriesEnvKey,
    staticRepositoriesJson: JSON.stringify(staticRepositories),
    staticRepositories,
  };
}

function normalizeGroupIdOrPath(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/")
  ) {
    throw new Error("gitlab_group_id_or_path_invalid");
  }
  return trimmed;
}

function normalizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed.includes("\n") ||
    trimmed.includes("\r")
  ) {
    throw new Error("gitlab_static_repositories_workspace_id_invalid");
  }
  return trimmed;
}

function defaultWorkspaceId(groupIdOrPath: string): string {
  const slug = groupIdOrPath
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `gitlab-${slug || "group"}`;
}

function normalizePositiveInteger(value: number, errorCode: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(errorCode);
  }
  return value;
}

function buildStaticRepositories(input: {
  readonly projects: readonly GitLabGroupProject[];
  readonly workspaceId: string;
}): readonly GitLabRepositoryContext[] {
  return input.projects.map((project) => ({
    workspaceId: input.workspaceId,
    repositoryId: `gitlab-project-${project.projectId}`,
    gitlabProjectId: project.projectId,
    fullName: project.fullName,
    owner: ownerFromFullName(project.fullName),
    selected: true,
    installationStatus: "active",
  }));
}

function ownerFromFullName(fullName: string): string {
  const lastSlash = fullName.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error("gitlab_project_path_invalid");
  }
  return fullName.slice(0, lastSlash);
}
