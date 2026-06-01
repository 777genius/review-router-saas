import {
  discoverGitLabSourceProjects,
  GitLabInstallationGateway,
  provisionGitLabReviewRouterProjects,
  type GitLabGroupProject,
} from "@reviewrouter/features-gitlab-integration";
import { getPrisma } from "./prisma";
import { resolveWorkflowPublicApiUrl } from "./workflow-public-api-url";

export type GitLabConnectDiscovery = Awaited<
  ReturnType<typeof discoverGitLabConnectProjects>
>;

export async function discoverGitLabConnectProjects(input: {
  readonly sourceUrl: string;
  readonly token: string;
  readonly workspaceId: string;
}): Promise<{
  readonly source: {
    readonly inputPath: string;
    readonly resolvedKind: "group" | "project";
    readonly baseUrl: string;
    readonly parentGroupPath: string | null;
  };
  readonly projects: readonly GitLabGroupProject[];
}> {
  const result = await discoverGitLabSourceProjects(
    {
      sourceUrl: input.sourceUrl,
      workspaceId: input.workspaceId,
      defaultBaseUrl: process.env.GITLAB_OAUTH_BASE_URL,
    },
    {
      installation: gitLabInstallationGateway(input.token),
    },
  );

  return {
    source: {
      ...result.source,
      parentGroupPath: result.parentGroupPath,
    },
    projects: result.projects,
  };
}

export async function installGitLabConnectProjects(input: {
  readonly sourceUrl: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly selectedProjectIds: readonly string[];
  readonly installedByUserId: string;
}): Promise<{
  readonly installationId: string;
  readonly source: GitLabConnectDiscovery["source"];
  readonly namespacePath: string;
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly setupMergeRequests: readonly {
    readonly projectId: string;
    readonly mergeRequestUrl: string;
  }[];
  readonly results: readonly unknown[];
}> {
  const discovery = await discoverGitLabConnectProjects(input);
  const selectedProjects = selectProjects({
    projects: discovery.projects,
    selectedProjectIds: input.selectedProjectIds,
  });
  const namespacePath =
    discovery.source.resolvedKind === "project"
      ? (discovery.source.parentGroupPath ?? discovery.source.inputPath)
      : discovery.source.inputPath;
  const gateway = gitLabInstallationGateway(input.token);
  const apiBaseUrl = resolveWorkflowPublicApiUrl();
  const audience =
    process.env.REVIEW_ROUTER_GITLAB_OIDC_AUDIENCE ?? "reviewrouter";

  const provision = await provisionWithGroupFallback({
    gateway,
    namespacePath,
    sourceKind: discovery.source.resolvedKind,
    projectIds: selectedProjects.map((project) => project.projectId),
    apiBaseUrl,
    audience,
    reviewToken: readGitLabReviewToken(),
  });

  const prisma = getPrisma();
  const selectedProjectIdSet = selectedProjects.map(
    (project) => project.projectId,
  );
  const installation = await prisma.gitLabInstallation.upsert({
    where: {
      workspaceId_sourceBaseUrl_namespacePath: {
        workspaceId: input.workspaceId,
        sourceBaseUrl: discovery.source.baseUrl,
        namespacePath,
      },
    },
    update: {
      sourceBaseUrl: discovery.source.baseUrl,
      sourceKind: provision.variableTargetKind,
      status: provision.succeeded > 0 ? "active" : "permission_error",
      installedByUserId: input.installedByUserId,
      selectedProjects: selectedProjects.length,
      installSummary: sanitizeInstallSummary(provision),
      lastInstalledAt: new Date(),
    },
    create: {
      workspaceId: input.workspaceId,
      sourceBaseUrl: discovery.source.baseUrl,
      namespacePath,
      sourceKind: provision.variableTargetKind,
      status: provision.succeeded > 0 ? "active" : "permission_error",
      installedByUserId: input.installedByUserId,
      selectedProjects: selectedProjects.length,
      installSummary: sanitizeInstallSummary(provision),
      lastInstalledAt: new Date(),
    },
  });

  await prisma.repositoryConnection.updateMany({
    where: {
      provider: "gitlab",
      gitlabInstallationId: installation.id,
      externalRepositoryId: { notIn: selectedProjectIdSet },
    },
    data: {
      selected: false,
      lastSyncedAt: new Date(),
    },
  });

  for (const project of selectedProjects) {
    const result = provision.results.find(
      (item) => item.projectId === project.projectId,
    );
    if (!result || result.status !== "fulfilled") continue;
    await prisma.repositoryConnection.upsert({
      where: {
        provider_externalRepositoryId_sourceBaseUrl: {
          provider: "gitlab",
          externalRepositoryId: project.projectId,
          sourceBaseUrl: discovery.source.baseUrl,
        },
      },
      update: {
        workspaceId: input.workspaceId,
        sourceBaseUrl: discovery.source.baseUrl,
        gitlabInstallationId: installation.id,
        owner: ownerFromFullName(project.fullName),
        name: project.name,
        fullName: project.fullName,
        defaultBranch: project.defaultBranch ?? "main",
        visibility: project.visibility ?? "private",
        archived: project.archived,
        selected: true,
        setupStatus: setupStatusForProvisionResult(result.result),
        lastSyncedAt: new Date(),
      },
      create: {
        workspaceId: input.workspaceId,
        provider: "gitlab",
        sourceBaseUrl: discovery.source.baseUrl,
        externalRepositoryId: project.projectId,
        gitlabInstallationId: installation.id,
        owner: ownerFromFullName(project.fullName),
        name: project.name,
        fullName: project.fullName,
        defaultBranch: project.defaultBranch ?? "main",
        visibility: project.visibility ?? "private",
        archived: project.archived,
        selected: true,
        setupStatus: setupStatusForProvisionResult(result.result),
        lastSyncedAt: new Date(),
      },
    });
  }

  return {
    installationId: installation.id,
    source: discovery.source,
    namespacePath,
    requested: provision.requested,
    succeeded: provision.succeeded,
    failed: provision.failed,
    setupMergeRequests: provision.results.flatMap((result) =>
      result.status === "fulfilled" &&
      result.result.mode === "setup_merge_request"
        ? [
            {
              projectId: result.projectId,
              mergeRequestUrl: result.result.mergeRequestUrl,
            },
          ]
        : [],
    ),
    results: sanitizeInstallSummary(provision).results,
  };
}

