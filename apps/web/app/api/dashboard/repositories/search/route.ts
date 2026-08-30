import { NextResponse, type NextRequest } from "next/server";
import {
  findReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  listWorkspaceRepositoryHealth,
  PrismaRepositoryHealthRepository,
} from "@reviewrouter/features-repo-health";
import { projectRepositorySetupStatus } from "@reviewrouter/features-workflow-provisioning";
import {
  requireReviewRouterDatabaseRecoveryWitness,
  resolveReviewRouterActionRef,
} from "@reviewrouter/platform-config";
import {
  asDashboardGitHubActor,
  getDashboardSignedInActor,
  getDashboardWorkspaceScope,
} from "../../../../../src/server/dashboard-mutations";
import {
  buildConfiguredProviderSetupByRepositoryId,
  buildEffectiveProviderSetupStateByRepositoryId,
  buildProviderSetupMismatchRepositoryIds,
  repositoryHealthStatusWithProviderSetupReadiness,
} from "../../../../../src/server/dashboard-provider-setup-readiness";
import { deriveDashboardProviderSetupReadiness } from "../../../../../src/server/dashboard-codex-rotating-setup-readiness";
import { listGitHubUserRepositoryAccess } from "../../../../../src/server/github-user-repository-access";
import { getPrisma } from "../../../../../src/server/prisma";
import { PrismaCodexRotatingSetupReadiness } from "../../../../../src/server/prisma-codex-rotating-setup-readiness";
import {
  buildRepositorySearchText,
  repositoryMatchesSearchFilter,
  repositorySearchReadiness,
  repositorySetupProgressStep,
  tokenizeRepositorySearch,
  type RepositorySearchFilter,
  workflowSetupAlreadyCurrent,
} from "../../../../../src/server/repository-search";

export const dynamic = "force-dynamic";

