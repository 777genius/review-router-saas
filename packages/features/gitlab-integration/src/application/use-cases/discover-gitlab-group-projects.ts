import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import type { GitLabGroupProject } from "../../domain/gitlab-installation";

const defaultProjectPage = 1;
const defaultProjectsPerPage = 100;
const maxProjectsPerPage = 100;

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

function normalizePositiveInteger(value: number, errorCode: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(errorCode);
  }
  return value;
}