function gitLabInstallationGateway(token: string): GitLabInstallationGateway {
  return new GitLabInstallationGateway({
    token: assertToken(token),
    ...(process.env.REVIEW_ROUTER_GITLAB_API_BASE_URL
      ? { apiBaseUrl: process.env.REVIEW_ROUTER_GITLAB_API_BASE_URL }
      : {}),
  });
}

async function provisionWithGroupFallback(input: {
  readonly gateway: GitLabInstallationGateway;
  readonly namespacePath: string;
  readonly sourceKind: "group" | "project";
  readonly projectIds: readonly string[];
  readonly apiBaseUrl: string;
  readonly audience: string;
  readonly reviewToken: string;
}): Promise<
  Awaited<ReturnType<typeof provisionGitLabReviewRouterProjects>> & {
    readonly variableTargetKind: "group" | "project";
  }
> {
  const common = {
    projectIds: input.projectIds,
    controlProjectPath:
      process.env.REVIEW_ROUTER_GITLAB_CONTROL_PROJECT_PATH ??
      "777genius/review-router",
    ...(process.env.REVIEW_ROUTER_GITLAB_CONTROL_PROJECT_CONFIG_PATH
      ? {
          controlProjectConfigPath:
            process.env.REVIEW_ROUTER_GITLAB_CONTROL_PROJECT_CONFIG_PATH,
        }
      : {}),
    ...(process.env.REVIEW_ROUTER_GITLAB_CONTROL_PROJECT_REF
      ? {
          controlProjectRef:
            process.env.REVIEW_ROUTER_GITLAB_CONTROL_PROJECT_REF,
        }
      : {}),
    reviewRouterApiBaseUrl: input.apiBaseUrl,
    idTokenAudience: input.audience,
    reviewToken: input.reviewToken,
  };
  if (input.sourceKind === "group") {
    try {
      const provision = await provisionGitLabReviewRouterProjects(
        {
          ...common,
          variableTarget: { kind: "group", id: input.namespacePath },
        },
        { installation: input.gateway, clock: { now: () => new Date() } },
      );
      return { ...provision, variableTargetKind: "group" };
    } catch (error) {
      if (!isPermissionLikeGitLabError(error)) throw error;
    }
  }

  const provision = await provisionGitLabReviewRouterProjects(
    {
      ...common,
      variableTarget: { kind: "project", id: "0" },
    },
    { installation: input.gateway, clock: { now: () => new Date() } },
  );
  return { ...provision, variableTargetKind: "project" };
}

function selectProjects(input: {
  readonly projects: readonly GitLabGroupProject[];
  readonly selectedProjectIds: readonly string[];
}): readonly GitLabGroupProject[] {
  const selected = new Set(input.selectedProjectIds);
  const projects = input.projects.filter((project) =>
    selected.has(project.projectId),
  );
  if (projects.length === 0) {
    throw new Error("gitlab_connect_projects_required");
  }
  return projects;
}

function setupStatusForProvisionResult(result: {
  readonly mode: "ci_config_path" | "setup_merge_request" | "skipped";
}): "configured" | "setup_pr_open" | "needs_attention" {
  if (result.mode === "ci_config_path") return "configured";
  if (result.mode === "setup_merge_request") return "setup_pr_open";
  return "needs_attention";
}

function sanitizeInstallSummary(
  provision: Awaited<ReturnType<typeof provisionGitLabReviewRouterProjects>>,
) {
  return {
    protocolVersion: provision.protocolVersion,
    requested: provision.requested,
    succeeded: provision.succeeded,
    failed: provision.failed,
    sharedVariablesConfigured: provision.sharedVariablesConfigured,
    results: provision.results,
  };
}

function ownerFromFullName(fullName: string): string {
  const index = fullName.lastIndexOf("/");
  if (index <= 0) return fullName;
  return fullName.slice(0, index);
}

function assertToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("gitlab_connect_token_required");
  return token;
}

function readGitLabReviewToken(): string {
  const token = process.env.REVIEW_ROUTER_GITLAB_API_TOKEN?.trim();
  if (!token) throw new Error("gitlab_review_token_missing");
  return token;
}

function isPermissionLikeGitLabError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "gitlab_api_error_401" ||
      error.message === "gitlab_api_error_403" ||
      error.message === "gitlab_api_error_404")
  );
}