type WorkspaceCandidate = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly installations: readonly { readonly accountLogin: string }[];
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const scope = await getDashboardWorkspaceScope();
  if (scope.kind === "none") {
    return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  }

  const workspaceKey = normalizeKey(
    request.nextUrl.searchParams.get("workspace") ?? "",
  );
  const query = normalizeQuery(request.nextUrl.searchParams.get("q") ?? "");
  const filter = readRepositorySearchFilter(request.nextUrl.searchParams);
  const prisma = getPrisma();
  const signedInActor = await getDashboardSignedInActor();
  const signedInGitHubActor = asDashboardGitHubActor(signedInActor);
  const fullAccessWorkspaceIds =
    scope.kind === "workspace_ids" ? scope.workspaceIds : [];
  const repositoryAccess =
    signedInGitHubActor && scope.kind !== "all"
      ? await listGitHubUserRepositoryAccess({
          prisma,
          actor: signedInGitHubActor,
          excludedWorkspaceIds: fullAccessWorkspaceIds,
        })
      : {
          status: "ready" as const,
          workspaceIds: [],
          repositoryIds: new Set<string>(),
          directConfigRepositoryIds: new Set<string>(),
          checkedAt: null,
        };
  const visibleWorkspaceIds = mergeWorkspaceIds(
    fullAccessWorkspaceIds,
    repositoryAccess.workspaceIds,
  );
  const workspaceWhere =
    scope.kind === "workspace_ids"
      ? { id: { in: visibleWorkspaceIds } }
      : undefined;
  const candidates = await prisma.workspace.findMany({
    ...(workspaceWhere ? { where: workspaceWhere } : {}),
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      slug: true,
      name: true,
      installations: {
        select: { accountLogin: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      },
    },
  });
  const workspace = selectWorkspace(candidates, workspaceKey);
  if (!workspace) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }
  const hasWorkspaceWideAccess =
    scope.kind === "all" ||
    (scope.kind === "workspace_ids" &&
      scope.workspaceIds.includes(workspace.id));

  const repositories = await prisma.repositoryConnection.findMany({
    where: {
      workspaceId: workspace.id,
      ...(hasWorkspaceWideAccess
        ? {}
        : { id: { in: [...repositoryAccess.repositoryIds] } }),
    },
    orderBy: [{ selected: "desc" }, { fullName: "asc" }],
    select: {
      id: true,
      githubRepositoryId: true,
      fullName: true,
      owner: true,
      name: true,
      defaultBranch: true,
      visibility: true,
      setupStatus: true,
      provisioning: {
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { status: true },
      },
      selected: true,
      archived: true,
      stargazersCount: true,
    },
  });
  const [health, cachedProviderSetup] = await Promise.all([
    listWorkspaceRepositoryHealth(
      {
        workspaceId: workspace.id,
        expectedActionRef: resolveReviewRouterActionRef(),
        workflowProbeMaxRepositories: 0,
      },
      { repositories: new PrismaRepositoryHealthRepository(prisma) },
    ),
    prisma.providerSetupState.findMany({
      where: {
        workspaceId: workspace.id,
        repositoryId: {
          in: repositories.map((repository) => repository.id),
        },
      },
      select: {
        repositoryId: true,
        providerKind: true,
        authMode: true,
        state: true,
        updatedAt: true,
      },
    }),
  ]);
  const providerSetup = await deriveDashboardProviderSetupReadiness({
    providerSetup: cachedProviderSetup,
    repositories,
    workspaceId: workspace.id,
    readiness: new PrismaCodexRotatingSetupReadiness(
      prisma,
      requireReviewRouterDatabaseRecoveryWitness(),
    ),
  });
  const repositoryHealthById = new Map(
    health.map((item) => [item.repositoryId, item] as const),
  );
  const providerSetupConfigRepositoryIds = [
    ...new Set(
      providerSetup
        .filter((item) => item.repositoryId)
        .map((item) => item.repositoryId!),
    ),
  ];
  const reviewConfigStore = new PrismaReviewConfigurationRepository(prisma);
  const [reviewConfig, repositoryConfigs] =
    providerSetupConfigRepositoryIds.length > 0
      ? await Promise.all([
          findReviewConfiguration(
            { scope: "workspace", workspaceId: workspace.id },
            { configurations: reviewConfigStore },
          ),
          Promise.all(
            providerSetupConfigRepositoryIds.map(async (repositoryId) => ({
              repositoryId,
              config: await findReviewConfiguration(
                {
                  scope: "repository",
                  workspaceId: workspace.id,
                  repositoryId,
                },
                { configurations: reviewConfigStore },
              ),
            })),
          ),
        ])
      : [null, []];
  const activeConfig = reviewConfig?.config ?? safeDefaultReviewConfiguration;
  const configuredProviderSetupByRepositoryId =
    buildConfiguredProviderSetupByRepositoryId({
      providerSetup,
      repositories,
      repositoryConfigs,
      activeConfig,
    });
  const effectiveProviderSetupStateByRepositoryId =
    buildEffectiveProviderSetupStateByRepositoryId({
      providerSetup,
      repositories,
      repositoryConfigs,
      activeConfig,
    });
  const providerSetupMismatchRepositoryIds =
    buildProviderSetupMismatchRepositoryIds({
      providerSetup,
      repositories,
      repositoryConfigs,
      activeConfig,
    });

  const tokens = tokenizeRepositorySearch(query);
  const repositoryIds = repositories
    .filter((repository) => {
      const setupStatus = projectRepositorySetupStatus({
        workflowProvisioningStatus: repository.provisioning[0]?.status ?? null,
        legacySetupStatus: repository.setupStatus,
      });
      const repositoryHealth = repositoryHealthById.get(repository.id);
      const effectiveHealthStatus =
        repositoryHealthStatusWithProviderSetupReadiness({
          repositoryId: repository.id,
          healthStatus: repositoryHealth?.status,
          effectiveProviderSetupStateByRepositoryId,
          providerSetupMismatchRepositoryIds,
        });
      const workflowCurrent = workflowSetupAlreadyCurrent(
        effectiveHealthStatus,
      );
      const providerSetupConfirmedAt =
        configuredProviderSetupByRepositoryId.get(repository.id)?.updatedAt;
      const providerSetupConfirmed =
        providerSetupConfirmedAt !== undefined &&
        (!repositoryHealth?.latestActionHealthReceivedAt ||
          providerSetupConfirmedAt >=
            repositoryHealth.latestActionHealthReceivedAt);
      const setupProgressStep = repositorySetupProgressStep({
        setupStatus,
        healthStatus: effectiveHealthStatus,
        workflowCurrent,
        providerSetupConfirmed,
      });
      const readiness = repositorySearchReadiness({
        setupProgressStep,
        healthStatus: effectiveHealthStatus,
      });
      if (!repositoryMatchesSearchFilter({ repository, readiness }, filter)) {
        return false;
      }
      if (tokens.length === 0) return true;
      const searchable = buildRepositorySearchText({
        fullName: repository.fullName,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        visibility: repository.visibility,
        stargazersCount: repository.stargazersCount,
        archived: repository.archived,
        selected: repository.selected,
        setupStatus,
        healthStatus: effectiveHealthStatus,
        healthSummary: repositoryHealth?.summary,
      });
      return tokens.every((token) => searchable.includes(token));
    })
    .map((repository) => repository.id);

  return NextResponse.json({
    repositoryIds,
    total: repositories.length,
    query,
    filter,
  });
}

function readRepositorySearchFilter(
  params: URLSearchParams,
): RepositorySearchFilter {
  const setup = params.get("setup");
  if (setup === "needed") return "needs_setup";
  if (setup === "attention") return "needs_attention";
  if (setup === "ready") return "ready";

  const visibility = params.get("visibility");
  if (visibility === "private" || visibility === "public") {
    return visibility;
  }

  return "all";
}

function selectWorkspace(
  candidates: readonly WorkspaceCandidate[],
  workspaceKey: string,
): WorkspaceCandidate | null {
  if (candidates.length === 0) return null;
  if (!workspaceKey) return candidates[0] ?? null;
  return (
    candidates.find((workspace) =>
      workspaceKeys(workspace).includes(workspaceKey),
    ) ?? null
  );
}

function workspaceKeys(workspace: WorkspaceCandidate): string[] {
  return [
    workspace.id,
    workspace.slug,
    workspace.name,
    ...workspace.installations.map((installation) => installation.accountLogin),
  ]
    .filter(Boolean)
    .map(normalizeKey);
}

function mergeWorkspaceIds(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])];
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeQuery(value: string): string {
  return value.trim().slice(0, 120);
}
